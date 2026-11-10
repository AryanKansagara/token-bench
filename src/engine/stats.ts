// Statistics and per-endpoint summaries for a benchmark run.
import type { Endpoint, Prompt, RequestResult, Run } from './types.ts'

/** Deterministic PRNG so bootstrap intervals and samples are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN

export function stdev(xs: number[]) {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/** Linear-interpolated quantile (the same definition as numpy's default and Excel's PERCENTILE.INC). */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const h = (s.length - 1) * Math.min(1, Math.max(0, q))
  const lo = Math.floor(h)
  return s[lo] + (h - lo) * ((s[Math.ceil(h)] ?? s[lo]) - s[lo])
}

/** Percentile bootstrap confidence interval for any statistic. */
export function bootstrapCI(xs: number[], stat: (s: number[]) => number, o: { iters?: number; level?: number; seed?: number } = {}): [number, number] {
  if (xs.length < 2) return [stat(xs), stat(xs)]
  const r = rng(o.seed ?? 7)
  const iters = o.iters ?? 1000
  const level = o.level ?? 0.95
  const est: number[] = []
  const buf = new Array<number>(xs.length)
  for (let i = 0; i < iters; i++) {
    for (let j = 0; j < xs.length; j++) buf[j] = xs[Math.floor(r() * xs.length)]
    est.push(stat(buf))
  }
  return [quantile(est, (1 - level) / 2), quantile(est, 1 - (1 - level) / 2)]
}

/** Output tokens per second during decode: tokens after the first, over the time after the first token. */
export function decodeTps(r: RequestResult): number | null {
  if (!r.ok || r.outputTokens === undefined || r.ttftMs === undefined || r.totalMs === undefined) return null
  const dt = r.totalMs - r.ttftMs
  if (r.outputTokens <= 1 || dt <= 0) return null
  return (r.outputTokens - 1) / (dt / 1000)
}

/**
 * Inter-token latencies. Providers batch several tokens into one SSE chunk, so each chunk gap is
 * spread over the average tokens per chunk for that request.
 */
export function interTokenLatencies(r: RequestResult): number[] {
  const c = r.chunks
  if (!r.ok || !c || c.length < 2 || !r.outputTokens) return []
  const perChunk = Math.max(1, r.outputTokens / c.length)
  const out: number[] = []
  for (let i = 1; i < c.length; i++) out.push(Math.max(0, c[i] - c[i - 1]) / perChunk)
  return out
}

export interface Stat { p50: number; p90: number; p99: number; mean: number; ci: [number, number]; n: number }

/** Percentiles plus a bootstrap CI on the median (pass ci: false for large pooled samples where it is not shown). */
export function describe(xs: number[], seed = 7, ci = true): Stat | null {
  if (!xs.length) return null
  const p50 = quantile(xs, 0.5)
  return { p50, p90: quantile(xs, 0.9), p99: quantile(xs, 0.99), mean: mean(xs), ci: ci ? bootstrapCI(xs, s => quantile(s, 0.5), { seed }) : [p50, p50], n: xs.length }
}

export interface Summary {
  endpoint: Endpoint
  total: number
  ok: number
  errorRate: number
  rateLimitRate: number
  errors: Partial<Record<string, number>>
  ttft: Stat | null
  tps: Stat | null
  e2e: Stat | null
  itl: Stat | null
  /** Coefficient of variation of decode speed across requests: lower is more consistent. */
  tpsCv: number | null
  /** Median absolute difference between consecutive inter-token gaps, ms. */
  jitterMs: number | null
  outputTokens: number
  inputTokens: number
  usageShare: number
  /** USD for every request in this run, from the user's prices. */
  cost: number | null
  /** Blended USD per 1M tokens at this run's actual input/output mix. */
  blendedPer1M: number | null
}

export function costOf(inputTokens: number, outputTokens: number, ep: Pick<Endpoint, 'inputPrice' | 'outputPrice'>): number | null {
  if (ep.inputPrice === undefined && ep.outputPrice === undefined) return null
  return (inputTokens * (ep.inputPrice ?? 0) + outputTokens * (ep.outputPrice ?? 0)) / 1e6
}

/** Blended price per 1M tokens for a given output share (0.25 means 3 input tokens per output token). */
export function blendedPrice(ep: Pick<Endpoint, 'inputPrice' | 'outputPrice'>, outputShare: number): number | null {
  if (ep.inputPrice === undefined && ep.outputPrice === undefined) return null
  return (ep.inputPrice ?? 0) * (1 - outputShare) + (ep.outputPrice ?? 0) * outputShare
}

/** Jitter: median absolute change between consecutive gaps, pooled over requests. Robust to one long stall. */
export function jitter(gapsPerRequest: number[][]): number | null {
  const d: number[] = []
  for (const g of gapsPerRequest) for (let i = 1; i < g.length; i++) d.push(Math.abs(g[i] - g[i - 1]))
  return d.length ? quantile(d, 0.5) : null
}

