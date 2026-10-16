"""Redis persistence for mlx_lm prompt caches (per-layer K/V tensors) and chat totals.

Keys (all three share the same TTL and are deleted together):
  kvcache:{model_id}:{conversation_id}        STRING  safetensors blob from save_prompt_cache
  kvcache:{model_id}:{conversation_id}:meta   HASH    token_ids (JSON), n_tokens, n_bytes,
                                                      model_id, updated_at
  kvcache:{model_id}:{conversation_id}:stats  HASH    running sums of per-turn metrics
                                                      (see TOTAL_INT_FIELDS/TOTAL_FLOAT_FIELDS)

token_ids is the exact token sequence covered by the blob; the engine uses it to compute
the reusable prefix on the next turn. :stats is written on every turn, cache on or off.
"""

import json
import os
import tempfile
import time

import mlx.core as mx
import redis
from mlx_lm.models.cache import load_prompt_cache, save_prompt_cache

from . import config


TOTAL_INT_FIELDS = ("turns", "turns_cached", "prompt_tokens_processed", "prompt_tokens_reused")
TOTAL_FLOAT_FIELDS = ("ttft_ms", "llm_time_ms", "redis_load_ms", "redis_save_ms")


class KVStore:
    def __init__(self, url: str = config.REDIS_URL, ttl: int = config.KV_TTL_SECONDS):
        # Raw bytes in and out: the cache blob is binary safetensors.
        self.r = redis.Redis.from_url(
            url,
            decode_responses=False,
            socket_timeout=config.REDIS_SOCKET_TIMEOUT,
            socket_connect_timeout=5,
        )
        self.ttl = ttl

    @staticmethod
    def key(conversation_id: str) -> str:
        return f"kvcache:{config.MODEL_ID}:{conversation_id}"

    def ping(self) -> bool:
        try:
            return bool(self.r.ping())
        except redis.RedisError:
            return False

    def load(self, conversation_id: str):
        """Return (prompt_cache, token_ids), or (None, []) on a miss."""
        k = self.key(conversation_id)
        pipe = self.r.pipeline()
        pipe.get(k)
        pipe.hget(f"{k}:meta", "token_ids")
        blob, token_ids_raw = pipe.execute()
        if blob is None or token_ids_raw is None:
            return None, []
        # load_prompt_cache/mx.load only accept a path, so round-trip through a temp file.
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "cache.safetensors")
            with open(path, "wb") as f:
                f.write(blob)
            cache = load_prompt_cache(path)
            # mx.load is lazy: without this, the bytes would be read on the model's first
            # forward pass, i.e. after the temp file is gone and inside the time-to-first-token
            # measurement instead of the Redis load time.
            mx.eval([c.state for c in cache])
        return cache, json.loads(token_ids_raw)

    def save(self, conversation_id: str, prompt_cache, token_ids: list[int]) -> int:
        """Write blob + metadata atomically (MULTI) with TTL. Returns the blob size in bytes."""
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "cache.safetensors")
            save_prompt_cache(path, prompt_cache, {"model_id": config.MODEL_ID})
            with open(path, "rb") as f:
                blob = f.read()
        k = self.key(conversation_id)
        pipe = self.r.pipeline()
        pipe.set(k, blob, ex=self.ttl)
        pipe.hset(
            f"{k}:meta",
            mapping={
                "token_ids": json.dumps(token_ids),
                "n_tokens": len(token_ids),
                "n_bytes": len(blob),
                "model_id": config.MODEL_ID,
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            },
        )
        pipe.expire(f"{k}:meta", self.ttl)
        pipe.execute()
        return len(blob)

    def delete(self, conversation_id: str) -> int:
        k = self.key(conversation_id)
        return self.r.delete(k, f"{k}:meta", f"{k}:stats")

    def add_turn(self, conversation_id: str, turn: dict) -> dict:
        """Accumulate one turn into the chat totals and return the updated sums.

        Also refreshes the TTL of the cache keys, so a chat's memory and totals expire
        together even when turns run with the cache off. Callers must keep this outside any
        timed section: it is bookkeeping, not KV cache I/O.
        """
        k = self.key(conversation_id)
        stats = f"{k}:stats"
        pipe = self.r.pipeline()
        for field in TOTAL_INT_FIELDS:
            pipe.hincrby(stats, field, int(turn.get(field) or 0))
        for field in TOTAL_FLOAT_FIELDS:
            pipe.hincrbyfloat(stats, field, float(turn.get(field) or 0.0))
        for key in (stats, k, f"{k}:meta"):
            pipe.expire(key, self.ttl)
        pipe.hgetall(stats)
        raw = pipe.execute()[-1]
        totals = {f.decode(): v.decode() for f, v in raw.items()}
        return {
            **{f: int(totals.get(f, 0)) for f in TOTAL_INT_FIELDS},
            **{f: float(totals.get(f, 0.0)) for f in TOTAL_FLOAT_FIELDS},
        }
