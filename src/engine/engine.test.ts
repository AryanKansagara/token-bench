import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approxTokens, createSseParser, parseChatData, type SseEvent } from './sse.ts'
import { chatUrl, requestBody, streamChat } from './request.ts'
import { runBenchmark, runPool, schedule } from './runner.ts'
import { blendedPrice, bootstrapCI, compareRuns, costOf, decodeTps, histogram, interTokenLatencies, jitter, leaderboard, promptMatrix, quantile, rng, summarize } from './stats.ts'
import { estimateLoop, fitLine, growingLoop } from './agent.ts'
import { decodeShare, detectFormat, encodeShare, exportRunJson, guessMapping, importPrompts, importRun, parseCsv, resultsCsv } from './parse.ts'
import { sampleRun, SAMPLE_ENDPOINTS } from './sample.ts'
import { nodeScript } from './script.ts'
import { SUITES } from './suites.ts'
import type { Endpoint, Prompt, RequestResult } from './types.ts'

const EP: Endpoint = { id: 'e1', name: 'Local', baseUrl: 'http://x/v1', model: 'm', streamOptions: true }
const P: Prompt = { id: 'p1', name: 'P', suite: 's', user: 'hello there', maxTokens: 64 }

const chunk = (content: string, extra: object = {}) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }], ...extra })}\n\n`
const usage = (prompt: number, completion: number) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\n`

/** A fetch that streams the given pieces with a fake clock advancing per piece. */
function fakeFetch(pieces: { text: string; at: number }[], clock: { t: number }, status = 200, body = '') {
  return (async () => {
    if (status !== 200) return new Response(body, { status })
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= pieces.length) return c.close()
        clock.t = pieces[i].at
        c.enqueue(new TextEncoder().encode(pieces[i++].text))
      },
    }, { highWaterMark: 0 })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}

// ---------- SSE parser ----------

test('SSE parser reassembles events split at arbitrary byte boundaries', () => {
  const evs: SseEvent[] = []
  const p = createSseParser(e => evs.push(e))
  const raw = ': keepalive\n\nevent: msg\ndata: {"a":1}\n\ndata: line1\ndata: line2\r\n\r\ndata:[DONE]\n\n'
  for (const ch of raw) p.push(ch)
  p.end()
  assert.deepEqual(evs, [{ event: 'msg', data: '{"a":1}' }, { event: undefined, data: 'line1\nline2' }, { event: undefined, data: '[DONE]' }])
})

test('SSE parser does not split a CRLF that straddles two pushes', () => {
  const evs: SseEvent[] = []
  const p = createSseParser(e => evs.push(e))
  p.push('data: x\r')
  p.push('\n\r\n')
  p.end()
  assert.deepEqual(evs.map(e => e.data), ['x'])
})

test('parseChatData reads content, reasoning, usage chunks, DONE and provider errors', () => {
  assert.equal(parseChatData('[DONE]').done, true)
  const d = parseChatData(JSON.stringify({ choices: [{ delta: { content: 'Hi', reasoning_content: 'think' }, finish_reason: 'stop' }] }))
  assert.equal(d.content, 'Hi'); assert.equal(d.reasoning, 'think'); assert.equal(d.finishReason, 'stop')
  assert.deepEqual(parseChatData(JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } })).usage, { prompt_tokens: 5, completion_tokens: 9 })
  assert.equal(parseChatData('{"error":{"message":"overloaded"}}').error, 'overloaded')
  assert.match(parseChatData('{oops').error!, /Malformed/)
})

test('approxTokens is in the right range for prose and code', () => {
  const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(20) // about 200 BPE tokens
  const n = approxTokens(prose)
  assert.ok(n > 170 && n < 240, `prose ${n}`)
  assert.equal(approxTokens(''), 0)
})

// ---------- One request ----------

test('streamChat measures TTFT from the first content chunk and prefers usage tokens', async () => {
  const clock = { t: 0 }
  const f = fakeFetch([
    { text: `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`, at: 50 },
    { text: chunk('Hello'), at: 120 },
    { text: chunk(' world'), at: 170 },
    { text: chunk('!'), at: 220 },
    { text: usage(11, 42) + 'data: [DONE]\n\n', at: 230 },
  ], clock)
  const r = await streamChat(EP, 'k', P, 0, 0, { fetch: f, now: () => clock.t })
  assert.equal(r.ok, true)
  assert.equal(r.ttftMs, 120)
  assert.equal(r.totalMs, 230)
  assert.equal(r.outputTokens, 42); assert.equal(r.inputTokens, 11); assert.equal(r.tokenSource, 'usage')
  assert.deepEqual(r.chunks, [120, 170, 220])
  assert.equal(r.text, 'Hello world!')
})

