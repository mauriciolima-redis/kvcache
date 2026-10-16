import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Metrics } from './api'
import { detectLang, fill, formatters, MESSAGES } from './i18n'
import { readConversations } from './storage'

// Reads chats from localStorage, so it only works in the browser that holds them.
// URL: /{lang}/analyse?id=a,b,c (also accepts ?id=a&id=b and the "id=a,id=b" shorthand).

type MetricKey = 'ttft' | 'wait' | 'llm' | 'read'
const METRIC_KEYS: MetricKey[] = ['ttft', 'wait', 'llm', 'read']

// Dark-mode categorical slots 1-4 of the dataviz reference palette, validated against the
// app surface #091a23: adjacent CVD ΔE >= 8.4, normal-vision ΔE >= 19.8, contrast >= 3:1.
// Colors follow the chat (selection order) and never change with the metric or baseline.
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500']
const STATUS_GOOD = '#0ca30c'
const STATUS_BAD = '#d03b3b'

interface Series {
  id: string
  title: string
  color: string
  replies: number
  cached: number
  // One value per reply, in order; null when the metric is missing on that reply.
  values: (number | null)[]
}

function parseIds(search: string): string[] {
  const ids = new URLSearchParams(search)
    .getAll('id')
    .flatMap((v) => v.split(','))
    .map((v) => v.replace(/^id=/, '').trim())
    .filter(Boolean)
  return [...new Set(ids)]
}

function metricValue(m: Metrics, key: MetricKey): number | null {
  switch (key) {
    case 'ttft':
      return m.ttft_ms
    case 'wait':
      return m.ttft_ms == null ? null : m.ttft_ms + (m.kv_cache ? m.redis_load_ms : 0)
    case 'llm':
      return m.llm_time_ms
    case 'read':
      return m.prompt_tokens_processed
  }
}

/** Lower is better for every metric here, so a negative change is an improvement. */
const pctChange = (value: number | null, base: number | null) =>
  value == null || base == null || base <= 0 ? null : ((value - base) / base) * 100

function niceStep(raw: number) {
  const exp = 10 ** Math.floor(Math.log10(raw))
  const f = raw / exp
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp
}