export function summarize(ep: Endpoint, results: RequestResult[], seed = 7): Summary {
  const rs = results.filter(r => r.endpointId === ep.id && r.errorKind !== 'aborted')
  const ok = rs.filter(r => r.ok)
  const tps = ok.map(decodeTps).filter((x): x is number => x !== null)
  const itlPer = ok.map(interTokenLatencies)
  const errors: Summary['errors'] = {}
  for (const r of rs) if (!r.ok) errors[r.errorKind ?? 'http'] = (errors[r.errorKind ?? 'http'] ?? 0) + 1
  const outputTokens = ok.reduce((a, r) => a + (r.outputTokens ?? 0), 0)
  const inputTokens = ok.reduce((a, r) => a + (r.inputTokens ?? 0), 0)
  const cost = costOf(inputTokens, outputTokens, ep)
  return {
    endpoint: ep,
    total: rs.length,
    ok: ok.length,
    errorRate: rs.length ? (rs.length - ok.length) / rs.length : 0,
    rateLimitRate: rs.length ? rs.filter(r => r.errorKind === 'rate_limit').length / rs.length : 0,
    errors,
    ttft: describe(ok.map(r => r.ttftMs!), seed),
    tps: describe(tps, seed + 1),
    e2e: describe(ok.map(r => r.totalMs!), seed + 2),
    itl: describe(itlPer.flat(), seed + 3, false),
    tpsCv: tps.length > 1 ? stdev(tps) / mean(tps) : null,
    jitterMs: jitter(itlPer),
    outputTokens,
    inputTokens,
    usageShare: ok.length ? ok.filter(r => r.tokenSource === 'usage').length / ok.length : 0,
    cost,
    blendedPer1M: cost !== null && inputTokens + outputTokens > 0 ? cost / (inputTokens + outputTokens) * 1e6 : null,
  }
}

export type RankBy = 'e2e' | 'ttft' | 'tps' | 'cost'

export const RANK_LABEL: Record<RankBy, string> = { e2e: 'Median end-to-end latency', ttft: 'Median time to first token', tps: 'Median output tokens/s', cost: 'Cost per 1M tokens' }

/** Leaderboard: endpoints with at least one success, best first. Endpoints that never succeeded go last. */
export function leaderboard(run: Pick<Run, 'endpoints' | 'results'>, by: RankBy = 'e2e'): Summary[] {
  const key = (s: Summary): number => {
    if (!s.ok) return Infinity
    if (by === 'tps') return -(s.tps?.p50 ?? -Infinity)
    if (by === 'ttft') return s.ttft?.p50 ?? Infinity
    if (by === 'cost') return s.blendedPer1M ?? Infinity
    return s.e2e?.p50 ?? Infinity
  }
  return run.endpoints.map((e, i) => summarize(e, run.results, 7 + i * 10)).sort((a, b) => key(a) - key(b) || b.ok - a.ok)
}

export interface PromptCell { promptId: string; endpointId: string; e2e: number | null; ttft: number | null; tps: number | null; ok: number; total: number }

/** Per prompt and endpoint medians: the "on your own prompts" matrix. */
export function promptMatrix(run: Pick<Run, 'endpoints' | 'prompts' | 'results'>): { prompt: Prompt; cells: PromptCell[]; winner: string | null }[] {
  return run.prompts.map(prompt => {
    const cells = run.endpoints.map(ep => {
      const rs = run.results.filter(r => r.promptId === prompt.id && r.endpointId === ep.id && r.errorKind !== 'aborted')
      const ok = rs.filter(r => r.ok)
      const tps = ok.map(decodeTps).filter((x): x is number => x !== null)
      return {
        promptId: prompt.id, endpointId: ep.id, ok: ok.length, total: rs.length,
        e2e: ok.length ? quantile(ok.map(r => r.totalMs!), 0.5) : null,
        ttft: ok.length ? quantile(ok.map(r => r.ttftMs!), 0.5) : null,
        tps: tps.length ? quantile(tps, 0.5) : null,
      }
    })
    const best = cells.filter(c => c.e2e !== null).sort((a, b) => a.e2e! - b.e2e!)[0]
    return { prompt, cells, winner: best?.endpointId ?? null }
  })
}

/** Histogram over [0, max] in `bins` equal buckets; values above max land in the last bucket. */
export function histogram(xs: number[], bins: number, max = quantile(xs, 0.99)): { edges: number[]; counts: number[] } {
  const counts = new Array(bins).fill(0)
  const top = max > 0 ? max : 1
  for (const x of xs) counts[Math.min(bins - 1, Math.max(0, Math.floor(x / top * bins)))]++
  return { edges: Array.from({ length: bins + 1 }, (_, i) => i * top / bins), counts }
}

/** Identity used to match the same endpoint across runs even if ids differ (imports, other devices). */
export const endpointKey = (e: Pick<Endpoint, 'baseUrl' | 'model'>) => `${e.baseUrl.trim().replace(/\/+$/, '').toLowerCase()}|${e.model.trim()}`

export interface CompareRow { key: string; name: string; a: Summary | null; b: Summary | null }

export function compareRuns(a: Run, b: Run): CompareRow[] {
  const keys = [...new Set([...a.endpoints, ...b.endpoints].map(endpointKey))]
  return keys.map(k => {
    const ea = a.endpoints.find(e => endpointKey(e) === k)
    const eb = b.endpoints.find(e => endpointKey(e) === k)
    return { key: k, name: (eb ?? ea)!.name, a: ea ? summarize(ea, a.results) : null, b: eb ? summarize(eb, b.results) : null }
  })
}

/** Relative change b vs a; for latency a negative number is an improvement. */
export const relChange = (a: number | null | undefined, b: number | null | undefined) => a && b !== null && b !== undefined && a !== null ? (b - a) / a : null
