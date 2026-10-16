"""Runtime settings. MODEL_ID and REDIS_PORT come from the repo .env (exported by the
Makefile); the rest are optional overrides."""

import os


def _required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is not set; run through make or export it from .env")
    return value


MODEL_ID = _required("MODEL_ID")
REDIS_URL = os.getenv("REDIS_URL", f"redis://localhost:{_required('REDIS_PORT')}/0")
KV_TTL_SECONDS = int(os.getenv("KV_TTL_SECONDS", "3600"))
# redis-py defaults to a 5 s socket timeout, which a multi-GB SET through Docker Desktop's
# port forwarding can exceed.
REDIS_SOCKET_TIMEOUT = float(os.getenv("REDIS_SOCKET_TIMEOUT", "60"))
# Safety cap on reply length, not a UI setting: replies normally end at EOS, this only stops
# a degenerate repetition loop from holding the single MLX worker indefinitely.
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "2048"))
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")

# One system prompt per UI language; the frontend pins a conversation's language at
# creation. Each prompt must stay byte-identical across turns: any change diverges the
# token prefix inside the system header, so nearly nothing can be reused from the cache.
DEFAULT_LANG = "pt-BR"
SYSTEM_PROMPTS = {
    "pt-BR": "Você é um assistente prestativo. Responda sempre em português, de forma clara e objetiva.",
    "en-US": "You are a helpful assistant. Always answer in English, clearly and concisely.",
}

# Llama 3.x chat templates render "Today Date: {date_string}" into the system header
# and fall back to strftime_now() (3.2) or a constant (3.1) when unset; 3.2 would change
# the prefix at midnight.
CHAT_TEMPLATE_DATE = os.getenv("CHAT_TEMPLATE_DATE", "01 Jan 2026")
