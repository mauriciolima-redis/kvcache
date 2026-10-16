"""HTTP API. POST /api/chat streams Server-Sent Events: `token`, then `done` (metrics) or `error`."""

import asyncio
import json
import threading
from pathlib import Path
from typing import Literal
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config
from .engine import Engine
from .kv_store import KVStore

# All MLX work must run on one thread: mlx_lm's generation_stream is thread-local.
# A single worker also serializes requests, so there is no concurrent generation.
mlx_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")
store = KVStore()
engine = Engine(store)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await asyncio.get_running_loop().run_in_executor(mlx_executor, engine.load)
    yield
    mlx_executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Redis KV Cache Chat", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Message(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str


class ChatRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=128)
    messages: list[Message] = Field(min_length=1)
    kv_cache: bool = True
    lang: Literal["pt-BR", "en-US"] = config.DEFAULT_LANG


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/health")
def health():
    return {
        "model_id": config.MODEL_ID,
        "model_loaded": engine.model is not None,
        "redis": store.ping(),
    }


@app.post("/api/chat")
async def chat(req: ChatRequest):
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    cancel = threading.Event()

    def run():
        try:
            for ev in engine.chat(
                req.conversation_id,
                [m.model_dump() for m in req.messages],
                req.kv_cache,
                config.MAX_TOKENS,
                cancel,
                req.lang,
            ):
                loop.call_soon_threadsafe(queue.put_nowait, ev)
        except Exception as e:  # noqa: BLE001 - surface any failure as an SSE error event
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "error", "message": str(e)})
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    mlx_executor.submit(run)

    async def events():
        try:
            while (ev := await queue.get()) is not None:
                yield sse(ev.pop("type"), ev)
        finally:
            cancel.set()  # client disconnected or stream finished; stops the generation loop

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/cache/{conversation_id}")
def delete_cache(conversation_id: str):
    return {"deleted": store.delete(conversation_id)}


# Serve the built SPA from the same origin as /api (no CORS, single port for the tunnel).
# Mounted last so it does not shadow the API routes.
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if FRONTEND_DIST.is_dir():
    # Client-side routes (language prefixes and the analysis page) have no file on disk;
    # serve the SPA shell.
    def spa_index():
        return FileResponse(FRONTEND_DIST / "index.html")

    for _path in ("/pt-br", "/en-us", "/analyse", "/pt-br/analyse", "/en-us/analyse"):
        app.add_api_route(_path, spa_index, include_in_schema=False)

    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
