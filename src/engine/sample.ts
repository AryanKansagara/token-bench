// A labelled synthetic recorded benchmark: three fake providers, realistic shapes, deterministic.
import { rng } from './stats.ts'
import { SUITES } from './suites.ts'
import type { Endpoint, Prompt, RequestResult, Run } from './types.ts'

export const SAMPLE_NOTE = 'Synthetic data: fake providers A, B and C with made-up timings. Not a measurement of any real service.'

interface Profile { ttft: number; prefillPer1k: number; tps: number; tpsSd: number; tokPerChunk: number; stallP: number; rateLimitP: number; timeoutP: number }

const ENDPOINTS: (Endpoint & { profile: Profile })[] = [
  { id: 'sample-a', name: 'Provider A (synthetic)', baseUrl: 'https://provider-a.example/v1', model: 'open-70b', inputPrice: 0.85, outputPrice: 1.2, streamOptions: true, color: '#f05a28', profile: { ttft: 170, prefillPer1k: 6, tps: 1900, tpsSd: 160, tokPerChunk: 12, stallP: 0.004, rateLimitP: 0.004, timeoutP: 0 } },
  { id: 'sample-b', name: 'Provider B (synthetic)', baseUrl: 'https://provider-b.example/v1', model: 'open-70b', inputPrice: 0.59, outputPrice: 0.79, streamOptions: true, color: '#3a8f96', profile: { ttft: 290, prefillPer1k: 22, tps: 420, tpsSd: 70, tokPerChunk: 3, stallP: 0.003, rateLimitP: 0.03, timeoutP: 0.005 } },
  { id: 'sample-c', name: 'Provider C (synthetic)', baseUrl: 'https://provider-c.example/v1', model: 'open-70b', inputPrice: 0.88, outputPrice: 0.88, streamOptions: false, color: '#a77be0', profile: { ttft: 520, prefillPer1k: 60, tps: 95, tpsSd: 28, tokPerChunk: 1, stallP: 0.0015, rateLimitP: 0.08, timeoutP: 0.01 } },
]

export const SAMPLE_ENDPOINTS: Endpoint[] = ENDPOINTS.map(({ profile: _p, ...e }) => e)

export const SAMPLE_PROMPTS: Prompt[] = [
  ...SUITES[0].prompts.slice(0, 3),
  SUITES[1].prompts[0],
  ...SUITES[2].prompts.slice(0, 2),
  SUITES[3].prompts[0],
]

const ANSWER = `Latency is how long one request waits before it is done; throughput is how many requests or tokens the system finishes per second. For a chat product, users feel latency first: the time to the first token decides whether the reply feels instant, and decode speed decides whether a long answer streams faster than they can read. Throughput matters to the operator: a provider can serve many users at once yet still feel slow to each of them. When you compare providers, measure both on your own prompts, at the concurrency you expect, and look at the spread, not just the average, because the slowest few percent of requests are what users remember. An agent that makes ten sequential calls multiplies every millisecond of latency by ten, so fast inference turns a minute-long loop into seconds.`

/** Splits text into roughly n tokens (about 4 characters each), repeating the corpus if needed. */
export function sampleText(tokens: number): string {
  let s = ''
  while (s.length < tokens * 4) s += (s ? ' ' : '') + ANSWER
  return s.slice(0, tokens * 4)
}

function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
}

export function sampleRun(variant: 'baseline' | 'rerun' = 'rerun', keepTextChars = 400): Run {
  const r = rng(variant === 'baseline' ? 101 : 202)
  const reps = 3
  const results: RequestResult[] = []
  let clock = 0
  for (let rep = 0; rep < reps; rep++) for (const p of SAMPLE_PROMPTS) for (const e of ENDPOINTS) {
    const pr = { ...e.profile }
    // The rerun tells a story for the compare view: B shipped a faster kernel, C got busier.
    if (variant === 'rerun' && e.id === 'sample-b') { pr.tps *= 1.35; pr.ttft *= 0.85 }
    if (variant === 'rerun' && e.id === 'sample-c') { pr.rateLimitP *= 1.8; pr.ttft *= 1.15 }
    const inputTokens = Math.round(((p.system ?? '') + p.user).length / 4)
    const startedAt = Math.round(clock)
    clock += 40 + r() * 60
    const base = { endpointId: e.id, promptId: p.id, rep, startedAt, inputTokens }
    if (r() < pr.rateLimitP) { results.push({ ...base, ok: false, status: 429, errorKind: 'rate_limit', error: 'HTTP 429: Rate limit exceeded (synthetic)', totalMs: Math.round(30 + r() * 80) }); continue }
    if (r() < pr.timeoutP) { results.push({ ...base, ok: false, errorKind: 'timeout', error: 'Timed out after 60000 ms (synthetic)', totalMs: 60000 }); continue }
    const ttft = Math.max(40, (pr.ttft + pr.prefillPer1k * inputTokens / 1000) * Math.exp(0.22 * gauss(r)))
    const tps = Math.max(10, pr.tps + pr.tpsSd * gauss(r))
    const outputTokens = Math.round(p.maxTokens * (0.72 + r() * 0.28))
    const chunks: number[] = [ttft]
    let t = ttft
    for (let done = Math.min(pr.tokPerChunk, outputTokens); done < outputTokens; done += pr.tokPerChunk) {
      const n = Math.min(pr.tokPerChunk, outputTokens - done)
      let gap = n / tps * 1000 * (0.6 + r() * 0.8)
      if (r() < pr.stallP) gap += 150 + r() * 600
      t += gap
      chunks.push(Math.round(t * 10) / 10)
    }
    const totalMs = t + 2 + r() * 6
    results.push({ ...base, ok: true, status: 200, ttftMs: Math.round(ttft * 10) / 10, totalMs: Math.round(totalMs * 10) / 10, outputTokens, tokenSource: e.profile.tokPerChunk === 1 ? 'approx' : 'usage', chunks, ...(keepTextChars ? { text: sampleText(outputTokens).slice(0, keepTextChars) } : {}) })
  }
  const createdAt = variant === 'baseline' ? Date.UTC(2026, 9, 12, 15, 0) : Date.UTC(2026, 10, 9, 15, 0)
  return {
    id: `sample-run-${variant}`,
    label: variant === 'baseline' ? 'Baseline, 12 Oct 2026 (synthetic)' : 'Rerun, 9 Nov 2026 (synthetic)',
    createdAt, source: 'sample',
    config: { reps, concurrency: 3, rampMs: 250, timeoutMs: 60000, temperature: 0 },
    endpoints: SAMPLE_ENDPOINTS, prompts: SAMPLE_PROMPTS, results,
    durationMs: Math.round(clock + 4000),
  }
}
