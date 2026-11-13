// Provider-specific stream shapes and preset metadata. The streams are excerpts written to match
// each provider's documented chunk layout for gpt-oss-120b; the Cerebras model list is a trimmed
// copy of the real public response from https://api.cerebras.ai/public/v1/models (2026-11-13).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseChatData } from './sse.ts'
import { streamChat } from './request.ts'
import { parseModelList, PRESETS } from './suites.ts'
import type { Endpoint, Prompt } from './types.ts'

const EP: Endpoint = { id: 'e', name: 'E', baseUrl: 'https://api.example.test/v1', model: 'gpt-oss-120b', streamOptions: true }
const P: Prompt = { id: 'p', name: 'P', suite: 's', user: 'hi', maxTokens: 64 }
const fetchOf = (body: string, status = 200) => (async () => new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch
const sse = (...objs: unknown[]) => objs.map(o => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('')

test('Cerebras gpt-oss stream: reasoning then content, usage and time_info on the final chunk', async () => {
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1763000000, model: 'gpt-oss-120b', system_fingerprint: 'fp_1' }
  const body = sse(
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { ...base, choices: [{ index: 0, delta: { reasoning: 'User wants a greeting.' } }] },
    { ...base, choices: [{ index: 0, delta: { content: 'Hello there' } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 91, completion_tokens: 12, prompt_tokens: 79, prompt_tokens_details: { cached_tokens: 0 } }, time_info: { queue_time: 0.0002, prompt_time: 0.003, completion_time: 0.006, total_time: 0.011, created: 1763000000 } },
    '[DONE]')
  const r = await streamChat(EP, 'k', P, 0, 0, { fetch: fetchOf(body) })
  assert.equal(r.ok, true)
  assert.equal(r.outputTokens, 12); assert.equal(r.inputTokens, 79); assert.equal(r.tokenSource, 'usage')
  assert.equal(r.chunks!.length, 2, 'reasoning and content chunks both count as generated output')
  assert.equal(r.text, 'Hello there')
})

test('Groq usage inside x_groq is read even without stream_options', async () => {
  const d = parseChatData(JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion.chunk', model: 'openai/gpt-oss-120b', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { id: 'req_01', usage: { queue_time: 0.01, prompt_tokens: 80, prompt_time: 0.004, completion_tokens: 33, completion_time: 0.07, total_tokens: 113, total_time: 0.074 } } }))
  assert.equal(d.usage?.completion_tokens, 33)
  assert.equal(d.usage?.prompt_tokens, 80)
  const r = await streamChat({ ...EP, streamOptions: false }, 'k', P, 0, 0, { fetch: fetchOf(sse({ choices: [{ index: 0, delta: { content: 'ok' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { id: 'req_01', usage: { prompt_tokens: 5, completion_tokens: 7 } } }, '[DONE]')) })
  assert.equal(r.tokenSource, 'usage'); assert.equal(r.outputTokens, 7)
})

test('a top-level usage object wins over x_groq when both are present', () => {
  const d = parseChatData(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 }, x_groq: { usage: { prompt_tokens: 9, completion_tokens: 9 } } }))
  assert.equal(d.usage?.completion_tokens, 2)
})

test('OpenRouter keep-alive comments are ignored and the usage-only final chunk is read', async () => {
  const body = ': OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n' + sse(
    { id: 'gen-1', provider: 'Cerebras', model: 'openai/gpt-oss-120b', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning: 'Thinking.' }, finish_reason: null }] },
    { id: 'gen-1', provider: 'Cerebras', model: 'openai/gpt-oss-120b', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.', reasoning: null }, finish_reason: 'stop' }] },
    { id: 'gen-1', provider: 'Cerebras', model: 'openai/gpt-oss-120b', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 70, completion_tokens: 20, total_tokens: 90, cost: 0.0000225 } },
    '[DONE]')
  const r = await streamChat(EP, 'k', P, 0, 0, { fetch: fetchOf(body) })
  assert.equal(r.ok, true)
  assert.equal(r.outputTokens, 20)
  assert.equal(r.text, 'Done.')
})