function niceTicks(max: number, count = 4) {
  const step = niceStep((max || 1) / count)
  const top = Math.ceil((max || 1) / step) * step
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** Bar with a 4px rounded data-end and a square end on the baseline. */
function barPath(x: number, w: number, yBase: number, yEnd: number) {
  const r = Math.min(4, w / 2, Math.abs(yEnd - yBase))
  if (yEnd < yBase) {
    return `M${x},${yBase} V${yEnd + r} Q${x},${yEnd} ${x + r},${yEnd} H${x + w - r} Q${x + w},${yEnd} ${x + w},${yEnd + r} V${yBase} Z`
  }
  return `M${x},${yBase} V${yEnd - r} Q${x},${yEnd} ${x + r},${yEnd} H${x + w - r} Q${x + w},${yEnd} ${x + w},${yEnd - r} V${yBase} Z`
}

function Delta({ pct, t }: { pct: number | null; t: (typeof MESSAGES)['pt-BR']['analysis'] }) {
  if (pct == null) return <span className="an-muted">{t.noValue}</span>
  const rounded = Math.round(pct)
  if (rounded === 0) return <span className="an-muted">= {t.same}</span>
  const better = rounded < 0
  return (
    <span className="an-delta" style={{ color: better ? STATUS_GOOD : STATUS_BAD }}>
      <span aria-hidden>{better ? '▼' : '▲'}</span> {Math.abs(rounded)}% {better ? t.better : t.worse}
    </span>
  )
}

interface ChartProps {
  series: Series[]
  replies: number
  format: (v: number) => string
  replyLabel: string
}

function LineChart({ series, replies, format, replyLabel }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const height = 300
  const m = { top: 16, right: 140, bottom: 40, left: 64 }
  const plotW = Math.max(0, width - m.left - m.right)
  const plotH = height - m.top - m.bottom
  const max = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v != null)))
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1]
  const x = (i: number) => m.left + (replies <= 1 ? plotW / 2 : (i / (replies - 1)) * plotW)
  const y = (v: number) => m.top + plotH - (v / top) * plotH

  const paths = series.map((s) => {
    let d = ''
    let pen = false
    s.values.forEach((v, i) => {
      if (v == null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`
      pen = true
    })
    return d
  })

  // Direct end labels; a label that would collide with one already placed is dropped and the
  // legend carries that series instead of nudging labels away from their lines.
  const endLabels = series
    .map((s) => {
      const i = s.values.reduce<number>((last, v, idx) => (v != null ? idx : last), -1)
      return i < 0 ? null : { s, i, yy: y(s.values[i]!) }
    })
    .filter((l): l is { s: Series; i: number; yy: number } => l != null)
    .sort((a, b) => a.yy - b.yy)
    .filter((l, idx, arr) => idx === 0 || Math.abs(l.yy - arr[idx - 1].yy) >= 16)

  const xTicks = Array.from({ length: replies }, (_, i) => i).filter(
    (i) => replies <= 12 || i % Math.ceil(replies / 12) === 0 || i === replies - 1,
  )

  function onPointer(clientX: number, rect: DOMRect) {
    const px = clientX - rect.left - m.left
    const i = replies <= 1 ? 0 : Math.round((px / plotW) * (replies - 1))
    setHover(Math.max(0, Math.min(replies - 1, i)))
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(replies - 1, (h ?? -1) + 1))
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? replies) - 1))
    if (e.key === 'Escape') setHover(null)
  }

  const tipLeft = hover == null ? 0 : x(hover)
  return (
    <div className="an-chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          tabIndex={0}
          role="img"
          onKeyDown={onKey}
          onFocus={() => setHover((h) => h ?? 0)}
          onBlur={() => setHover(null)}
        >
          {ticks.map((tk) => (
            <g key={tk}>
              <line className="an-grid" x1={m.left} x2={m.left + plotW} y1={y(tk)} y2={y(tk)} />
              <text className="an-tick" x={m.left - 10} y={y(tk)} textAnchor="end" dominantBaseline="middle">
                {format(tk)}
              </text>
            </g>
          ))}
          <line className="an-axis" x1={m.left} x2={m.left + plotW} y1={y(0)} y2={y(0)} />
          {xTicks.map((i) => (
            <text key={i} className="an-tick" x={x(i)} y={m.top + plotH + 20} textAnchor="middle">
              {i + 1}
            </text>
          ))}
          <text className="an-tick" x={m.left + plotW / 2} y={height - 4} textAnchor="middle">
            {replyLabel}
          </text>
          {hover != null && (
            <line className="an-crosshair" x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + plotH} />
          )}
          {series.map((s, si) => (
            <g key={s.id}>
              <path d={paths[si]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) =>
                v == null ? null : (
                  <circle
                    key={i}
                    cx={x(i)}
                    cy={y(v)}
                    r={hover === i ? 5 : 4}
                    fill={s.color}
                    stroke="var(--chart-surface)"
                    strokeWidth={2}
                  />
                ),
              )}
            </g>
          ))}
          {endLabels.map(({ s, i, yy }) => (
            <text key={s.id} className="an-endlabel" x={x(i) + 10} y={yy} dominantBaseline="middle">
              {s.title.length > 18 ? `${s.title.slice(0, 17)}…` : s.title}
            </text>
          ))}
          <rect
            x={m.left - 12}
            y={m.top}
            width={plotW + 24}
            height={plotH}
            fill="transparent"
            onPointerMove={(e) => onPointer(e.clientX, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect())}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hover != null && (
        <div
          className="an-tooltip"
          style={{ left: tipLeft > width - 220 ? tipLeft - 212 : tipLeft + 12, top: m.top }}
        >
          <div className="an-tooltip-title">
            {replyLabel} {hover + 1}
          </div>
          {series.map((s) => (
            <div key={s.id} className="an-tooltip-row">
              <i className="an-linekey" style={{ background: s.color }} />
              <strong>{s.values[hover] == null ? '—' : format(s.values[hover]!)}</strong>
              <span>{s.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface DeltaChartProps {
  base: Series
  others: Series[]
  replies: number
  replyLabel: string
  t: (typeof MESSAGES)['pt-BR']['analysis']
}

function DeltaChart({ base, others, replies, replyLabel, t }: DeltaChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ s: Series; i: number; pct: number } | null>(null)
  const height = 260
  const m = { top: 16, right: 24, bottom: 40, left: 64 }
  const plotW = Math.max(0, width - m.left - m.right)
  const plotH = height - m.top - m.bottom
  const pcts = others.map((s) => s.values.map((v, i) => pctChange(v, base.values[i] ?? null)))
  const maxAbs = Math.max(10, ...pcts.flat().filter((p): p is number => p != null).map(Math.abs))
  const half = niceTicks(maxAbs, 2)
  const lim = half[half.length - 1]
  const ticks = [...half.slice(1).reverse().map((v) => -v), ...half]
  const y = (p: number) => m.top + ((lim - p) / (2 * lim)) * plotH
  const groupW = replies > 0 ? plotW / replies : plotW
  const gap = 2
  const barW = Math.max(2, Math.min(24, (groupW * 0.7 - gap * (others.length - 1)) / Math.max(1, others.length)))
  const clusterW = barW * others.length + gap * (others.length - 1)

  return (
    <div className="an-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img">
          {ticks.map((tk) => (
            <g key={tk}>
              {tk !== 0 && <line className="an-grid" x1={m.left} x2={m.left + plotW} y1={y(tk)} y2={y(tk)} />}
              <text className="an-tick" x={m.left - 10} y={y(tk)} textAnchor="end" dominantBaseline="middle">
                {tk > 0 ? '+' : ''}
                {Math.round(tk)}%
              </text>
            </g>
          ))}
          {Array.from({ length: replies }, (_, i) => (
            <text key={i} className="an-tick" x={m.left + groupW * (i + 0.5)} y={m.top + plotH + 20} textAnchor="middle">
              {i + 1}
            </text>
          ))}
          <text className="an-tick" x={m.left + plotW / 2} y={height - 4} textAnchor="middle">
            {replyLabel}
          </text>
          {others.map((s, si) =>
            pcts[si].map((p, i) => {
              if (p == null) return null
              const bx = m.left + groupW * (i + 0.5) - clusterW / 2 + si * (barW + gap)
              const active = hover?.s.id === s.id && hover.i === i
              return (
                <g key={`${s.id}-${i}`}>
                  <path d={barPath(bx, barW, y(0), y(p))} fill={s.color} opacity={hover && !active ? 0.55 : 1} />
                  {/* Hit area larger than the bar: the full column height of its slot. */}
                  <rect
                    x={bx - gap / 2}
                    y={m.top}
                    width={barW + gap}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    onPointerEnter={() => setHover({ s, i, pct: p })}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover({ s, i, pct: p })}
                    onBlur={() => setHover(null)}
                  />
                </g>
              )
            }),
          )}
          <line className="an-zero" x1={m.left} x2={m.left + plotW} y1={y(0)} y2={y(0)} />
        </svg>
      )}
      {hover && (
        <div
          className="an-tooltip"
          style={{
            left: Math.min(width - 220, m.left + groupW * (hover.i + 0.5) + 16),
            top: m.top,
          }}
        >
          <div className="an-tooltip-title">
            {replyLabel} {hover.i + 1}
          </div>
          <div className="an-tooltip-row">
            <i className="an-linekey" style={{ background: hover.s.color }} />
            <strong>
              <Delta pct={hover.pct} t={t} />
            </strong>
            <span>{hover.s.title}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Analysis() {
  const lang = detectLang()
  const T = MESSAGES[lang]
  const t = T.analysis
  const f = formatters(lang)
  const ids = useMemo(() => parseIds(window.location.search), [])
  const [metric, setMetric] = useState<MetricKey>('ttft')
  const [baseId, setBaseId] = useState<string | null>(null)

  const conversations = useMemo(() => readConversations(), [])
  const found = ids
    .map((id) => conversations.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c != null)
  const missing = ids.filter((id) => !conversations.some((c) => c.id === id))

  useEffect(() => {
    document.documentElement.lang = lang
    document.title = `${t.title} · Redis KV Cache Chat`
  }, [lang, t.title])

  const series: Series[] = found
    .map((c, i) => {
      const replies = c.messages.filter((msg) => msg.metrics).map((msg) => msg.metrics!)
      return {
        id: c.id,
        title: c.title || T.newChat,
        color: SERIES_COLORS[i % SERIES_COLORS.length],
        replies: replies.length,
        cached: replies.filter((r) => r.kv_cache).length,
        values: replies.map((r) => metricValue(r, metric)),
      }
    })
    .filter((s) => s.replies > 0)
    .slice(0, SERIES_COLORS.length)

  // Default baseline: a chat that never used KVCache, so the deltas read as "what Redis gains".
  const base =
    series.find((s) => s.id === baseId) ?? series.find((s) => s.cached === 0) ?? series[0]
  const others = series.filter((s) => s.id !== base?.id)
  const replies = Math.max(0, ...series.map((s) => s.replies))
  // Totals compare the same number of replies in every chat, otherwise a longer chat
  // would look "slower" just for having more turns.
  const common = Math.min(...series.map((s) => s.replies))
  const totalOf = (s: Series) => s.values.slice(0, common).reduce<number>((a, v) => a + (v ?? 0), 0)
  const format = (v: number) => (metric === 'read' ? f.int(v) : f.ms(v))
  const metricLabel = t.metrics[metric].label

  return (
    <div className="an-page">
      <header className="an-header">
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <span className="an-note">{t.localOnly}</span>
      </header>

      {missing.length > 0 && (
        <p className="an-warning">
          {t.notFound}: {missing.join(', ')}
        </p>
      )}

      {series.length < 2 ? (
        <p className="an-warning">{t.needTwo}</p>
      ) : (
        <>
          <div className="an-filters">
            <div className="an-segmented" role="group" aria-label={t.metric}>
              {METRIC_KEYS.map((k) => (
                <button
                  key={k}
                  className={k === metric ? 'active' : ''}
                  title={t.metrics[k].help}
                  onClick={() => setMetric(k)}
                >
                  {t.metrics[k].label}
                </button>
              ))}
            </div>
            <label className="an-select">
              {t.baseline}
              <select value={base.id} onChange={(e) => setBaseId(e.target.value)}>
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="an-tiles">
            {series.map((s) => (
              <div key={s.id} className="an-tile">
                <div className="an-tile-label">
                  <i className="an-linekey" style={{ background: s.color }} />
                  <span>{s.title}</span>
                </div>
                <div className="an-tile-value">{format(totalOf(s))}</div>
                <div className="an-tile-meta">
                  {s.id === base.id ? (
                    <span className="an-muted">{t.base}</span>
                  ) : (
                    <Delta pct={pctChange(totalOf(s), totalOf(base))} t={t} />
                  )}
                  <span className="an-muted">
                    {fill(T.turnsValue, { n: f.int(s.replies), c: f.int(s.cached) })}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <section className="an-card">
            <h2>{fill(t.linesTitle, { metric: metricLabel })}</h2>
            <div className="an-legend">
              {series.map((s) => (
                <span key={s.id}>
                  <i className="an-linekey" style={{ background: s.color }} />
                  {s.title}
                </span>
              ))}
            </div>
            <LineChart series={series} replies={replies} format={format} replyLabel={t.reply} />
          </section>

          <section className="an-card">
            <h2>{fill(t.deltaTitle, { base: base.title })}</h2>
            <p className="an-sub">{t.deltaSubtitle}</p>
            <div className="an-legend">
              {others.map((s) => (
                <span key={s.id}>
                  <i className="an-swatch" style={{ background: s.color }} />
                  {s.title}
                </span>
              ))}
            </div>
            <DeltaChart base={base} others={others} replies={replies} replyLabel={t.reply} t={t} />
          </section>

          <section className="an-card">
            <h2>
              {t.tableTitle} · {metricLabel}
            </h2>
            <div className="an-table-wrap">
              <table className="an-table">
                <thead>
                  <tr>
                    <th>{t.reply}</th>
                    {series.map((s) => (
                      <th key={s.id} colSpan={s.id === base.id ? 1 : 2}>
                        <i className="an-linekey" style={{ background: s.color }} />
                        {s.title}
                        {s.id === base.id && <span className="an-muted"> ({t.base})</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: replies }, (_, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      {series.map((s) => (
                        <TableCells key={s.id} isBase={s.id === base.id} value={s.values[i] ?? null} base={base.values[i] ?? null} format={format} t={t} />
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>
                      {t.total} (1–{common})
                    </td>
                    {series.map((s) => (
                      <TableCells key={s.id} isBase={s.id === base.id} value={totalOf(s)} base={totalOf(base)} format={format} t={t} />
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function TableCells({
  isBase,
  value,
  base,
  format,
  t,
}: {
  isBase: boolean
  value: number | null
  base: number | null
  format: (v: number) => string
  t: (typeof MESSAGES)['pt-BR']['analysis']
}) {
  return (
    <>
      <td className="num">{value == null ? t.noValue : format(value)}</td>
      {!isBase && (
        <td className="num">
          <Delta pct={pctChange(value, base)} t={t} />
        </td>
      )}
    </>
  )
}
