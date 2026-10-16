SHELL := /bin/bash

PYTHON ?= python3
VENV   := backend/.venv

# Runtime settings live in .env (bootstrapped from .env.example on first run) and are
# exported so scripts/run.sh and the backend see the same values.
ifeq ($(wildcard .env),)
$(shell cp .env.example .env)
endif
include .env
export MODEL_ID REDIS_NAME REDIS_IMAGE REDIS_PORT BACKEND_PORT CLOUDFLARE_TUNNEL_TOKEN

.PHONY: build dev prod status logs redis frontend test keys clean

## Install everything: Python venv + deps, model weights, frontend deps, cloudflared, Redis image.
build:
	@[ "$$(uname -sm)" = "Darwin arm64" ] || { echo "MLX requires macOS on Apple Silicon"; exit 1; }
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r backend/requirements.txt
	$(VENV)/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('$(MODEL_ID)')"
	cd frontend && npm install
	command -v cloudflared >/dev/null || brew install cloudflared
	docker pull $(REDIS_IMAGE)

## Toggle the app in the background. Start creates a fresh Redis container and the backend
## (serving the built frontend); stop tears both down, Redis data included.
## dev and prod share the same pipeline; prod additionally runs the Cloudflare tunnel.
dev:
	@scripts/run.sh dev

prod:
	@scripts/run.sh prod

status:
	@scripts/run.sh status

logs:
	@scripts/run.sh logs

## Standalone Redis for `make test` when dev/prod is not running. dev/prod manage their own.
redis:
	@if docker ps --format '{{.Names}}' | grep -qx $(REDIS_NAME); then \
		echo "Redis already running"; \
	elif docker ps -a --format '{{.Names}}' | grep -qx $(REDIS_NAME); then \
		docker start $(REDIS_NAME); \
	else \
		docker run -d --name $(REDIS_NAME) -p $(REDIS_PORT):6379 $(REDIS_IMAGE) \
			redis-server --proto-max-bulk-len 4gb --client-query-buffer-limit 4gb \
			--save "" --appendonly no; \
	fi
# Same flags as scripts/run.sh (see the comment there).

## Optional: Vite dev server with HMR on :5173, proxying /api to the running backend.
frontend:
	cd frontend && BACKEND_URL=http://127.0.0.1:$(BACKEND_PORT) npm run dev

## Greedy-decoding parity check: KV cache on vs off must produce identical text.
test: redis
	cd backend && .venv/bin/python -m tests.parity_test

## List kvcache:* keys with type, TTL and memory usage.
keys:
	@docker exec $(REDIS_NAME) sh -c 'for k in $$(redis-cli --scan --pattern "kvcache:*"); do \
		echo "$$k  type=$$(redis-cli type $$k)  ttl=$$(redis-cli ttl $$k)s  mem=$$(redis-cli memory usage $$k)B"; done'

clean:
	rm -rf $(VENV) frontend/node_modules frontend/dist .run
	-docker rm -f $(REDIS_NAME)
