"""MLX inference engine comparing a per-request KV cache with one persisted in Redis.

Both modes decode incrementally with a KV cache; they differ only in what survives a turn.

kv_cache=False (mlx_lm default)
    stream_generate without prompt_cache: generate_step builds a fresh cache for the call
    and drops it afterwards, so every turn re-prefills the full rendered history.
kv_cache=True (persisted)
    stream_generate with an explicit prompt_cache loaded from Redis. Keep the longest
    common token prefix with the freshly rendered history, trim the rest, prefill only the
    new suffix, then save the updated cache back.

Notes on mlx_lm 0.32.x internals this relies on (re-check on upgrade):
- Without a sampler, generate_step uses argmax, so both modes are greedy and must produce
  identical text (see tests/parity_test.py).
- generate_step evaluates one token ahead: every yielded token, including EOS, has already
  been written to the cache. We don't depend on that; the token list is reconciled against
  cache[0].offset after generation.
- make_prompt_cache(model) without max_kv_size returns plain KVCache (not rotating),
  which is trimmable.
- KVCache preallocates in 256-step chunks and .state returns the whole buffer, including
  slots past offset. compact_cache() slices them off before serialization.

All methods must be called from the same thread (mlx_lm.generate.generation_stream is
thread-local); main.py routes everything through a single-worker executor.
"""

import threading
import time
from typing import Iterator

from mlx_lm import load, stream_generate
from mlx_lm.models.cache import (
    can_trim_prompt_cache,
    make_prompt_cache,
    trim_prompt_cache,
)

from . import config
from .kv_store import KVStore


def common_prefix_len(a: list[int], b: list[int]) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def compact_cache(prompt_cache) -> None:
    """Slice K/V buffers down to offset, dropping preallocated and trimmed slots."""
    for c in prompt_cache:
        keys = getattr(c, "keys", None)
        if keys is not None and keys.shape[2] > c.offset:
            c.keys = c.keys[..., : c.offset, :]
            c.values = c.values[..., : c.offset, :]


class Engine:
    def __init__(self, store: KVStore):
        self.store = store
        self.model = None
        self.tokenizer = None

    def load(self) -> None:
        self.model, self.tokenizer = load(config.MODEL_ID)

    def encode_chat(self, messages: list[dict], lang: str = config.DEFAULT_LANG) -> list[int]:
        full = [{"role": "system", "content": config.SYSTEM_PROMPTS[lang]}] + messages
        ids = self.tokenizer.apply_chat_template(
            full,
            add_generation_prompt=True,
            tokenize=True,
            date_string=config.CHAT_TEMPLATE_DATE,
        )
        # transformers >= 5 may return a BatchEncoding instead of a list.
        if not isinstance(ids, list):
            ids = ids["input_ids"]
        return list(ids)

    def _generate(self, to_process: list[int], prompt_cache, max_tokens: int):
        """Yield (token, text_segment, finish_reason). prompt_cache=None -> mlx_lm default cache."""
        kwargs = {"prompt_cache": prompt_cache} if prompt_cache is not None else {}
        for r in stream_generate(
            self.model, self.tokenizer, to_process, max_tokens=max_tokens, **kwargs
        ):
            yield r.token, r.text, r.finish_reason

    def chat(
        self,
        conversation_id: str,
        messages: list[dict],
        kv_cache: bool,
        max_tokens: int = config.MAX_TOKENS,
        cancel: threading.Event | None = None,
        lang: str = config.DEFAULT_LANG,
    ) -> Iterator[dict]:
        """Generate a reply. Yields {"type": "token", "text"} events, then one {"type": "done", "metrics"}."""
        prompt_ids = self.encode_chat(messages, lang)
        redis_load_ms = redis_save_ms = 0.0
        prompt_cache = None
        reused = 0
        cache_status = "off"

        if kv_cache:
            t = time.perf_counter()
            prompt_cache, cached_ids = self.store.load(conversation_id)
            redis_load_ms = (time.perf_counter() - t) * 1000

            if prompt_cache is None:
                prompt_cache, cached_ids = make_prompt_cache(self.model), []
                cache_status = "miss"
            else:
                cache_status = "hit"

            reused = common_prefix_len(prompt_ids, cached_ids)
            # Keep at least one token to prefill; stream_generate needs it to produce logits.
            reused = min(reused, len(prompt_ids) - 1)
            excess = prompt_cache[0].offset - reused
            if excess > 0:
                # The cache holds last turn's *generated* tokens, which may not match how
                # the chat template re-renders that assistant message; drop the divergent tail.
                if can_trim_prompt_cache(prompt_cache):
                    trim_prompt_cache(prompt_cache, excess)
                else:
                    prompt_cache, reused, cache_status = make_prompt_cache(self.model), 0, "reset"

        to_process = prompt_ids[reused:]
        tokens = self._generate(to_process, prompt_cache, max_tokens)

        gen_ids: list[int] = []
        ttft_ms = None
        finish_reason = None
        t0 = time.perf_counter()
        for token, text, finish in tokens:
            if ttft_ms is None:
                ttft_ms = (time.perf_counter() - t0) * 1000
            gen_ids.append(token)
            finish_reason = finish
            if text:
                yield {"type": "token", "text": text}
            if cancel is not None and cancel.is_set():
                finish_reason = "cancelled"
                break
        llm_ms = (time.perf_counter() - t0) * 1000

        n_bytes = None
        if kv_cache:
            # Make token_ids describe exactly what is in the cache before persisting.
            cached_ids = prompt_ids + gen_ids
            offset = prompt_cache[0].offset
            if offset > len(cached_ids):
                trim_prompt_cache(prompt_cache, offset - len(cached_ids))
            cached_ids = cached_ids[: prompt_cache[0].offset]
            compact_cache(prompt_cache)
            t = time.perf_counter()
            n_bytes = self.store.save(conversation_id, prompt_cache, cached_ids)
            redis_save_ms = (time.perf_counter() - t) * 1000

        metrics = {
            "kv_cache": kv_cache,
            "cache_status": cache_status,
            "ttft_ms": ttft_ms,
            "llm_time_ms": llm_ms,
            "prompt_tokens_total": len(prompt_ids),
            "prompt_tokens_processed": len(to_process),
            "prompt_tokens_reused": reused,
            "redis_load_ms": redis_load_ms,
            "redis_save_ms": redis_save_ms,
            "cache_n_bytes": n_bytes,
            "generation_tokens": len(gen_ids),
            "finish_reason": finish_reason,
        }
        # Bookkeeping after all timers have stopped: its Redis round trip is not KV cache I/O
        # and must not show up in any reported time.
        metrics["chat_totals"] = self.store.add_turn(
            conversation_id, {**metrics, "turns": 1, "turns_cached": int(kv_cache)}
        )
        yield {"type": "done", "metrics": metrics}
