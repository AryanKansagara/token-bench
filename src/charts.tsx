// Hand-rolled SVG charts.
import { useEffect, useId, useRef, useState } from 'react'
import { histogram, quantile } from './engine/stats.ts'
import type { RequestResult } from './engine/types.ts'
import { fmtMs, fmtTps } from './ui.tsx'

/** Tracks an element's width so SVG viewBoxes match real pixels and text never scales. */
function useWidth(initial = 640) {
  const ref = useRef<HTMLElement>(null)
  const [w, setW] = useState(initial)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => { const n = Math.round(e.contentRect.width); if (n > 0) setW(n) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, Math.max(300, w)] as const
}

/** Semicircle gauge. Value is clamped to [0, max]; `log` spreads values that span orders of magnitude. */
export function Dial({ value, max, label, unit, color = 'var(--accent)', log, size = 150, sub }: { value: number | null; max: number; label: string; unit: string; color?: string; log?: boolean; size?: number; sub?: string }) {
  const id = useId()
  const v = value ?? 0
  const frac = Math.max(0, Math.min(1, log ? Math.log10(1 + v) / Math.log10(1 + max) : v / max))
  const r = 52, cx = 60, cy = 60
  const arc = (f: number) => {
    const a = Math.PI * (1 - f)
    return `${cx + r * Math.cos(a)} ${cy - r * Math.sin(a)}`
  }
  const len = Math.PI * r
  return (
    <figure className="dial" style={{ width: size }} aria-label={`${label}: ${value === null ? 'waiting' : `${unit === 'ms' ? fmtMs(v) : fmtTps(v)} ${unit === 'ms' ? '' : unit}`}`}>
      <svg viewBox="0 0 120 70" aria-hidden="true">
        <defs><linearGradient id={id} x1="0" x2="1"><stop offset="0" stopColor="#ffce5c" /><stop offset="1" stopColor={color} /></linearGradient></defs>
        <path d={`M ${arc(0)} A ${r} ${r} 0 0 1 ${arc(1)}`} className="dial-track" />
        <path d={`M ${arc(0)} A ${r} ${r} 0 0 1 ${arc(1)}`} stroke={`url(#${id})`} className="dial-fill" strokeDasharray={len} strokeDashoffset={len * (1 - frac)} />
        {Array.from({ length: 11 }, (_, i) => { const a = Math.PI * (1 - i / 10); return <line key={i} x1={cx + 44 * Math.cos(a)} y1={cy - 44 * Math.sin(a)} x2={cx + 40 * Math.cos(a)} y2={cy - 40 * Math.sin(a)} className="dial-tick" /> })}
      </svg>
      <figcaption>
        <strong className="mono">{value === null ? '...' : unit === 'ms' ? fmtMs(v) : fmtTps(v)}</strong>
        <span>{label}{unit !== 'ms' && <> · {unit}</>}</span>
        {sub && <em>{sub}</em>}
      </figcaption>
    </figure>
  )
}

export interface DotRow { id: string; label: string; color: string; values: number[]; p50: number | null; ci?: [number, number] }