test('streamChat falls back to approximate tokens when no usage chunk arrives', async () => {
  const clock = { t: 0 }
  const r = await streamChat({ ...EP, streamOptions: false }, '', P, 0, 0, { fetch: fakeFetch([{ text: chunk('one two three four'), at: 10 }, { text: 'data: [DONE]\n\n', at: 20 }], clock), now: () => clock.t })
  assert.equal(r.tokenSource, 'approx')
  assert.ok(r.outputTokens! >= 3 && r.outputTokens! <= 6)
})

test('streamChat classifies 429, HTTP errors, mid-stream errors and network failures', async () => {
  const clock = { t: 0 }
  const rl = await streamChat(EP, 'k', P, 0, 0, { fetch: fakeFetch([], clock, 429, '{"error":{"message":"slow down"}}'), now: () => clock.t })
  assert.equal(rl.errorKind, 'rate_limit'); assert.match(rl.error!, /429: slow down/)
  const h = await streamChat(EP, 'k', P, 0, 0, { fetch: fakeFetch([], clock, 401, 'bad key'), now: () => clock.t })
  assert.equal(h.errorKind, 'http'); assert.equal(h.status, 401)
  const s = await streamChat(EP, 'k', P, 0, 0, { fetch: fakeFetch([{ text: chunk('a'), at: 5 }, { text: 'data: {"error":{"message":"model crashed"}}\n\n', at: 9 }], clock), now: () => clock.t })
  assert.equal(s.ok, false); assert.equal(s.errorKind, 'stream'); assert.equal(s.error, 'model crashed')
  const n = await streamChat(EP, 'k', P, 0, 0, { fetch: (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch })
  assert.equal(n.errorKind, 'network')
})

test('request body uses chat completions shape with usage, max_tokens and JSON mode', () => {
  assert.equal(chatUrl('https://api.x.ai/v1/'), 'https://api.x.ai/v1/chat/completions')
  assert.equal(chatUrl('https://api.x.ai/v1/chat/completions'), 'https://api.x.ai/v1/chat/completions')
  const b = requestBody(EP, { ...P, system: 'sys', json: true }, 0.2)
  assert.deepEqual(b.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello there' }])
  assert.deepEqual(b.stream_options, { include_usage: true })
  assert.deepEqual(b.response_format, { type: 'json_object' })
  assert.equal(b.max_tokens, 64)
  assert.equal('stream_options' in requestBody({ ...EP, streamOptions: false }, P), false)
})

// ---------- Runner ----------

test('runPool never exceeds the concurrency limit, ramps workers and keeps result order', async () => {
  let inFlight = 0, peak = 0
  const sleeps: number[] = []
  const tasks = Array.from({ length: 10 }, (_, i) => async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 5 + (i % 3)))
    inFlight--
    return i
  })
  const out = await runPool(tasks, { concurrency: 3, rampMs: 100, sleep: async ms => { sleeps.push(ms) } })
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(peak, 3)
  assert.deepEqual(sleeps.sort((a, b) => a - b), [100, 200])
})

test('runPool stops picking up new work after abort', async () => {
  const ctrl = new AbortController()
  let ran = 0
  const tasks = Array.from({ length: 20 }, () => async () => { ran++; if (ran === 3) ctrl.abort(); return ran })
  const out = await runPool(tasks, { concurrency: 1, signal: ctrl.signal })
  assert.equal(ran, 3)
  assert.equal(out.filter(x => x !== undefined).length, 3)
})

test('schedule interleaves endpoints within each prompt and repetition', () => {
  const eps = [EP, { ...EP, id: 'e2' }]
  const prs = [P, { ...P, id: 'p2' }]
  const s = schedule(eps, prs, 2)
  assert.equal(s.length, 8)
  assert.deepEqual(s.slice(0, 4).map(j => `${j.prompt.id}/${j.endpoint.id}/${j.rep}`), ['p1/e1/0', 'p1/e2/0', 'p2/e1/0', 'p2/e2/0'])
})

