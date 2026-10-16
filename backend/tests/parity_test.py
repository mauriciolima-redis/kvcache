"""Parity check for the two cache modes.

With greedy decoding, the same multi-turn conversation must produce byte-identical
replies with kv_cache on (cache persisted in Redis, only the new suffix prefilled) and off
(mlx_lm default per-request cache, full history prefilled every turn). A mismatch points at
prefix matching, trimming or token reconciliation in Engine.chat.

Run with Redis up and .env exported:  make test
"""

import sys
import uuid

from app.engine import Engine
from app.kv_store import KVStore

ARTICLE = (
    "Redis é um armazenamento de estruturas de dados em memória, usado como banco de dados, "
    "cache, message broker e mecanismo de streaming. Redis oferece estruturas como strings, "
    "hashes, listas, sets, sorted sets com consultas por intervalo, bitmaps, hyperloglogs, "
    "índices geoespaciais e streams. Possui replicação embutida, scripts em Lua, despejo LRU, "
    "transações e diferentes níveis de persistência em disco. "
) * 25

TURNS = [
    f"Leia o texto a seguir e aguarde perguntas.\n\n{ARTICLE}",
    "Cite três estruturas de dados mencionadas.",
    "O Redis tem persistência em disco?",
    "Resuma o texto em uma frase.",
]


def run(engine: Engine, kv_cache: bool) -> tuple[list[str], list[dict]]:
    cid = f"test-{uuid.uuid4().hex[:8]}"
    messages, answers, metrics = [], [], []
    for q in TURNS:
        messages.append({"role": "user", "content": q})
        text, m = "", None
        for ev in engine.chat(cid, messages, kv_cache, max_tokens=120):
            if ev["type"] == "token":
                text += ev["text"]
            else:
                m = ev["metrics"]
        messages.append({"role": "assistant", "content": text})
        answers.append(text)
        metrics.append(m)
    engine.store.delete(cid)  # chat totals exist for both modes
    return answers, metrics


def main() -> int:
    store = KVStore()
    assert store.ping(), "Redis is not reachable"
    engine = Engine(store)
    engine.load()
    # Warm up Metal kernels on both paths so the first measured turn isn't skewed.
    for kv in (False, True):
        list(engine.chat("warmup", [{"role": "user", "content": "oi"}], kv, max_tokens=5))
    store.delete("warmup")

    off, m_off = run(engine, False)
    on, m_on = run(engine, True)

    ok = True
    for i, (a, b) in enumerate(zip(off, on)):
        same = a == b
        ok &= same
        print(
            f"turn {i}: {'SAME' if same else 'DIFFERENT'} | "
            f"OFF total={m_off[i]['llm_time_ms']:.0f}ms ttft={m_off[i]['ttft_ms']:.0f}ms "
            f"read={m_off[i]['prompt_tokens_processed']} | "
            f"ON total={m_on[i]['llm_time_ms']:.0f}ms ttft={m_on[i]['ttft_ms']:.0f}ms "
            f"read={m_on[i]['prompt_tokens_processed']} "
            f"reused={m_on[i]['prompt_tokens_reused']} bytes={m_on[i]['cache_n_bytes']}"
        )
        if not same:
            print("  OFF:", repr(a[:200]))
            print("  ON :", repr(b[:200]))
    print("PARITY OK" if ok else "PARITY FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
