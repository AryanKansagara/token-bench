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

const CODE = `// Incremental SSE parser: feed it chunks as they arrive.
export function createParser(onEvent: (data: string) => void) {
  let buf = ''
  let data: string[] = []
  return (chunk: string) => {
    buf += chunk
    const lines = buf.split(/\\r?\\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') {
        if (data.length) onEvent(data.join('\\n'))
        data = []
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart())
      }
    }
  }
}

test('parses events split across chunks', () => {
  const seen: string[] = []
  const push = createParser(d => seen.push(d))
  push('data: {"a"')
  push(':1}\\n\\n')
  assert.deepEqual(seen, ['{"a":1}'])
})

// Why it matters: the first token arrives in the first chunk,
// so a parser that waits for the whole body hides your real TTFT.
`

/** Roughly n tokens (about 4 characters each) of prose or code, repeating the corpus if needed. */
export function sampleText(tokens: number, code = false): string {
  const src = code ? CODE : ANSWER
  let s = ''
  while (s.length < tokens * 4) s += (s ? (code ? '\n' : ' ') : '') + src
  return s.slice(0, tokens * 4)
}

/**
 * A fetch that serves the synthetic providers by replaying recorded timings in real time, so the live runner,
 * parser and charts can be tried without any API key. Only answers for the provider-*.example base URLs.
 */
export function replayFetch(run: Run): typeof fetch {
  const r = rng(Date.now() % 100000)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const ep = run.endpoints.find(e => url.startsWith(e.baseUrl))
    if (!ep) throw new TypeError('Failed to fetch')
    const body = JSON.parse(String(init?.body ?? '{}'))
    const pool = run.results.filter(x => x.endpointId === ep.id && Math.abs((run.prompts.find(p => p.id === x.promptId)?.maxTokens ?? 0) - body.max_tokens) < 1)
    const rec = (pool.length ? pool : run.results.filter(x => x.endpointId === ep.id))[Math.floor(r() * (pool.length || 1))]
    const wait = (ms: number) => new Promise<void>((res, rej) => {
      const t = setTimeout(res, ms)
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')) })
    })
    if (!rec || !rec.ok) {
      await wait(rec?.totalMs && rec.totalMs < 5000 ? rec.totalMs : 80)
      return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded (synthetic replay)' } }), { status: 429 })
    }
    const isCode = /code|function|sql|implement/i.test(JSON.stringify(body.messages))
    const text = sampleText(rec.outputTokens!, isCode)
    const times = rec.chunks ?? [rec.ttftMs!]
    const per = Math.ceil(text.length / times.length)
    const enc = new TextEncoder()
    const t0 = performance.now()
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (i < times.length) {
          await wait(Math.max(0, times[i] - (performance.now() - t0)))
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i * per, (i + 1) * per) } }] })}\n\n`))
          i++
          return
        }
        if (body.stream_options?.include_usage) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: rec.inputTokens, completion_tokens: rec.outputTokens } })}\n\n`))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    }, { highWaterMark: 0 })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
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
    results.push({ ...base, ok: true, status: 200, ttftMs: Math.round(ttft * 10) / 10, totalMs: Math.round(totalMs * 10) / 10, outputTokens, tokenSource: e.profile.tokPerChunk === 1 ? 'approx' : 'usage', chunks, ...(keepTextChars ? { text: sampleText(outputTokens, p.suite === 'Code').slice(0, keepTextChars) } : {}) })
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