/** One row per endpoint: every request as a dot, median as a bar, bootstrap CI as a band. */
export function DotPlot({ rows, format, log, title, higherBetter }: { rows: DotRow[]; format: (n: number) => string; log?: boolean; title: string; higherBetter?: boolean }) {
  const [ref, W] = useWidth()
  const all = rows.flatMap(r => r.values)
  if (!all.length) return <p className="muted small">No successful requests.</p>
  const lo = log ? Math.max(1, Math.min(...all) * 0.8) : 0
  const hi = Math.max(...all) * 1.08
  const L = Math.min(175, W * 0.34), R = 44, rowH = 34, H = rows.length * rowH + 28
  const x = (v: number) => L + (log ? (Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : v / hi) * (W - L - R)
  const ticks = log ? niceLogTicks(lo, hi).filter(t => W >= 520 || /^1/.test(String(t))) : niceTicks(hi, W < 520 ? 3 : 5)
  return (
    <figure className="chart" ref={ref}>
      <figcaption className="chart-title">{title} <span className="muted">{higherBetter ? 'higher is better' : 'lower is better'}{log ? ', log scale' : ''}</span></figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${rows.map(r => `${r.label} median ${r.p50 === null ? 'n/a' : format(r.p50)}`).join('; ')}`}>
        {ticks.map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={4} y2={H - 22} className="grid" /><text x={x(t)} y={H - 6} className="axis" textAnchor="middle">{format(t)}</text></g>)}
        {rows.map((r, i) => {
          const y = 18 + i * rowH
          return (
            <g key={r.id}>
              <text x={L - 10} y={y + 4} className="row-label" textAnchor="end">{r.label.length > L / 6.4 ? r.label.slice(0, Math.floor(L / 6.4) - 1) + '…' : r.label}</text>
              {r.ci && <rect x={x(r.ci[0])} y={y - 9} width={Math.max(2, x(r.ci[1]) - x(r.ci[0]))} height={18} rx={3} fill={r.color} opacity={0.18} />}
              {r.values.map((v, j) => <circle key={j} cx={x(v)} cy={y + ((j * 7) % 11) - 5} r={2.6} fill={r.color} opacity={0.55} />)}
              {r.p50 !== null && <><line x1={x(r.p50)} x2={x(r.p50)} y1={y - 12} y2={y + 12} stroke={r.color} strokeWidth={3} /><text x={Math.min(W - R, x(r.p50) + 6)} y={y - 12} className="val" fill="currentColor">{format(r.p50)}</text></>}
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

export function niceTicks(max: number, n = 5): number[] {
  if (!(max > 0)) return [0]
  const step0 = max / n
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) ?? 10 * mag
  const out: number[] = []
  for (let v = 0; v <= max; v += step) out.push(+v.toFixed(6))
  return out
}
function niceLogTicks(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo && v <= hi) out.push(v) }
  return out
}

/** Cumulative output tokens over time for one request per endpoint: the race, as a chart. */
export function RaceChart({ series, title }: { series: { id: string; label: string; color: string; r: RequestResult }[]; title: string }) {
  const [ref, W] = useWidth()
  const s = series.filter(x => x.r.ok && x.r.chunks?.length)
  if (!s.length) return null
  const tMax = Math.max(...s.map(x => x.r.totalMs!)) * 1.04
  const nMax = Math.max(...s.map(x => x.r.outputTokens!)) * 1.08
  const H = 260, L = 46, B = 26, T = 10, R = 16
  const x = (t: number) => L + t / tMax * (W - L - R)
  const y = (n: number) => H - B - n / nMax * (H - B - T)
  return (
    <figure className="chart" ref={ref}>
      <figcaption className="chart-title">{title} <span className="muted">tokens received over time</span></figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={s.map(x => `${x.label}: ${x.r.outputTokens} tokens in ${fmtMs(x.r.totalMs)}`).join('; ')}>
        {niceTicks(tMax, Math.max(3, Math.floor(W / 120))).map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={T} y2={H - B} className="grid" /><text x={x(t)} y={H - 8} className="axis" textAnchor="middle">{fmtMs(t)}</text></g>)}
        {niceTicks(nMax, 4).map(n => <g key={n}><line x1={L} x2={W - R} y1={y(n)} y2={y(n)} className="grid" /><text x={L - 6} y={y(n) + 4} className="axis" textAnchor="end">{n}</text></g>)}
        {s.map(({ id, color, r }) => {
          const per = r.outputTokens! / r.chunks!.length
          const pts = [`${x(0)},${y(0)}`, `${x(r.chunks![0])},${y(0)}`, ...r.chunks!.map((t, i) => `${x(t)},${y((i + 1) * per)}`)]
          return <polyline key={id} points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2.4} strokeLinejoin="round" />
        })}
      </svg>
      <Legend items={s.map(x => ({ label: `${x.label}: ${x.r.outputTokens} tok in ${fmtMs(x.r.totalMs)}`, color: x.color }))} />
    </figure>
  )
}

export const Legend = ({ items }: { items: { label: string; color: string }[] }) => (
  <ul className="legend">{items.map(i => <li key={i.label}><i style={{ background: i.color }} />{i.label}</li>)}</ul>
)

/** Small-multiple histograms of inter-token latency. */
export function ItlHistograms({ rows }: { rows: { id: string; label: string; color: string; values: number[] }[] }) {
  const all = rows.flatMap(r => r.values)
  if (!all.length) return <p className="muted small">No chunk timings recorded.</p>
  const bins = 24
  return (
    <div className="hist-grid">
      {rows.map(r => {
        const max = r.values.length ? quantile(r.values, 0.98) || 1 : 1
        const h = histogram(r.values, bins, max)
        const top = Math.max(1, ...h.counts)
        return (
          <figure key={r.id} className="hist">
            <figcaption><i style={{ background: r.color }} />{r.label}<span className="muted mono">p50 {r.values.length ? quantile(r.values, 0.5).toFixed(1) : 'n/a'} ms</span></figcaption>
            <svg viewBox="0 0 240 70" role="img" aria-label={`Inter-token latency distribution for ${r.label}`}>
              {h.counts.map((c, i) => <rect key={i} x={i * 10 + 0.5} y={62 - c / top * 56} width={9} height={c / top * 56} fill={r.color} opacity={0.85} rx={1} />)}
              <line x1={0} x2={240} y1={62.5} y2={62.5} className="grid" />
            </svg>
            <div className="hist-axis mono"><span>0</span><span>{max.toFixed(1)} ms+</span></div>
          </figure>
        )
      })}
    </div>
  )
}

/** Gantt view of the run: when each request started, waited for its first token, and finished. */
export function Timeline({ results, colorOf, labelOf }: { results: RequestResult[]; colorOf: (id: string) => string; labelOf: (r: RequestResult) => string }) {
  const [ref, W] = useWidth()
  const rs = results.filter(r => r.totalMs !== undefined).sort((a, b) => a.startedAt - b.startedAt)
  if (!rs.length) return null
  const end = Math.max(...rs.map(r => r.startedAt + r.totalMs!)) * 1.02
  // Pack requests into lanes so concurrency is visible.
  const lanes: number[] = []
  const placed = rs.map(r => {
    let l = lanes.findIndex(e => e <= r.startedAt)
    if (l < 0) { l = lanes.length; lanes.push(0) }
    lanes[l] = r.startedAt + r.totalMs!
    return { r, l }
  })
  const L = 8, R = 8, lh = Math.max(9, Math.min(22, Math.floor(160 / Math.max(1, lanes.length)))), H = lanes.length * lh + 26
  const x = (t: number) => L + t / end * (W - L - R)
  return (
    <figure className="chart" ref={ref}>
      <figcaption className="chart-title">Run timeline <span className="muted">{lanes.length} lane{lanes.length === 1 ? '' : 's'} at peak; pale = waiting for first token, solid = streaming, red = failed</span></figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Timeline of ${rs.length} requests`}>
        {niceTicks(end, Math.max(3, Math.floor(W / 120))).map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={0} y2={H - 20} className="grid" /><text x={x(t)} y={H - 6} className="axis" textAnchor="middle">{fmtMs(t)}</text></g>)}
        {placed.map(({ r, l }, i) => (
          <g key={i}>
            <title>{labelOf(r)}: {r.ok ? `TTFT ${fmtMs(r.ttftMs)}, total ${fmtMs(r.totalMs)}` : r.error}</title>
            {r.ok ? <>
              <rect x={x(r.startedAt)} y={l * lh + 2} width={Math.max(1, x(r.startedAt + r.ttftMs!) - x(r.startedAt))} height={lh - 3} fill={colorOf(r.endpointId)} opacity={0.3} />
              <rect x={x(r.startedAt + r.ttftMs!)} y={l * lh + 2} width={Math.max(1, x(r.startedAt + r.totalMs!) - x(r.startedAt + r.ttftMs!))} height={lh - 3} fill={colorOf(r.endpointId)} />
            </> : <rect x={x(r.startedAt)} y={l * lh + 2} width={Math.max(2, x(r.startedAt + r.totalMs!) - x(r.startedAt))} height={lh - 3} className="tl-fail" />}
          </g>
        ))}
      </svg>
    </figure>
  )
}