// ---------- Statistics ----------

test('quantile matches linear interpolation (numpy default)', () => {
  const xs = [15, 20, 35, 40, 50]
  assert.equal(quantile(xs, 0.5), 35)
  assert.equal(quantile(xs, 0.4), 29)
  assert.equal(quantile(xs, 0.9), 46)
  assert.equal(quantile([7], 0.99), 7)
  assert.ok(Number.isNaN(quantile([], 0.5)))
})

test('bootstrap CI brackets the median, is reproducible, and narrows with more data', () => {
  const r = rng(1)
  const small = Array.from({ length: 20 }, () => 100 + r() * 50)
  const big = Array.from({ length: 400 }, () => 100 + r() * 50)
  const med = (s: number[]) => quantile(s, 0.5)
  const a = bootstrapCI(small, med, { seed: 3 })
  assert.deepEqual(a, bootstrapCI(small, med, { seed: 3 }))
  assert.ok(a[0] <= med(small) && med(small) <= a[1])
  const b = bootstrapCI(big, med, { seed: 3 })
  assert.ok(b[1] - b[0] < a[1] - a[0])
})

test('decode tokens/s excludes the first token and the TTFT wait', () => {
  const r: RequestResult = { endpointId: 'e', promptId: 'p', rep: 0, startedAt: 0, ok: true, ttftMs: 200, totalMs: 1200, outputTokens: 101 }
  assert.equal(decodeTps(r), 100)
  assert.equal(decodeTps({ ...r, ok: false }), null)
  assert.equal(decodeTps({ ...r, outputTokens: 1 }), null)
})

test('inter-token latency spreads chunk gaps over tokens per chunk; jitter ignores steady streams', () => {
  const r: RequestResult = { endpointId: 'e', promptId: 'p', rep: 0, startedAt: 0, ok: true, ttftMs: 100, totalMs: 400, outputTokens: 8, chunks: [100, 200, 300, 400] }
  assert.deepEqual(interTokenLatencies(r), [50, 50, 50])
  assert.equal(jitter([[10, 10, 10, 10]]), 0)
  assert.equal(jitter([[10, 30, 10, 30]]), 20)
  assert.equal(jitter([]), null)
})

test('cost per request and blended price per 1M tokens', () => {
  const ep = { inputPrice: 0.6, outputPrice: 1.2 }
  assert.ok(Math.abs(costOf(1_000_000, 500_000, ep)! - 1.2) < 1e-9)
  assert.ok(Math.abs(blendedPrice(ep, 0.25)! - 0.75) < 1e-9)
  assert.equal(costOf(10, 10, {}), null)
})

test('summary counts error and 429 rates and ignores cancelled requests', () => {
  const ok = (ttft: number): RequestResult => ({ endpointId: 'e1', promptId: 'p', rep: 0, startedAt: 0, ok: true, ttftMs: ttft, totalMs: ttft + 1000, outputTokens: 101, inputTokens: 10 })
  const results: RequestResult[] = [ok(100), ok(200), ok(300),
    { endpointId: 'e1', promptId: 'p', rep: 1, startedAt: 0, ok: false, errorKind: 'rate_limit', status: 429 },
    { endpointId: 'e1', promptId: 'p', rep: 2, startedAt: 0, ok: false, errorKind: 'aborted' }]
  const s = summarize({ ...EP, inputPrice: 1, outputPrice: 2 }, results)
  assert.equal(s.total, 4)
  assert.equal(s.errorRate, 0.25); assert.equal(s.rateLimitRate, 0.25)
  assert.equal(s.ttft!.p50, 200)
  assert.equal(s.tps!.p50, 100)
  assert.equal(s.tpsCv, 0)
  assert.ok(Math.abs(s.cost! - (30 * 1 + 303 * 2) / 1e6) < 1e-12)
})

