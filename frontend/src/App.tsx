import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { deleteCache, fetchModelId, streamChat, type Metrics } from './api'
import { applyLang, detectLang, fill, formatters, LANGS, MESSAGES, type Lang, type Messages } from './i18n'
import { STORAGE_KEY, type Conversation, type UiMessage } from './storage'

interface Attachment {
  name: string
  text: string
}
// ~25k tokens on Llama 3.x (~3.3 chars/token), i.e. ~3 GB of KV cache on the 8B, which keeps
// the Redis blob under the 4 GB proto-max-bulk-len set in scripts/run.sh.
const MAX_FILE_BYTES = 80 * 1024
const ACCEPTED_FILE = /\.(txt|md|markdown)$/i
// The analysis chart palette validates for up to 4 adjacent series (see Analysis.tsx).
const MIN_COMPARE = 2
const MAX_COMPARE = 4

const newConversation = (lang: Lang): Conversation => ({
  id: crypto.randomUUID(),
  title: '',
  lang,
  kvCache: true,
  messages: [],
})

function loadConversations(lang: Lang): Conversation[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Conversation[]
    if (saved.length) return saved
  } catch {
    /* corrupted storage: start fresh */
  }
  return [newConversation(lang)]
}

function RedisLogo() {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--redis-red)" />
      <path d="M9 11l7-3.5 7 3.5-7 3.5z" fill="#fff" />
      <path d="M9 16l7 3.5 7-3.5" stroke="#fff" strokeWidth="2" fill="none" strokeLinejoin="round" />
      <path d="M9 20.5l7 3.5 7-3.5" stroke="#fff" strokeWidth="2" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

interface Stat {
  label: string
  value: string
  help: string
  dot?: 'reused' | 'read'
  muted?: boolean
}