test('OpenRouter mid-stream error (finish_reason error) fails the request with the provider message', async () => {
  const body = sse({ choices: [{ index: 0, delta: { content: 'Partial' } }] }, { object: 'chat.completion.chunk', error: { code: 'server_error', message: 'Provider disconnected' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })
  const r = await streamChat(EP, 'k', P, 0, 0, { fetch: fetchOf(body) })
  assert.equal(r.ok, false); assert.equal(r.errorKind, 'stream'); assert.equal(r.error, 'Provider disconnected')
})

test('Fireworks reasoning_content counts toward approximate output tokens', async () => {
  const r = await streamChat({ ...EP, streamOptions: false }, 'k', P, 0, 0, { fetch: fetchOf(sse({ choices: [{ index: 0, delta: { reasoning_content: 'The user asks something simple so I answer briefly.' } }] }, { choices: [{ index: 0, delta: { content: 'Yes.' }, finish_reason: 'stop' }] }, '[DONE]')) })
  assert.equal(r.tokenSource, 'approx')
  assert.ok(r.outputTokens! >= 10, `expected reasoning to be counted, got ${r.outputTokens}`)
  assert.equal(r.text, 'Yes.')
})

test('Cerebras 401 body shape (no error wrapper) surfaces the message', async () => {
  const r = await streamChat(EP, 'bad', P, 0, 0, { fetch: fetchOf(JSON.stringify({ message: 'Wrong API Key', type: 'invalid_request_error', param: 'api_key', code: 'wrong_api_key' }), 401) })
  assert.equal(r.status, 401); assert.equal(r.errorKind, 'http'); assert.equal(r.error, 'HTTP 401: Wrong API Key')
})

test('Together 401 body with nested error object surfaces the nested message', async () => {
  const r = await streamChat(EP, '', P, 0, 0, { fetch: fetchOf(JSON.stringify({ id: 'x', error: { message: 'Missing API key.', type: 'invalid_request_error' } }), 401) })
  assert.equal(r.error, 'HTTP 401: Missing API key.')
})

test('parseModelList reads the real Cerebras public model list and converts per-token prices to per 1M', () => {
  const list = parseModelList(JSON.parse(readFileSync(new URL('./fixtures/cerebras-models-2026-11-13.json', import.meta.url), 'utf8')))
  const oss = list.find(m => m.id === 'gpt-oss-120b')
  assert.ok(oss)
  assert.equal(oss.inputPrice, 0.35); assert.equal(oss.outputPrice, 0.75)
  assert.ok(list.every(m => m.id && m.name))
})

test('parseModelList skips deprecated and malformed entries and tolerates missing pricing', () => {
  const list = parseModelList({ data: [{ id: 'a', pricing: { prompt: '0.00000015', completion: '0.0000006' } }, { id: 'old', deprecated: true }, { name: 'no id' }, { id: 'free', pricing: { prompt: '0', completion: '0' } }, { id: 'odd', pricing: { prompt: '-1', completion: 'n/a' } }] })
  assert.deepEqual(list, [{ id: 'a', name: 'a', inputPrice: 0.15, outputPrice: 0.6 }, { id: 'free', name: 'free', inputPrice: 0, outputPrice: 0 }, { id: 'odd', name: 'odd' }])
  assert.deepEqual(parseModelList({ error: 'x' }), [])
  assert.deepEqual(parseModelList(null), [])
})

test('hosted presets all default to gpt-oss-120b with prices, and only Cerebras hides error replies', () => {
  const hosted = PRESETS.filter(p => p.cors !== 'local')
  assert.equal(hosted.length, 5)
  for (const p of hosted) {
    assert.match(p.model, /gpt-oss-120b$/, p.id)
    assert.ok(p.inputPrice! > 0 && p.outputPrice! > p.inputPrice!, p.id)
    assert.match(p.baseUrl, /^https:\/\/.+\/v1$/, p.id)
  }
  assert.deepEqual(PRESETS.filter(p => p.errorsVisible === false).map(p => p.id), ['cerebras'])
  assert.ok(PRESETS.every(p => !/llama-3\.3-70b/i.test(p.model)), 'retired Llama 3.3 70B ids must not be defaults')
})