test('leaderboard ranks the synthetic sample as A, B, C by latency and by speed', () => {
  const run = sampleRun()
  assert.deepEqual(leaderboard(run, 'e2e').map(s => s.endpoint.id), ['sample-a', 'sample-b', 'sample-c'])
  assert.deepEqual(leaderboard(run, 'tps').map(s => s.endpoint.id), ['sample-a', 'sample-b', 'sample-c'])
  const byCost = leaderboard(run, 'cost').map(s => s.endpoint.id)
  assert.equal(byCost[0], 'sample-b')
  const m = promptMatrix(run)
  assert.equal(m.length, run.prompts.length)
  assert.ok(m.every(row => row.winner === 'sample-a'))
})

test('compare view matches endpoints across runs by base URL and model and shows B got faster', () => {
  const rows = compareRuns(sampleRun('baseline'), sampleRun('rerun'))
  assert.equal(rows.length, 3)
  const b = rows.find(r => r.name.startsWith('Provider B'))!
  assert.ok(b.b!.tps!.p50 > b.a!.tps!.p50 * 1.15)
})

test('histogram puts overflow in the last bin', () => {
  const h = histogram([1, 2, 3, 100], 4, 4)
  assert.deepEqual(h.counts, [0, 1, 1, 2])
  assert.equal(h.edges.length, 5)
})

// ---------- Agent loop ----------

test('agent loop estimate equals the sum of steps for a perfectly steady provider', () => {
  const steady: RequestResult[] = Array.from({ length: 10 }, (_, i) => ({ endpointId: 'e', promptId: 'p', rep: i, startedAt: 0, ok: true, ttftMs: 200, totalMs: 1200, outputTokens: 101, inputTokens: 1000 }))
  const e = estimateLoop(steady, [{ inputTokens: 1000, outputTokens: 101 }, { inputTokens: 1000, outputTokens: 201 }], { toolMs: 50 })!
  // step 1: 200 + 1000 + 50, step 2: 200 + 2000 + 50
  assert.equal(Math.round(e.p50), 3500)
  assert.equal(Math.round(e.p90), 3500)
  assert.equal(e.prefillModel, false)
})

test('agent loop models prefill when TTFT grows with context, and p90 exceeds p50 with noise', () => {
  const r = rng(5)
  const rs: RequestResult[] = Array.from({ length: 40 }, (_, i) => {
    const input = 500 + (i % 4) * 4000
    const ttft = 100 + input * 0.05 + r() * 80
    return { endpointId: 'e', promptId: 'p', rep: i, startedAt: 0, ok: true, ttftMs: ttft, totalMs: ttft + 1000 + r() * 400, outputTokens: 201, inputTokens: input }
  })
  const fit = fitLine(rs.map(x => x.inputTokens!), rs.map(x => x.ttftMs!))!
  assert.ok(Math.abs(fit.b - 0.05) < 0.01)
  const steps = growingLoop(5, 1000, 200, 3000)
  assert.deepEqual(steps.map(s => s.inputTokens), [1000, 4200, 7400, 10600, 13800])
  const e = estimateLoop(rs, steps)!
  assert.equal(e.prefillModel, true)
  assert.ok(e.perStepP50[4] > e.perStepP50[0] + 500)
  assert.ok(e.p90 > e.p50)
  assert.equal(estimateLoop([], steps), null)
})

// ---------- Import / export ----------

test('CSV parser handles quotes, embedded newlines and reports source line numbers', () => {
  const rows = parseCsv('name,prompt\r\na,"He said ""hi"""\nb,"multi\nline"\n\nc,plain\n')
  assert.deepEqual(rows.map(r => r.cells), [['name', 'prompt'], ['a', 'He said "hi"'], ['b', 'multi\nline'], ['c', 'plain']])
  assert.deepEqual(rows.map(r => r.line), [1, 2, 3, 6])
})

test('prompt CSV import guesses the mapping and validates rows with line numbers', () => {
  const csv = 'id,prompt,max_tokens,json\nq1,What is TTFT?,100,\nq2,,50,\nq3,Give JSON,abc,yes\n'
  let n = 0
  const r = importPrompts(csv, 'p.csv', undefined, { maxTokens: 256, suite: 'Mine' }, () => `id${n++}`)
  assert.deepEqual(r.mapping, { user: 1, name: 0, system: -1, maxTokens: 2, suite: -1, json: 3 })
  assert.equal(r.prompts.length, 2)
  assert.equal(r.prompts[0].maxTokens, 100)
  assert.equal(r.prompts[1].maxTokens, 256); assert.equal(r.prompts[1].json, true)
  assert.deepEqual(r.issues.map(i => [i.line, i.level]), [[3, 'error'], [4, 'warn']])
  assert.deepEqual(guessMapping(['question']).user, 0)
})