function StatList({ stats }: { stats: Stat[] }) {
  return (
    <dl className="metrics-grid">
      {stats.map((s) => (
        <div key={s.label}>
          <dt>
            {s.dot && <i className={`dot dot-${s.dot}`} />}
            {s.label}
          </dt>
          <dd className={`has-help ${s.muted ? 'muted' : ''}`} title={s.help}>
            {s.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** One group, split by a divider: metrics both modes produce | metrics only the Redis cache produces. */
function StatGroup({ title, both, cacheOnly }: { title: string; both: Stat[]; cacheOnly: Stat[] }) {
  return (
    <section className="metrics-group">
      <h4>{title}</h4>
      <div className="metrics-split">
        <StatList stats={both} />
        <StatList stats={cacheOnly} />
      </div>
    </section>
  )
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

function MetricsPanel({ m, t, lang }: { m: Metrics; t: Messages; lang: Lang }) {
  const [showTotals, setShowTotals] = useState(false)
  const f = formatters(lang)
  const reusedPct = pct(m.prompt_tokens_reused, m.prompt_tokens_total)
  const status = t.status[m.cache_status] ?? t.status.off
  const L = t.labels
  const H = t.help
  // Cache-only metrics stay visible with KVCache off, as a dash, so both cards line up.
  const onlyCache = (label: string, value: string, help: string): Stat =>
    m.kv_cache ? { label, value, help } : { label, value: '—', help: t.cacheOnly, muted: true }

  const c = m.chat_totals

  return (
    <div className="metrics">
      <div className="metrics-head">
        <span className={`badge ${m.kv_cache ? 'badge-on' : 'badge-off'}`}>
          {m.kv_cache ? t.cacheOn : t.cacheOff}
        </span>
        <span className="badge badge-status has-help" title={status.help}>
          {status.tag}
        </span>
        <span className="total">
          <span className="total-label">{t.firstToken}</span>
          <span className="total-value has-help" title={H.ttft}>
            {f.ms(m.ttft_ms)}
          </span>
        </span>
      </div>

      <div className="reuse-bar" title={H.reused}>
        <span className="seg-reused" style={{ width: `${reusedPct}%` }} />
        <span className="seg-read" style={{ width: `${100 - reusedPct}%` }} />
      </div>

      <div className="metrics-cols-head">
        <span>{t.colBoth}</span>
        <span>{t.colCache}</span>
      </div>

      <StatGroup
        title={t.groupLlm}
        both={[{ label: L.llmTime, value: f.ms(m.llm_time_ms), help: H.llmTime }]}
        cacheOnly={[
          onlyCache(L.redisLoad, f.ms(m.redis_load_ms), H.redisLoad),
          onlyCache(L.redisSave, f.ms(m.redis_save_ms), H.redisSave),
        ]}
      />
      <StatGroup
        title={t.groupTokens}
        both={[
          { label: L.promptTotal, value: f.int(m.prompt_tokens_total), help: H.promptTotal },
          { label: L.read, value: f.int(m.prompt_tokens_processed), help: H.read, dot: 'read' },
          {
            label: L.reused,
            value: `${f.int(m.prompt_tokens_reused)} (${reusedPct}%)`,
            help: H.reused,
            dot: 'reused',
          },
        ]}
        cacheOnly={[onlyCache(L.cacheBytes, f.bytes(m.cache_n_bytes), H.cacheBytes)]}
      />

      {c && (
        <>
          <button className="btn-details" onClick={() => setShowTotals((o) => !o)} aria-expanded={showTotals}>
            {showTotals ? t.hideTotals : t.showTotals}
          </button>
          {showTotals && (
            <div className="metrics-totals">
              <StatGroup
                title={`${t.groupTotals} · ${t.groupLlm}`}
                both={[
                  {
                    label: L.turns,
                    value: fill(t.turnsValue, { n: f.int(c.turns), c: f.int(c.turns_cached) }),
                    help: H.turns,
                  },
                  { label: L.ttftSum, value: f.ms(c.ttft_ms), help: H.ttftSum },
                  { label: L.llmTimeSum, value: f.ms(c.llm_time_ms), help: H.llmTimeSum },
                ]}
                cacheOnly={[
                  { label: L.redisLoadSum, value: f.ms(c.redis_load_ms), help: H.redisLoadSum },
                  { label: L.redisSaveSum, value: f.ms(c.redis_save_ms), help: H.redisSaveSum },
                ]}
              />
              <StatGroup
                title={`${t.groupTotals} · ${t.groupTokens}`}
                both={[
                  { label: L.readSum, value: f.int(c.prompt_tokens_processed), help: H.readSum, dot: 'read' },
                  {
                    label: L.reusedSum,
                    value: `${f.int(c.prompt_tokens_reused)} (${pct(
                      c.prompt_tokens_reused,
                      c.prompt_tokens_reused + c.prompt_tokens_processed,
                    )}%)`,
                    help: H.reusedSum,
                    dot: 'reused',
                  },
                ]}
                cacheOnly={[onlyCache(L.cacheBytesNow, f.bytes(m.cache_n_bytes), H.cacheBytesNow)]}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function LangSwitch({ lang, onChange, label }: { lang: Lang; onChange: (l: Lang) => void; label: string }) {
  return (
    <div className="lang-switch" role="group" aria-label={label}>
      {LANGS.map((l) => (
        <a
          key={l.lang}
          href={`/${l.slug}`}
          className={l.lang === lang ? 'active' : ''}
          aria-current={l.lang === lang ? 'true' : undefined}
          onClick={(e) => {
            e.preventDefault()
            onChange(l.lang)
          }}
        >
          {l.short}
        </a>
      ))}
    </div>
  )
}

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang)
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations(lang))
  const [activeId, setActiveId] = useState(() => conversations[0].id)
  const [input, setInput] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [editTitle, setEditTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [modelId, setModelId] = useState<string | null>(null)
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const t = MESSAGES[lang]
  const f = formatters(lang)
  const active = conversations.find((c) => c.id === activeId) ?? conversations[0]
  const canAttach = active.messages.length === 0 && !busy
  const kvCache = active.kvCache ?? true

  // A pending file only makes sense for the conversation it was picked in.
  useEffect(() => {
    setAttachment(null)
    setFileError(null)
  }, [activeId])

  // Normalize the URL on first load (e.g. "/" -> "/pt-br") and follow back/forward.
  useEffect(() => {
    applyLang(lang, 'replace')
    const onPop = () => setLang(detectLang())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    fetchModelId().then(setModelId)
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
  }, [conversations])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [active.messages])

  function changeLang(next: Lang) {
    applyLang(next)
    setLang(next)
  }

  const updateActive = (fn: (c: Conversation) => Conversation) =>
    setConversations((cs) => cs.map((c) => (c.id === active.id ? fn(c) : c)))

  const patchLastAssistant = (patch: (m: UiMessage) => UiMessage) =>
    updateActive((c) => {
      const msgs = [...c.messages]
      msgs[msgs.length - 1] = patch(msgs[msgs.length - 1])
      return { ...c, messages: msgs }
    })

  async function pickFile(file: File | undefined) {
    if (!file || !canAttach) return
    setFileError(null)
    if (!ACCEPTED_FILE.test(file.name)) return setFileError(t.fileType)
    if (file.size > MAX_FILE_BYTES)
      return setFileError(fill(t.fileTooLarge, { size: f.bytes(file.size), max: f.bytes(MAX_FILE_BYTES) }))
    const text = (await file.text()).trim()
    if (!text) return setFileError(t.fileEmpty)
    setAttachment({ name: file.name, text })
  }

  async function send() {
    const typed = input.trim()
    const file = active.messages.length === 0 ? attachment : null
    if ((!typed && !file) || busy) return
    setInput('')
    setAttachment(null)
    setFileError(null)
    setBusy(true)

    // An empty conversation adopts the current UI language; after the first message it is locked.
    const convLang = active.messages.length ? (active.lang ?? 'pt-BR') : lang
    // The default prompt goes to the model, so it follows the conversation language.
    const prompt = typed || (file ? MESSAGES[convLang].filePrompt : '')
    const userMsg: UiMessage = file
      ? {
          role: 'user',
          content: `${prompt}\n\n--- ${file.name} ---\n${file.text}`,
          file: { name: file.name, chars: file.text.length },
          prompt,
        }
      : { role: 'user', content: typed }
    // Failed replies are kept in the UI but excluded from the history sent to the model.
    const history = [...active.messages.filter((m) => !m.error), userMsg]
    updateActive((c) => ({
      ...c,
      lang: convLang,
      title: c.messages.length ? c.title : (file?.name ?? typed).slice(0, 40),
      messages: [...c.messages, userMsg, { role: 'assistant', content: '' }],
    }))

    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await streamChat(
        {
          conversation_id: active.id,
          messages: history.map(({ role, content }) => ({ role, content })),
          kv_cache: kvCache,
          lang: convLang,
        },
        {
          onToken: (tok) => patchLastAssistant((m) => ({ ...m, content: m.content + tok })),
          onDone: (metrics) => patchLastAssistant((m) => ({ ...m, metrics })),
          onError: (error) => patchLastAssistant((m) => ({ ...m, error })),
        },
        ctrl.signal,
      )
    } catch (e) {
      if (!ctrl.signal.aborted) patchLastAssistant((m) => ({ ...m, error: String(e) }))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  function newChat() {
    const c = newConversation(lang)
    setConversations((cs) => [c, ...cs])
    setActiveId(c.id)
  }

  const hasReplies = (c: Conversation) => c.messages.some((m) => m.metrics)

  // First click enters selection mode; second click opens the analysis in a new tab.
  function onCompareClick() {
    if (!comparing) {
      setComparing(true)
      setSelected([])
      return
    }
    if (selected.length < MIN_COMPARE) return
    const slug = LANGS.find((l) => l.lang === lang)!.slug
    window.open(`/${slug}/analyse?id=${selected.map(encodeURIComponent).join(',')}`, '_blank', 'noopener')
    setComparing(false)
    setSelected([])
  }

  function toggleSelected(id: string) {
    setSelected((sel) =>
      sel.includes(id) ? sel.filter((x) => x !== id) : sel.length < MAX_COMPARE ? [...sel, id] : sel,
    )
  }

  function startRename(c: Conversation) {
    setEditingId(c.id)
    setEditTitle(c.title || t.newChat)
  }

  // Titles are UI-only (localStorage); an empty name keeps the previous one.
  function saveRename(id: string) {
    const title = editTitle.trim()
    if (title) setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)))
    setEditingId(null)
  }

  function removeChat(id: string) {
    deleteCache(id)
    setConversations((cs) => {
      const rest = cs.filter((c) => c.id !== id)
      const next = rest.length ? rest : [newConversation(lang)]
      if (id === activeId) setActiveId(next[0].id)
      return next
    })
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <RedisLogo />
          <span className="brand-name">redis</span>
          <span className="brand-tag">KV Cache Chat</span>
        </div>
        <button className="btn-new" onClick={newChat} disabled={busy}>
          + {t.newChat}
        </button>
        <div className="compare-bar">
          <button
            className={`btn-compare ${comparing ? 'active' : ''}`}
            onClick={onCompareClick}
            disabled={comparing && selected.length < MIN_COMPARE}
          >
            {comparing ? fill(t.compareGenerate, { n: String(selected.length) }) : t.compare}
          </button>
          {comparing && (
            <button className="btn-compare-cancel" onClick={() => setComparing(false)}>
              {t.compareCancel}
            </button>
          )}
        </div>
        {comparing && <p className="compare-hint">{t.compareHint}</p>}
        <nav className="conv-list">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`conv-item ${c.id === active.id ? 'active' : ''}`}
              onClick={() => !busy && setActiveId(c.id)}
            >
              {comparing && (
                <input
                  type="checkbox"
                  className="conv-check"
                  checked={selected.includes(c.id)}
                  disabled={!hasReplies(c) || (!selected.includes(c.id) && selected.length >= MAX_COMPARE)}
                  title={hasReplies(c) ? undefined : t.compareNoData}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelected(c.id)}
                />
              )}
              {editingId === c.id ? (
                <input
                  className="conv-rename"
                  value={editTitle}
                  autoFocus
                  maxLength={80}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => saveRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveRename(c.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <span className="conv-title" onDoubleClick={() => startRename(c)}>
                  {c.title || t.newChat}
                </span>
              )}
              <button
                className="conv-edit"
                title={t.renameChat}
                onClick={(e) => {
                  e.stopPropagation()
                  startRename(c)
                }}
              >
                ✎
              </button>
              <button
                className="conv-del"
                title={t.deleteChat}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!busy) removeChat(c.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          {modelId ? modelId.split('/').pop() : '…'} · MLX
          <br />
          {t.sidebarFoot}
        </div>
      </aside>

      <main className="main">
        <LangSwitch lang={lang} onChange={changeLang} label={t.language} />
        <div className="messages">
          {active.messages.length === 0 && (
            <div className="empty">
              <h1>
                {t.emptyTitleBefore}
                <span className="hl">{t.emptyTitleHighlight}</span>
                {t.emptyTitleAfter}
              </h1>
              <p>
                {t.emptyTipBefore}
                <strong>KVCache</strong>
                {t.emptyTipAfter}
              </p>
            </div>
          )}
          {active.messages.map((m, i) => (
            <div key={`${active.id}-${i}`} className={`msg msg-${m.role}`}>
              {m.role === 'assistant' && (
                <div className="avatar">
                  <RedisLogo />
                </div>
              )}
              <div className="bubble">
                {m.role === 'assistant' ? (
                  m.content ? (
                    <Markdown>{m.content}</Markdown>
                  ) : (
                    !m.error && <span className="typing">{t.thinking}</span>
                  )
                ) : (
                  <>
                    {m.file && (
                      <div className="file-chip">
                        <span className="file-ext">{m.file.name.split('.').pop()}</span>
                        <span className="file-name">{m.file.name}</span>
                        <span className="file-size">
                          {fill(t.fileChars, { n: f.int(m.file.chars) })}
                        </span>
                      </div>
                    )}
                    <p className="user-text">{m.file ? m.prompt : m.content}</p>
                  </>
                )}
                {m.error && (
                  <div className="error">
                    {t.error}: {m.error}
                  </div>
                )}
                {m.metrics && <MetricsPanel m={m.metrics} t={t} lang={lang} />}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div className="composer-wrap">
          <div
            className="composer"
            onDragOver={(e) => canAttach && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              pickFile(e.dataTransfer.files[0])
            }}
          >
            {attachment && (
              <div className="file-chip pending">
                <span className="file-ext">{attachment.name.split('.').pop()}</span>
                <span className="file-name">{attachment.name}</span>
                <span className="file-size">{fill(t.fileChars, { n: f.int(attachment.text.length) })}</span>
                <button className="file-remove" title={t.removeFile} onClick={() => setAttachment(null)}>
                  ×
                </button>
              </div>
            )}
            {fileError && <div className="file-error">{fileError}</div>}
            <textarea
              value={input}
              placeholder={t.placeholder}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="composer-bar">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,text/plain,text/markdown"
                hidden
                onChange={(e) => {
                  pickFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              <button
                className="btn-attach"
                disabled={!canAttach}
                title={canAttach ? fill(t.attachHelp, { max: f.bytes(MAX_FILE_BYTES) }) : t.attachOnlyFirst}
                onClick={() => fileInputRef.current?.click()}
              >
                + {t.attach}
              </button>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={kvCache}
                  disabled={busy}
                  onChange={(e) => {
                    const on = e.target.checked
                    updateActive((c) => ({ ...c, kvCache: on }))
                  }}
                />
                <span className="track">
                  <span className="thumb" />
                </span>
                <span className="toggle-label">KVCache</span>
              </label>
              <span className="spacer" />
              {busy ? (
                <button className="btn-send" onClick={() => abortRef.current?.abort()}>
                  {t.stop}
                </button>
              ) : (
                <button className="btn-send" onClick={send} disabled={!input.trim() && !attachment}>
                  {t.send}
                </button>
              )}
            </div>
          </div>
          <p className="hint">{t.hint}</p>
        </div>
      </main>
    </div>
  )
}
