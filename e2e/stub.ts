// In-process stub of an OpenAI-compatible streaming endpoint. It listens on 127.0.0.1 only, never
// forwards anything, and answers every request itself, so the suite can never reach a real provider.
//
// A scenario is the first path segment: POST /<scenario>/v1/chat/completions. Scenarios cover the
// ways a real provider answers: a clean stream, rate limits, HTTP errors, errors inside the stream,
// streams that stall, and streams that are cut off.
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export interface Seen { scenario: string; method: string; authorization?: string; body?: Record<string, unknown> }

export interface Stub {
  origin: string
  /** Base URL to give the app for a scenario, ending in /v1. */
  baseUrl(scenario: Scenario): string
  seen: Seen[]
  /** Requests recorded for one scenario. */
  requests(scenario: Scenario): Seen[]
  close(): Promise<void>
}

export const SCENARIOS = [
  'ok', 'nousage', 'rate', 'unauthorized', 'server-error', 'midstream-error', 'malformed',
  'stall', 'stall-headers', 'cut-reset', 'cut-eof', 'done-only', 'html', 'json', 'echo-key',
] as const
export type Scenario = typeof SCENARIOS[number]

/** Delay before the first content token in the `ok` scenarios, so TTFT is a known quantity. */
export const OK_TTFT_MS = 300
/** Tokens the `ok` scenario reports in its usage chunk. */
export const OK_TOKENS = 40

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const delta = (content: string) => sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
}

export async function startStub(): Promise<Stub> {
  const seen: Seen[] = []
  const sockets = new Set<Socket>()
  const timers = new Set<NodeJS.Timeout>()
  const later = (ms: number, f: () => void) => { const t = setTimeout(() => { timers.delete(t); f() }, ms); timers.add(t) }

  const server = http.createServer((req, res) => {
    const scenario = (req.url ?? '').split('/')[1] as Scenario
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return }
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body: Record<string, unknown> | undefined
      try { body = JSON.parse(raw) } catch { /* recorded as undefined */ }
      seen.push({ scenario, method: req.method ?? '', authorization: req.headers.authorization, body })
      respond(scenario, body, res, req.headers.authorization)
    })
  })

  function respond(scenario: Scenario, body: Record<string, unknown> | undefined, res: http.ServerResponse, authorization?: string) {
    const json = (status: number, payload: unknown, extra: Record<string, string> = {}) =>
      res.writeHead(status, { ...CORS, 'Content-Type': 'application/json', ...extra }).end(JSON.stringify(payload))
    const open = () => res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    // Streams a role-only chunk at once (first byte, no content), then `n` content chunks.
    const stream = (firstContentAfter: number, n: number, then: () => void) => {
      open()
      res.write(sse({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
      for (let i = 0; i < n; i++) later(firstContentAfter + i * 30, () => { if (!res.destroyed) res.write(delta(`word${i} `)) })
      later(firstContentAfter + n * 30 + 10, () => { if (!res.destroyed) then() })
    }
    const usageChunk = sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: OK_TOKENS, total_tokens: 12 + OK_TOKENS } })
    const finish = sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    switch (scenario) {
      case 'ok':
        return stream(OK_TTFT_MS, 6, () => { res.write(finish); if ((body?.stream_options as { include_usage?: boolean } | undefined)?.include_usage) res.write(usageChunk); res.end('data: [DONE]\n\n') })
      case 'nousage':
        return stream(OK_TTFT_MS, 6, () => { res.write(finish); res.end('data: [DONE]\n\n') })
      case 'rate':
        return json(429, { error: { message: 'Rate limit exceeded: 3 requests per minute', type: 'rate_limit_error' } }, { 'Retry-After': '20' })
      case 'unauthorized':
        return json(401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } })
      case 'server-error':
        return void res.writeHead(500, { ...CORS, 'Content-Type': 'text/plain' }).end('upstream exploded')
      case 'midstream-error':
        return stream(60, 2, () => res.end(sse({ error: { message: 'model crashed mid-generation' } })))
      case 'malformed':
        return stream(60, 2, () => res.end('data: {"choices":[{"delta":{"content":"cut\n\n'))
      case 'stall':
        // Two tokens, then silence on an open connection until the client gives up.
        return stream(60, 2, () => { /* never finishes */ })
      case 'stall-headers':
        // Accepts the request and never answers at all.
        return
      case 'cut-reset':
        // Content, then the connection is reset before the stream is complete.
        return stream(60, 3, () => res.socket?.destroy())
      case 'cut-eof':
        // Content, then a clean end of the response with no finish reason and no [DONE].
        return stream(60, 3, () => res.end())
      case 'done-only':
        open(); res.end('data: [DONE]\n\n'); return
      case 'html':
        return void res.writeHead(200, { ...CORS, 'Content-Type': 'text/html' }).end('<!doctype html><title>Sign in</title><p>Please sign in</p>')
      case 'json':
        // A server that ignores stream: true and answers with one JSON completion.
        return json(200, { choices: [{ index: 0, message: { role: 'assistant', content: 'one big answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } })
      case 'echo-key':
        // Some providers repeat the credential they were sent in their error text.
        return json(401, { error: { message: `Incorrect API key provided: ${authorization?.replace(/^Bearer /, '')}.` } })
      default:
        return json(404, { error: { message: `unknown stub scenario ${scenario}` } })
    }
  }

  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    baseUrl: s => `${origin}/${s}/v1`,
    seen,
    requests: s => seen.filter(x => x.scenario === s && x.method === 'POST'),
    close: () => new Promise<void>(r => {
      timers.forEach(clearTimeout)
      sockets.forEach(s => s.destroy())
      server.close(() => r())
    }),
  }
}
