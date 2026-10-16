# Redis KV Cache Chat

A ChatGPT-style chat that shows the effect of a **real KV cache** (the model's K and V
tensors) persisted in **Redis**.

```
frontend/  React + Vite + TypeScript (Redis look and feel), built into frontend/dist
backend/   FastAPI + mlx-lm: serves the API and the frontend on :8000  <-->  Redis (docker) :6379
cloudflared (prod only) exposes :8000 at https://kvcache.mauriciolima.dev
```

Requires macOS on Apple Silicon (MLX), Python 3.12+, Node 20+, Docker and cloudflared.

## Configuration

Everything lives in `.env` (not tracked by git). The first `make` run creates it from
`.env.example`.

| Variable | Purpose |
|---|---|
| `MODEL_ID` | MLX model from Hugging Face (default: Llama 3.1 8B 4-bit; Llama 3.2 3B is left commented out) |
| `REDIS_NAME`, `REDIS_IMAGE`, `REDIS_PORT` | Redis container |
| `BACKEND_PORT` | backend port (API + frontend) |
| `CLOUDFLARE_TUNNEL_TOKEN` | tunnel token, the `eyJ...` string (only for `make prod`) |

Optional backend environment variables: `KV_TTL_SECONDS` (3600), `MAX_TOKENS` (2048, a safety
cap on reply length), `CHAT_TEMPLATE_DATE`, `REDIS_URL`, `REDIS_SOCKET_TIMEOUT` (60 s).

## Usage

```bash
make build    # Python venv + deps, model weights, npm install, cloudflared, Redis image
make dev      # toggle: Redis + backend in the background -> http://localhost:8000
make prod     # toggle: same as dev + Cloudflare Tunnel -> public URL
make status   # what is running, and its URL
make logs     # follow the log (.run/app.log)
make test     # parity check: cache on and off must produce the SAME text
make keys     # kvcache:* keys with TTL and memory usage
```

`make dev` and `make prod` share the same pipeline (`scripts/run.sh`): start Redis, build the
frontend and start the backend, which serves both the UI and the API on the same port. The only
difference is that `prod` also starts `cloudflared`. Running the same command again stops it.
Only one mode runs at a time, since both use `BACKEND_PORT`. Redis follows the app's lifecycle:
a fresh, empty container is created on start and removed, along with its data, on stop.

To work on the frontend with hot reload, keep `make dev` running and use `make frontend`
(Vite on http://localhost:5173, proxying `/api` to the backend).

### Cloudflare Tunnel

The tunnel is managed from the dashboard: the token comes from **Zero Trust > Networks >
Tunnels > (tunnel) > Install connector** (the long `eyJ...` string; the tunnel UUID does not
work). In the same tunnel, under **Public Hostname**, point the domain at
`http://localhost:8000`. The URL is public; use Cloudflare Access to restrict it.

## How the KVCache toggle works

The toggle is per chat. Both modes use a KV cache during generation (each new token only
computes its own position); the difference is what happens between one message and the next:

- **Off (mlx-lm default cache)**: `stream_generate` without `prompt_cache`. The library builds
  a cache for the reply and discards it at the end, so every message re-reads the whole
  history. Redis is not touched.
- **On (cache persisted in Redis)**: `stream_generate` with `prompt_cache`. Load the chat's
  cache from Redis plus the list of token ids it covers, find the longest common prefix with
  the current history, trim the rest with `trim_prompt_cache`, process only the new tokens,
  and write the updated cache back.

The difference shows up in the **time to first word**, the headline number on each reply's
card; generation speed is the same in both modes. To make it visible, start the chat with a
long text (a few thousand tokens).

Redis keys (all three share the same TTL and are deleted together when the chat is deleted):

- `kvcache:{model_id}:{conversation_id}`: safetensors bytes produced by `save_prompt_cache`
- `kvcache:{model_id}:{conversation_id}:meta`: hash with `token_ids`, `n_tokens`, `n_bytes`,
  `model_id`, `updated_at`
- `kvcache:{model_id}:{conversation_id}:stats`: hash with the chat's running totals (replies,
  waits, LLM and Redis times, tokens read and reused), updated on every reply with the cache
  on or off

The cache takes ~112 KB per token on the 3B (28 layers × 8 KV heads × 128 × fp16 × K/V) and
~128 KB per token on the 8B (32 layers). That is why Redis starts with
`--proto-max-bulk-len 4gb` and `--client-query-buffer-limit 4gb` (the defaults of 512 MB per
value and 1 GB per command would overflow at ~4k and ~8k tokens) and with disk persistence
off (`--save ""`), since the container is discarded on stop.

## Metrics per reply

Measured on the backend with `time.perf_counter` (no network). Each card shows only what
differs between the modes, in two groups split by a divider: on the left, metrics both modes
produce; on the right, metrics only the Redis cache produces (shown as "—" when the cache is
off).

- **Headline:** time to first word.
- **LLM:** total reply time | Redis memory load and save, reported separately from LLM time.
- **Token processing:** conversation size, tokens read now, tokens reused from memory | size
  of the memory stored in Redis.
- **+ Chat total:** the chat's running totals up to that reply (read from the `:stats` hash).
  Reading and writing that hash happen outside every measured time.

## Document upload

The **+ Attach** button (or dragging a file onto the message box) accepts `.txt` and `.md`
files up to 80 KB. A file can only be sent as the **first message** of a chat, together with
the typed text; if nothing is typed, it goes with "Read the following document and wait for my
questions.". The chat takes the file name, and the bubble shows only the name and size. For a
demo, documents of ~8 to 12k tokens (25 to 40 KB of text) make the difference clearly visible
without the Redis load/save weighing too much.

## Comparing chats

In the sidebar, **Compare chats** shows a checkbox on every chat that has replies. Pick 2 to 4
and click the button again (**Generate chart**): the analysis opens in a new tab at
`/{language}/analyse?id=<id1>,<id2>,...`.

For the selected metric (time to first word, wait + Redis load, total reply time or tokens
read), the page shows:

- one card per chat with the total over the replies they have in common and the change
  relative to the baseline;
- a line chart with each reply's value;
- a bar chart with each reply's percent change relative to the baseline (below 0% = faster);
- a table with the same values.

The baseline defaults to the chat without KVCache, if there is one, and can be changed. Data
comes from `localStorage`, so the analysis only works in the browser where the chats were
made. Chat colors are the first 4 slots of the reference dark categorical palette, validated
against the app background.

## Languages

The UI is available in Portuguese (`/pt-br`) and US English (`/en-us`). The language comes from
the path; without one, the last choice or the browser language is used. The PT | EN switch in
the top-right corner changes the language and the path without a reload. UI strings live in
`frontend/src/i18n.ts`.

Each chat keeps the language it was created in, and the backend uses that language's system
prompt (`SYSTEM_PROMPTS` in `backend/app/config.py`). Switching the language mid-chat changes
only the UI: the system prompt cannot change between turns, otherwise the KV cache prefix
would no longer match.
