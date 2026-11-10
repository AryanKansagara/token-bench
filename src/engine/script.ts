// Generates a dependency-free Node script that runs the same benchmark from a terminal (no CORS there)
// and writes a result file the app imports. Keys come from environment variables, never from this file.
import { RUN_FORMAT } from './parse.ts'
import type { Endpoint, Prompt, RunConfig } from './types.ts'

export const keyEnvName = (e: Pick<Endpoint, 'name'>, i: number) => `TB_KEY_${(e.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'ENDPOINT')}_${i + 1}`

const BODY = String.raw`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const approx = s => { if (!s) return 0; const w = (s.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || []).length * 0.75; return Math.max(1, Math.round((s.length / 4 + w) / 2)) }
const url = b => { b = b.trim().replace(/\/+$/, ''); return /\/chat\/completions$/.test(b) ? b : b + '/chat/completions' }

async function one(ep, p, rep, startedAt) {
  const base = { endpointId: ep.id, promptId: p.id, rep, startedAt, ok: false }
  const key = process.env[ep.keyEnv] || ''
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CONFIG.config.timeoutMs)
  const t0 = performance.now(), chunks = []
  let text = '', reasoning = '', usage, streamError, buf = ''
  const messages = (p.system ? [{ role: 'system', content: p.system }] : []).concat([{ role: 'user', content: p.user }])
  const body = { model: ep.model, messages, stream: true, max_tokens: p.maxTokens, temperature: CONFIG.config.temperature }
  if (ep.streamOptions) body.stream_options = { include_usage: true }
  if (p.json) body.response_format = { type: 'json_object' }
  try {
    const res = await fetch(url(ep.baseUrl), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}), body: JSON.stringify(body), signal: ctrl.signal })
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).slice(0, 300)
      return Object.assign(base, { status: res.status, errorKind: res.status === 429 ? 'rate_limit' : 'http', error: 'HTTP ' + res.status + (t ? ': ' + t : ''), totalMs: performance.now() - t0 })
    }
    const dec = new TextDecoder()
    const onData = d => {
      if (d.trim() === '[DONE]') return
      let j; try { j = JSON.parse(d) } catch { streamError = 'Malformed stream chunk'; return }
      if (j.error) { streamError = typeof j.error === 'string' ? j.error : (j.error.message || 'Provider error'); return }
      let c = '', r = ''
      for (const ch of j.choices || []) { c += (ch.delta && ch.delta.content) || ch.text || ''; r += (ch.delta && (ch.delta.reasoning || ch.delta.reasoning_content)) || '' }
      if (c || r) { chunks.push(Math.round((performance.now() - t0) * 10) / 10); text += c; reasoning += r }
      if (j.usage) usage = j.usage
    }
    let data = []
    const line = l => { if (l === '') { if (data.length) onData(data.join('\n')); data = [] } else if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, '')) }
    for await (const piece of res.body) {
      buf += dec.decode(piece, { stream: true })
      const parts = buf.split(/\r\n|\n|\r/)
      buf = parts.pop()
      parts.forEach(line)
      if (streamError) break
    }
    line(buf); line('')
    const totalMs = performance.now() - t0
    if (streamError) return Object.assign(base, { status: res.status, errorKind: 'stream', error: streamError, totalMs })
    if (!chunks.length) return Object.assign(base, { status: res.status, errorKind: 'stream', error: 'Stream ended without content', totalMs })
    const exact = usage && usage.completion_tokens
    return Object.assign(base, { ok: true, status: res.status, ttftMs: chunks[0], totalMs, outputTokens: exact != null ? exact : approx(reasoning + text), inputTokens: (usage && usage.prompt_tokens) || approx((p.system || '') + p.user), tokenSource: exact != null ? 'usage' : 'approx', chunks, text: text.slice(0, 2000) })
  } catch (e) {
    const totalMs = performance.now() - t0
    if (ctrl.signal.aborted) return Object.assign(base, { errorKind: 'timeout', error: 'Timed out after ' + CONFIG.config.timeoutMs + ' ms', totalMs })
    return Object.assign(base, { errorKind: 'network', error: String(e && e.cause ? e.cause.message || e.cause : e), totalMs })
  } finally { clearTimeout(timer) }
}

const missing = CONFIG.endpoints.filter(e => e.needsKey && !process.env[e.keyEnv])
if (missing.length) { console.error('Set these environment variables first:\n' + missing.map(e => '  export ' + e.keyEnv + '=...   # ' + e.name).join('\n')); process.exit(1) }
const jobs = []
for (let rep = 0; rep < CONFIG.config.reps; rep++) for (const p of CONFIG.prompts) for (const ep of CONFIG.endpoints) jobs.push({ ep, p, rep })
const results = new Array(jobs.length)
const t0 = performance.now()
let next = 0, done = 0
const n = Math.max(1, Math.min(CONFIG.config.concurrency, jobs.length))
await Promise.all(Array.from({ length: n }, async (_, i) => {
  if (i && CONFIG.config.rampMs) await sleep(CONFIG.config.rampMs * i)
  for (;;) {
    const k = next++
    if (k >= jobs.length) return
    const j = jobs[k]
    const r = await one(j.ep, j.p, j.rep, Math.round(performance.now() - t0))
    results[k] = r
    done++
    console.error('[' + done + '/' + jobs.length + '] ' + j.ep.name + ' / ' + j.p.name + ': ' + (r.ok ? 'TTFT ' + Math.round(r.ttftMs) + ' ms, ' + r.outputTokens + ' tok in ' + Math.round(r.totalMs) + ' ms' : r.error))
  }
}))
const out = { format: FORMAT, version: 1, label: 'Terminal run ' + new Date().toISOString().slice(0, 16).replace('T', ' '), createdAt: Date.now(), source: 'node', config: CONFIG.config, endpoints: CONFIG.endpoints.map(({ keyEnv, needsKey, ...e }) => e), prompts: CONFIG.prompts, results, durationMs: Math.round(performance.now() - t0) }
const file = process.argv[2] || 'token-bench-results.json'
const { writeFileSync } = await import('node:fs')
writeFileSync(file, JSON.stringify(out))
console.error('Wrote ' + file + '. Import it in Token Bench under History.')
`

export function nodeScript(endpoints: Endpoint[], prompts: Prompt[], config: RunConfig, opts: { needsKey?: (e: Endpoint) => boolean } = {}): string {
  const eps = endpoints.map((e, i) => ({ ...e, keyEnv: keyEnvName(e, i), needsKey: opts.needsKey ? opts.needsKey(e) : !/localhost|127\.0\.0\.1/.test(e.baseUrl) }))
  const env = eps.filter(e => e.needsKey).map(e => `//   export ${e.keyEnv}=...   # ${e.name}`).join('\n')
  return `// Token Bench terminal runner. Node 18 or newer, no dependencies.
// Runs the same streamed benchmark as the browser (no CORS limits here) and writes a JSON result file.
//
// 1. Put your API keys in environment variables (this file never contains keys):
${env || '//   (no keys needed for these endpoints)'}
// 2. node token-bench.mjs results.json
// 3. In Token Bench, open History and import results.json.

const FORMAT = ${JSON.stringify(RUN_FORMAT)}
const CONFIG = ${JSON.stringify({ config, endpoints: eps, prompts }, null, 1)}
${BODY}`
}