test('JSONL import accepts OpenAI messages format and flags bad lines', () => {
  const jsonl = [
    JSON.stringify({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], max_tokens: 40 }),
    'not json',
    JSON.stringify({ prompt: 'Return JSON', response_format: { type: 'json_object' } }),
  ].join('\n')
  assert.equal(detectFormat(jsonl, 'x.jsonl'), 'jsonl')
  const r = importPrompts(jsonl, 'x.jsonl')
  assert.equal(r.prompts.length, 2)
  assert.equal(r.prompts[0].system, 'Be brief.'); assert.equal(r.prompts[0].user, 'Hi'); assert.equal(r.prompts[0].maxTokens, 40)
  assert.equal(r.prompts[1].json, true)
  assert.deepEqual(r.issues, [{ line: 2, level: 'error', message: 'Not valid JSON; line skipped.' }])
})

test('result import round-trips an export, strips keys and rejects inconsistent timings', () => {
  const run = sampleRun()
  const back = importRun(exportRunJson(run), () => 'new').run!
  assert.equal(back.results.length, run.results.length)
  assert.equal(back.id, 'new')
  assert.deepEqual(back.endpoints.map(e => e.name), run.endpoints.map(e => e.name))
  const bad = JSON.stringify({ endpoints: [{ id: 'a', model: 'm', apiKey: 'sk-secret' }], results: [{ endpointId: 'a', promptId: 'p', ok: true, ttftMs: 500, totalMs: 100 }, { endpointId: 'zz', promptId: 'p', ok: true }, { endpointId: 'a', promptId: 'p', ok: false, status: 429 }] })
  const r = importRun(bad)
  assert.equal(JSON.stringify(r.run).includes('sk-secret'), false)
  assert.equal(r.run!.results.length, 1)
  assert.equal(r.run!.results[0].errorKind, 'rate_limit')
  assert.equal(r.issues.filter(i => i.level === 'error').length, 2)
  assert.equal(detectFormat(exportRunJson(run)), 'run')
})

test('share link compresses a run and decodes back to the same summary', async () => {
  const run = sampleRun()
  const s = await encodeShare(run)
  assert.match(s, /^[A-Za-z0-9_-]+$/)
  assert.ok(s.length < exportRunJson(run).length / 4)
  const back = importRun(await decodeShare(s)).run!
  assert.equal(back.results.length, run.results.length)
  assert.equal(back.results[0].chunks, undefined)
  assert.equal(leaderboard(back)[0].ttft!.p50, leaderboard(run)[0].ttft!.p50)
})

test('results CSV escapes fields and has one row per request', () => {
  const run = sampleRun()
  const csv = resultsCsv({ ...run, endpoints: [{ ...run.endpoints[0], name: 'A, "fast"' }, ...run.endpoints.slice(1)] }, decodeTps)
  const rows = parseCsv(csv)
  assert.equal(rows.length, run.results.length + 1)
  assert.equal(rows.find(r => r.cells[0].startsWith('A'))!.cells[0], 'A, "fast"')
})

test('sample data is deterministic, labelled synthetic and covers errors', () => {
  const a = sampleRun(), b = sampleRun()
  assert.deepEqual(a, b)
  assert.ok(a.label.includes('synthetic'))
  assert.ok(SAMPLE_ENDPOINTS.every(e => e.name.includes('synthetic')))
  assert.ok(a.results.some(r => r.errorKind === 'rate_limit'))
  assert.ok(SUITES.find(s => s.id === 'long')!.prompts[1].user.length > 40_000)
})

// ---------- Real HTTP: browser engine and the generated Node script against a local SSE server ----------

function sseServer(): Promise<{ server: Server; url: string; auth: string[] }> {
  const auth: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', async () => {
      auth.push(String(req.headers.authorization ?? ''))
      const j = JSON.parse(body)
      if (j.model === 'limited') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"rate limited"}}'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const w of ['alpha ', 'beta ', 'gamma']) { res.write(chunk(w)); await new Promise(r => setTimeout(r, 15)) }
      if (j.stream_options?.include_usage) res.write(usage(7, 3))
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => { const a = server.address() as { port: number }; r({ server, url: `http://127.0.0.1:${a.port}/v1`, auth }) }))
}

