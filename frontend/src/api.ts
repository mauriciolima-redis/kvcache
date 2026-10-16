export type Role = 'user' | 'assistant'

export interface ChatMessage {
  role: Role
  content: string
}

export interface ChatTotals {
  turns: number
  turns_cached: number
  ttft_ms: number
  llm_time_ms: number
  redis_load_ms: number
  redis_save_ms: number
  prompt_tokens_processed: number
  prompt_tokens_reused: number
}

export interface Metrics {
  kv_cache: boolean
  cache_status: 'off' | 'hit' | 'miss' | 'reset'
  ttft_ms: number | null
  llm_time_ms: number
  prompt_tokens_total: number
  prompt_tokens_processed: number
  prompt_tokens_reused: number
  redis_load_ms: number
  redis_save_ms: number
  cache_n_bytes: number | null
  generation_tokens: number
  finish_reason: string | null
  // Running sums for the whole conversation up to and including this reply.
  // Missing on messages saved before chat totals existed.
  chat_totals?: ChatTotals
}

interface StreamHandlers {
  onToken: (text: string) => void
  onDone: (m: Metrics) => void
  onError: (msg: string) => void
}

/** POST /api/chat and parse the SSE stream by hand (EventSource only supports GET). */
export async function streamChat(
  body: {
    conversation_id: string
    messages: ChatMessage[]
    kv_cache: boolean
    lang: string
  },
  h: StreamHandlers,
  signal?: AbortSignal,
) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    h.onError(`HTTP ${res.status}: ${await res.text()}`)
    return
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let event = 'message'
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      const payload = JSON.parse(data)
      if (event === 'token') h.onToken(payload.text)
      else if (event === 'done') h.onDone(payload.metrics)
      else if (event === 'error') h.onError(payload.message)
    }
  }
}

export async function fetchModelId(): Promise<string | null> {
  try {
    const res = await fetch('/api/health')
    return res.ok ? ((await res.json()).model_id as string) : null
  } catch {
    return null
  }
}

export async function deleteCache(conversationId: string) {
  await fetch(`/api/cache/${encodeURIComponent(conversationId)}`, { method: 'DELETE' })
}
