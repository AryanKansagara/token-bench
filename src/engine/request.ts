// One streamed chat completion, timed. Transport and clock are injectable so the runner is testable.
import { cleanResult, keyHider } from './redact.ts'
import { approxTokens, createSseParser, parseChatData } from './sse.ts'
import type { Endpoint, Prompt, RequestResult } from './types.ts'

export interface RequestOpts {
  fetch?: typeof fetch
  now?: () => number
  signal?: AbortSignal
  timeoutMs?: number
  temperature?: number
  /** Characters of generated text to keep on the result. */
  keepText?: number
}

export const chatUrl = (baseUrl: string) => {
  const b = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`
}

export function requestBody(ep: Endpoint, p: Prompt, temperature = 0) {
  const messages = [...(p.system ? [{ role: 'system', content: p.system }] : []), { role: 'user', content: p.user }]
  return {
    model: ep.model,
    messages,
    stream: true,
    max_tokens: p.maxTokens,
    temperature,
    ...(ep.streamOptions ? { stream_options: { include_usage: true } } : {}),
    ...(p.json ? { response_format: { type: 'json_object' } } : {}),
  }
}

/** The key never leaves this function except in the request: provider text that repeats it is cleaned first. */
export async function streamChat(ep: Endpoint, apiKey: string, p: Prompt, rep: number, startedAt: number, o: RequestOpts = {}): Promise<RequestResult> {
  return cleanResult(await stream(ep, apiKey, p, rep, startedAt, o), [apiKey])
}

async function stream(ep: Endpoint, apiKey: string, p: Prompt, rep: number, startedAt: number, o: RequestOpts): Promise<RequestResult> {
  // Text is cleaned before it is cut to length, so a cut cannot leave half a key behind.
  const hideKey = keyHider([apiKey])
  const hide = (s: unknown) => hideKey(String(s).slice(0, 20_000))
  const f = o.fetch ?? fetch
  const now = o.now ?? (() => performance.now())
  const base: RequestResult = { endpointId: ep.id, promptId: p.id, rep, startedAt, ok: false }
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  o.signal?.addEventListener('abort', onAbort)
  let timedOut = false
  const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; ctrl.abort() }, o.timeoutMs) : undefined
  const t0 = now()
  const chunks: number[] = []
  let text = ''
  let reasoning = ''
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
  let streamError: string | undefined
  let sawDone = false
  let finished = false
  let status: number | undefined
  try {
    const res = await f(chatUrl(ep.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(requestBody(ep, p, o.temperature)),
      signal: ctrl.signal,
    })
    status = res.status
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      let message = body
      try { const j = JSON.parse(body); message = j.error?.message ?? j.message ?? j.error ?? message } catch { /* plain text body */ }
      return { ...base, status: res.status, errorKind: res.status === 429 ? 'rate_limit' : 'http', error: `HTTP ${res.status}${message ? `: ${hide(message).slice(0, 300)}` : ''}`, totalMs: now() - t0 }
    }
    if (!res.body) return { ...base, status: res.status, errorKind: 'stream', error: 'Response had no body to stream', totalMs: now() - t0 }
    const parser = createSseParser(ev => {
      const d = parseChatData(ev.data, hide)
      if (d.done) { sawDone = true; return }
      if (d.finishReason) finished = true
      if (d.error) { streamError = hide(d.error); return }
      if (d.content || d.reasoning) {
        chunks.push(now() - t0)
        text += d.content
        reasoning += d.reasoning
      }
      if (d.usage) usage = d.usage
    })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(dec.decode(value, { stream: true }))
      if (streamError) { void reader.cancel(); break }
    }
    parser.push(dec.decode())
    parser.end()
    const totalMs = now() - t0
    if (streamError) return { ...base, status: res.status, errorKind: 'stream', error: streamError, totalMs, chunks }
    if (!chunks.length) return { ...base, status: res.status, errorKind: 'stream', error: sawDone ? 'Stream finished without any content' : 'Stream ended without content or [DONE]', totalMs }
    // Some servers omit [DONE] but send a finish reason. With neither, something closed the stream early and its timings are not a result.
    if (!sawDone && !finished) return { ...base, status: res.status, errorKind: 'stream', error: `Stream ended before [DONE], after ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`, totalMs, chunks }
    const exact = usage?.completion_tokens
    return {
      ...base, ok: true, status: res.status, ttftMs: chunks[0], totalMs,
      outputTokens: exact ?? approxTokens(reasoning + text),
      inputTokens: usage?.prompt_tokens ?? approxTokens((p.system ?? '') + p.user),
      tokenSource: exact !== undefined ? 'usage' : 'approx',
      chunks: chunks.map(c => Math.round(c * 10) / 10),
      text: hide(text).slice(0, o.keepText ?? 2000),
    }
  } catch (e) {
    const totalMs = now() - t0
    if (timedOut) return { ...base, errorKind: 'timeout', error: `Timed out after ${o.timeoutMs} ms`, totalMs }
    if (o.signal?.aborted) return { ...base, errorKind: 'aborted', error: 'Cancelled', totalMs }
    // The provider answered, so neither CORS nor the address is the problem: the connection broke while reading.
    if (status !== undefined) return { ...base, status, errorKind: 'stream', error: chunks.length ? `Connection lost mid-stream after ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}` : 'Connection lost after the provider answered, before any content', totalMs, chunks }
    // Browsers report CORS refusals, DNS failures and resets before the reply as the same opaque TypeError.
    return { ...base, errorKind: 'network', error: e instanceof Error ? e.message : String(e), totalMs }
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
}