test('runBenchmark streams real HTTP SSE and records rate limits', async () => {
  const { server, url, auth } = await sseServer()
  try {
    const eps: Endpoint[] = [{ ...EP, id: 'ok', baseUrl: url }, { ...EP, id: 'rl', baseUrl: url, model: 'limited' }]
    const seen: number[] = []
    const { results } = await runBenchmark(eps, [P], { reps: 2, concurrency: 2, rampMs: 0, timeoutMs: 5000, temperature: 0 }, { keys: { ok: 'sk-test' }, onResult: (_r, d) => seen.push(d) })
    assert.equal(results.length, 4)
    const ok = results.filter(r => r.endpointId === 'ok')
    assert.ok(ok.every(r => r.ok && r.outputTokens === 3 && r.tokenSource === 'usage' && r.chunks!.length === 3 && r.totalMs! >= r.ttftMs! + 20))
    assert.ok(results.filter(r => r.endpointId === 'rl').every(r => r.errorKind === 'rate_limit'))
    assert.ok(auth.includes('Bearer sk-test') && auth.includes(''))
    assert.deepEqual(seen, [1, 2, 3, 4])
  } finally { server.close() }
})

test('generated Node script runs the benchmark from a terminal and its output imports cleanly', async () => {
  const { server, url, auth } = await sseServer()
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tb-'))
    const eps: Endpoint[] = [{ ...EP, name: 'My Local', baseUrl: url }]
    const src = nodeScript(eps, [P, { ...P, id: 'p2', json: true }], { reps: 2, concurrency: 2, rampMs: 10, timeoutMs: 5000, temperature: 0 }, { needsKey: () => true })
    assert.equal(src.includes('sk-'), false)
    assert.match(src, /export TB_KEY_MY_LOCAL_1=/)
    writeFileSync(join(dir, 'tb.mjs'), src)
    const out = join(dir, 'out.json')
    await new Promise<void>((res, rej) => execFile(process.execPath, [join(dir, 'tb.mjs'), out], { env: { ...process.env, TB_KEY_MY_LOCAL_1: 'sk-env' } }, e => e ? rej(e) : res()))
    const { run, issues } = importRun(readFileSync(out, 'utf8'))
    assert.deepEqual(issues, [])
    assert.equal(run!.source, 'node')
    assert.equal(run!.results.length, 4)
    assert.ok(run!.results.every(r => r.ok && r.outputTokens === 3 && r.ttftMs! > 0))
    assert.ok(auth.every(a => a === 'Bearer sk-env'))
  } finally { server.close() }
})

test('generated Node script refuses to run without the key environment variables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-'))
  writeFileSync(join(dir, 'tb.mjs'), nodeScript([{ ...EP, baseUrl: 'https://api.example.com/v1' }], [P], { reps: 1, concurrency: 1, rampMs: 0, timeoutMs: 1000, temperature: 0 }))
  const err = await new Promise<{ code: number | null; stderr: string }>(res => execFile(process.execPath, [join(dir, 'tb.mjs')], { env: { PATH: process.env.PATH } }, (e, _o, stderr) => res({ code: e ? (e as { code?: number }).code ?? 1 : 0, stderr })))
  assert.equal(err.code, 1)
  assert.match(err.stderr, /export TB_KEY_LOCAL_1=/)
})

test('synthetic replay transport streams recorded timings through the real request path', async () => {
  const { replayFetch, SAMPLE_PROMPTS } = await import('./sample.ts')
  const run = sampleRun()
  const f = replayFetch(run)
  const p = SAMPLE_PROMPTS[0]
  const ok = await streamChat(run.endpoints[0], '', p, 0, 0, { fetch: f })
  if (ok.ok) {
    assert.equal(ok.tokenSource, 'usage')
    assert.ok(ok.ttftMs! > 30 && ok.chunks!.length > 1)
  } else assert.equal(ok.errorKind, 'rate_limit')
  const net = await streamChat({ ...EP, baseUrl: 'https://unknown.example/v1' }, '', p, 0, 0, { fetch: f })
  assert.equal(net.errorKind, 'network')
})
