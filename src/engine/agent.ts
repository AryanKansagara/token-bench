// "How long will my agent loop take on this provider?" from measured requests.
import { decodeTps, quantile, rng } from './stats.ts'
import type { RequestResult } from './types.ts'

export interface Step { inputTokens: number; outputTokens: number }

export interface LoopEstimate { p50: number; p90: number; mean: number; samples: number; prefillModel: boolean; perStepP50: number[] }

/** Ordinary least squares y = a + b x. */
export function fitLine(xs: number[], ys: number[]): { a: number; b: number } | null {
  const n = xs.length
  if (n < 2) return null
  const mx = xs.reduce((s, x) => s + x, 0) / n
  const my = ys.reduce((s, y) => s + y, 0) / n
  let sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my) }
  if (sxx === 0) return null
  const b = sxy / sxx
  return { a: my - b * mx, b }
}

/** Builds k steps where the context grows by each step's output plus a fixed tool result size. */
export function growingLoop(k: number, firstInput: number, output: number, toolTokens: number): Step[] {
  const out: Step[] = []
  let ctx = firstInput
  for (let i = 0; i < k; i++) { out.push({ inputTokens: ctx, outputTokens: output }); ctx += output + toolTokens }
  return out
}

/**
 * Monte Carlo over the measured (TTFT, decode speed) pairs, sampled jointly so a slow-start request keeps
 * its own decode speed. If the run covered a spread of prompt sizes and TTFT grows with input, TTFT is
 * modelled as a line in input tokens plus a resampled residual, so long contexts later in the loop cost more.
 */
export function estimateLoop(results: RequestResult[], steps: Step[], o: { iters?: number; seed?: number; toolMs?: number } = {}): LoopEstimate | null {
  const pairs = results.filter(r => r.ok).map(r => ({ ttft: r.ttftMs!, tps: decodeTps(r), input: r.inputTokens ?? 0 })).filter((p): p is { ttft: number; tps: number; input: number } => p.tps !== null && p.tps > 0)
  if (!pairs.length || !steps.length) return null
  const inputs = pairs.map(p => p.input)
  const spread = Math.max(...inputs) - Math.min(...inputs)
  const fit = spread > 500 ? fitLine(inputs, pairs.map(p => p.ttft)) : null
  const useFit = !!fit && fit.b > 0
  const resid = useFit ? pairs.map(p => p.ttft - (fit!.a + fit!.b * p.input)) : []
  const r = rng(o.seed ?? 11)
  const iters = o.iters ?? 2000
  const tool = o.toolMs ?? 0
  const totals: number[] = []
  const perStep: number[][] = steps.map(() => [])
  for (let i = 0; i < iters; i++) {
    let t = 0
    steps.forEach((s, j) => {
      const k = Math.floor(r() * pairs.length)
      const p = pairs[k]
      const ttft = useFit ? Math.max(1, fit!.a + fit!.b * s.inputTokens + resid[k]) : p.ttft
      const dt = ttft + Math.max(0, s.outputTokens - 1) / p.tps * 1000 + tool
      perStep[j].push(dt)
      t += dt
    })
    totals.push(t)
  }
  return { p50: quantile(totals, 0.5), p90: quantile(totals, 0.9), mean: totals.reduce((a, b) => a + b, 0) / iters, samples: pairs.length, prefillModel: useFit, perStepP50: perStep.map(x => quantile(x, 0.5)) }
}
