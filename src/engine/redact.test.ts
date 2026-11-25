import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeShare, encodeShare, exportRunJson, importRun, resultsCsv } from './parse.ts'
import { cleanRun, hideKeys } from './redact.ts'
import { streamChat } from './request.ts'
import { nodeScript } from './script.ts'
import type { Endpoint, Prompt, Run } from './types.ts'

// Made-up strings. They are not credentials for anything.
const KEY = 'sk-test-MADEUP-0000-not-a-real-key-1234567890'
const RANDOM = 'Zq7/Yw+3.Rt9=Kp2Mn5Xc8Vb1'
const H = '[key hidden]'
const EP: Endpoint = { id: 'e', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', streamOptions: true }
const P: Prompt = { id: 'p', name: 'p', suite: 's', user: 'hi', maxTokens: 8 }

/** No 6 characters in a row of the key may survive. */
function assertGone(out: string, key = KEY) {
  for (let i = 0; i + 6 <= key.length; i++) assert.ok(!out.toLowerCase().includes(key.slice(i, i + 6).toLowerCase()), `"${key.slice(i, i + 6)}" left in: ${out}`)
}

test('hideKeys replaces the key and leaves the message readable', () => {
  assert.equal(hideKeys(`Incorrect API key provided: ${KEY}.`, [KEY]), `Incorrect API key provided: ${H}.`)
  assert.equal(hideKeys(`Got "Bearer ${KEY}", want another`, [KEY]), `Got "Bearer ${H}", want another`)
  assert.equal(hideKeys('HTTP 429: Rate limit exceeded: 3 requests per minute', [KEY]), 'HTTP 429: Rate limit exceeded: 3 requests per minute')
  assert.equal(hideKeys(`nothing here`, ['']), 'nothing here')
  assert.equal(hideKeys(`key ${KEY}`, [` ${KEY}\n`]), `key ${H}`)
})

test('hideKeys finds encoded, cased, broken-up, cut and masked copies', () => {
  for (const k of [KEY, RANDOM]) {
    const esc = [...k].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
    const pct = [...k].map(c => '%' + c.charCodeAt(0).toString(16)).join('')
    for (const s of [
      k.toUpperCase(), k.toLowerCase(), encodeURIComponent(k), encodeURIComponent(encodeURIComponent(k)), JSON.stringify(JSON.stringify(k)), k.replaceAll('/', '\\/'),
      esc, pct, pct.replaceAll('%', '%25'), esc.replaceAll('\\', '\\\\'), [...k].map(c => `&#${c.charCodeAt(0)};`).join(''), [...k].map(c => `&#x${c.charCodeAt(0).toString(16)};`).join(''),
      k.slice(0, 12) + '\n' + k.slice(12), [...k].join(' '), [...k].join('\u200b'), k.slice(0, 10), k.slice(5, 17), k.slice(-9),
    ]) {
      const out = hideKeys(`error for ${s} here`, [k])
      assert.ok(out.includes(H) && out.startsWith('error for '), `${s} -> ${out}`)
      assertGone(out, k)
    }
    for (const pre of ['', 'a', 'ab', 'Bearer ', 'user:', ':']) for (const enc of ['base64', 'base64url', 'hex'] as const) {
      const coded = Buffer.from(pre + k + (pre ? '' : '\n')).toString(enc)
      const out = hideKeys(`auth ${coded} rejected`, [k])
      assert.equal(out, `auth ${H} rejected`, `${enc} of "${pre}" + key`)
    }
  }
  for (const s of ['sk-te***7890', 'sk-****', '****7890', 'sk-test-…7890', 'sk-t...7890', 'sk-test-MADE****', 'sk-xxxxxxxx7890', 'sk-t[redacted]7890', 'sk•••••0', 'sk-t**00**7890', 'ending in 7890']) {
    const out = hideKeys(`Bad key: ${s}`, [KEY])
    assert.ok(!/7890|sk-t/.test(out) && out.includes(H), `${s} -> ${out}`)
  }
  for (let n = 4; n < KEY.length; n++) assert.equal(hideKeys(`provided: ${KEY.slice(0, n)}`, [KEY]), `provided: ${H}`)
})

test('hideKeys does not damage ordinary messages or shout over short keys', () => {
  const plain = ['Model gpt-oss-120b is overloaded... try again', 'max_tokens must be <= 32768', '50% of quota used (%d)', 'see https://docs.example.com/errors#rate-limits', 'a ** b **bold** xxx', 'C:\\users\\x &amp; more', '']
  for (const s of plain) { assert.equal(hideKeys(s, [KEY, RANDOM]), s); assert.equal(hideKeys(s, [], true), s) }
  assert.equal(hideKeys('the latest test failed', ['test']), `the latest ${H} failed`)
  assert.equal(hideKeys('a key is needed', ['a', 'k']), 'a key is needed')
})

test('with guess, text that looks like somebody else’s key is hidden; ordinary identifiers are not', () => {
  for (const s of ['sk-or-v1-abc123abc123abc123', 'gsk_ABCdef123456ghi', 'csk-abc123def456ghi789', 'Bearer abc123def456ghi789', 'Incorrect API key provided: 0123456789abcdef0123']) {
    const out = hideKeys(`HTTP 401: ${s}.`, [], true)
    assert.ok(out.includes(H) && !/123/.test(out), out)
  }
  for (const s of ['request req_011CQabcDEF123456', 'model openai/gpt-oss-120b', 'keyboard-layout-number-2-x', 'Bearer authentication is required', 'token limit is 131072'])
    assert.equal(hideKeys(s, [], true), s)
})

const reply = (body: string, status = 200) => (async () => new Response(body, { status })) as typeof fetch

test('streamChat never returns the key, whichever way the provider repeats it', async () => {
  const bodies: [string, number][] = [
    [JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}.` } }), 401],
    ['x'.repeat(280) + KEY, 500],
    ['x'.repeat(20_000 - 10) + KEY, 500],
    [`<html>${KEY.split('').map(c => `&#${c.charCodeAt(0)};`).join('')}</html>`, 403],
    [JSON.stringify({ error: KEY }), 429],
    [JSON.stringify({ message: [KEY] }), 400],
    [`data: ${JSON.stringify({ error: { message: `bad ${KEY}` } })}\n\n`, 200],
    [`data: ${JSON.stringify({ error: { message: { nested: KEY } } })}\n\n`, 200],
    [`data: ${'y'.repeat(100)}${KEY}\n\n`, 200],
    [`data: ${JSON.stringify({ choices: [{ delta: { content: 'You sent ' + KEY.slice(0, 20) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: KEY.slice(20) }, finish_reason: 'stop' }], usage: { completion_tokens: KEY, prompt_tokens: { a: KEY } } })}\n\ndata: [DONE]\n\n`, 200],
  ]
  for (const [body, status] of bodies) assertGone(JSON.stringify(await streamChat(EP, KEY, P, 0, 0, { fetch: reply(body, status) })))
  const thrown = await streamChat(EP, KEY, P, 0, 0, { fetch: (async () => { throw new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value.`) }) as typeof fetch })
  assertGone(JSON.stringify(thrown))
  const long = await streamChat(EP, KEY, P, 0, 0, { keepText: 30, fetch: reply(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Your key, for reference, is ' + KEY }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) })
  assertGone(long.text!)
})

const run = (): Run => ({
  id: 'r', label: 'Old run', createdAt: 1, source: 'browser', config: { reps: 1, concurrency: 1, rampMs: 0, timeoutMs: 1000, temperature: 0 }, endpoints: [EP], prompts: [P],
  results: [
    { endpointId: 'e', promptId: 'p', rep: 0, startedAt: 0, ok: false, status: 401, errorKind: 'http', error: `HTTP 401: Incorrect API key provided: ${KEY}.` },
    { endpointId: 'e', promptId: 'p', rep: 1, startedAt: 0, ok: true, ttftMs: 1, totalMs: 2, chunks: [1, 2], text: `You sent ${KEY}` },
    { endpointId: 'e', promptId: 'p', rep: 2, startedAt: 0, ok: true, ttftMs: 1, totalMs: 2, chunks: [1, 2], text: 'fine' },
  ],
})

test('a run saved by an older version is cleaned, keeping everything else', () => {
  const old = run(), c = cleanRun(old, [KEY])
  assertGone(JSON.stringify(c))
  assert.equal(c.results[0].error, `HTTP 401: Incorrect API key provided: ${H}.`)
  assert.equal(c.results[2], old.results[2])
  assert.equal(cleanRun(c, [KEY]), c)
  // The key is no longer stored: the error is still recognised, generated text is left as it is.
  assertGone(cleanRun(old).results[0].error!)
  assert.equal(cleanRun({ results: null } as unknown as Run, [KEY]).results, null)
  assert.doesNotThrow(() => cleanRun({ results: [null, 3, { error: { a: KEY } }] } as unknown as Run, [KEY]))
})

test('exports, share links and imports hide a key in error text even if the run was never cleaned', async () => {
  const r = run()
  r.results = r.results.slice(0, 1)
  assertGone(exportRunJson(r)); assertGone(resultsCsv(r, () => null)); assertGone(await decodeShare(await encodeShare(r)))
  r.results[0].error = 'x'.repeat(380) + ' ' + KEY
  assertGone(JSON.stringify(importRun(JSON.stringify(r)).run))
})

test('the terminal script neither prints nor writes a key the provider repeats', async () => {
  const server = createServer((req, res) => {
    req.resume()
    const key = String(req.headers.authorization ?? '').replace('Bearer ', '')
    if (req.url!.startsWith('/stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ error: { message: `bad ${key}` } })}\n\n`) }
    else { res.writeHead(401); res.end('x'.repeat(280) + JSON.stringify({ error: { message: key } })) }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const dir = mkdtempSync(join(tmpdir(), 'tb-redact-'))
  try {
    const eps = ['/http/v1', '/stream/v1', '/http/v1'].map((u, i) => ({ ...EP, id: `e${i}`, name: `E${i}`, baseUrl: origin + u }))
    writeFileSync(join(dir, 'tb.mjs'), nodeScript(eps, [P], { reps: 1, concurrency: 1, rampMs: 0, timeoutMs: 5000, temperature: 0 }))
    // The last key has a line break inside, which Node rejects with a message that quotes the whole header.
    const env = { PATH: process.env.PATH, TB_KEY_E0_1: KEY, TB_KEY_E1_2: KEY, TB_KEY_E2_3: KEY.slice(0, 20) + '\n' + KEY.slice(20) }
    const stderr = await new Promise<string>((res, rej) => execFile(process.execPath, [join(dir, 'tb.mjs'), join(dir, 'out.json')], { env }, (e, _o, err) => e ? rej(e) : res(err)))
    const out = readFileSync(join(dir, 'out.json'), 'utf8')
    assertGone(stderr); assertGone(out)
    assert.equal(JSON.parse(out).results[1].error, `bad ${H}`)
    assert.match(JSON.parse(out).results[0].error, /^HTTP 401: x/)
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }) }
})
