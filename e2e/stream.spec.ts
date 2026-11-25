import { addEndpoint, createBenchmark, expect, FAKE_KEY, latestRunResults, runBenchmark, tab, test } from './fixtures.ts'
import { OK_TOKENS, OK_TTFT_MS, type Scenario } from './stub.ts'

// One benchmark with one endpoint per stub scenario, run once from the Run tab, then every
// scenario's recorded result is checked, and the Results page is checked for what a reader sees.
const NAMES: Record<Exclude<Scenario, 'echo-key' | 'echo-stream'>, string> = {
  ok: 'Clean stream', nousage: 'No usage chunk', rate: 'Rate limited', unauthorized: 'Bad key', 'server-error': 'Server error',
  'midstream-error': 'Error mid stream', malformed: 'Malformed chunk', stall: 'Stalled stream', 'stall-headers': 'Never answers',
  'cut-reset': 'Connection reset', 'cut-eof': 'Ends early', 'done-only': 'Empty stream', html: 'HTML page', json: 'Not streamed',
}

type Named = keyof typeof NAMES
const MATRIX = (Object.keys(NAMES) as Named[]).filter(s => s !== 'cut-eof')

test.describe('streaming classification against an in-process stub', () => {
  test('records TTFT, tokens and classification for each way a provider can answer', async ({ page, stub }) => {
    test.setTimeout(180_000)
    await createBenchmark(page, 'Stub classification')
    // `cut-eof` has its own test below: it is a known bug, and would be ranked here.
    for (const [scenario, name] of MATRIX.map(s => [s, NAMES[s]] as const)) {
      await addEndpoint(page, { name, baseUrl: stub.baseUrl(scenario), key: scenario === 'ok' ? FAKE_KEY : undefined })
    }
    await runBenchmark(page, { timeoutMs: 1500, label: 'Stub run' })
    const { byName } = await latestRunResults(page)
    const one = (s: Named) => { const r = byName.get(NAMES[s]); expect(r, NAMES[s]).toHaveLength(1); return r![0] }

    // A clean stream: TTFT is the first content chunk (300 ms), not the first byte (the role-only chunk).
    const ok = one('ok')
    expect(ok.ok).toBe(true)
    expect(ok.ttftMs!).toBeGreaterThanOrEqual(OK_TTFT_MS - 20)
    // The stream keeps going for six chunks after the first token, so total is clearly later than TTFT.
    expect(ok.totalMs! - ok.ttftMs!).toBeGreaterThanOrEqual(100)
    expect(ok.outputTokens).toBe(OK_TOKENS)
    expect(ok.tokenSource).toBe('usage')
    expect(ok.chunks).toHaveLength(6)

    // No usage chunk: tokens are approximated and the result says so.
    const nu = one('nousage')
    expect(nu.ok).toBe(true)
    expect(nu.tokenSource).toBe('approx')
    expect(nu.outputTokens).toBeGreaterThan(0)

    expect(one('rate')).toMatchObject({ ok: false, status: 429, errorKind: 'rate_limit', error: 'HTTP 429: Rate limit exceeded: 3 requests per minute' })
    expect(one('unauthorized')).toMatchObject({ ok: false, status: 401, errorKind: 'http', error: 'HTTP 401: Invalid API key' })
    expect(one('server-error')).toMatchObject({ ok: false, status: 500, errorKind: 'http', error: 'HTTP 500: upstream exploded' })
    expect(one('midstream-error')).toMatchObject({ ok: false, errorKind: 'stream', error: 'model crashed mid-generation' })
    expect(one('malformed')).toMatchObject({ ok: false, errorKind: 'stream' })
    expect(one('malformed').error).toMatch(/^Malformed stream chunk/)

    // Stalls end at the configured timeout, with whatever was streamed discarded.
    for (const s of ['stall', 'stall-headers'] as const) {
      const r = one(s)
      expect(r, s).toMatchObject({ ok: false, errorKind: 'timeout', error: 'Timed out after 1500 ms' })
      expect(r.totalMs!).toBeGreaterThanOrEqual(1400)
      expect(r.ttftMs).toBeUndefined()
    }

    expect(one('cut-reset')).toMatchObject({ ok: false, errorKind: 'network' })
    expect(one('done-only')).toMatchObject({ ok: false, errorKind: 'stream', error: 'Stream finished without any content' })
    expect(one('html')).toMatchObject({ ok: false, errorKind: 'stream', error: 'Stream ended without content or [DONE]' })
    expect(one('json')).toMatchObject({ ok: false, errorKind: 'stream', error: 'Stream ended without content or [DONE]' })

    // What the stub received: a streaming chat completion, with the key only where one was entered.
    const sent = stub.requests('ok')[0]
    expect(sent.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(sent.body).toMatchObject({ model: 'stub-model', stream: true, stream_options: { include_usage: true } })
    expect(stub.requests('nousage')[0].authorization).toBeUndefined()

    // The Results page ranks only what worked and lists every failure with its kind.
    await tab(page, 'Results').click()
    const rows = page.locator('table.leader tbody tr')
    await expect(rows).toHaveCount(MATRIX.length)
    const rowOf = (name: string) => rows.filter({ has: page.getByText(name, { exact: true }) })

    // Two endpoints succeeded and are ranked; every other row has no rank and no timings.
    const ranked = await rows.evaluateAll(trs => trs.map(tr => tr.querySelector('td')!.textContent))
    expect(ranked.filter(r => r !== '–').sort()).toEqual(['1', '2'])
    for (const name of ['Rate limited', 'Bad key', 'Server error', 'Stalled stream', 'Never answers', 'Connection reset', 'Empty stream', 'HTML page', 'Not streamed']) {
      const cells = rowOf(name).locator('td')
      await expect(cells.nth(0), name).toHaveText('–')
      await expect(cells.nth(2), name).toHaveText('n/a')
      await expect(cells.nth(8), name).toHaveText('100%')
    }
    await expect(rowOf('Rate limited').locator('td').nth(9)).toHaveText('100%')
    await expect(rowOf('Bad key').locator('td').nth(9)).toHaveText('0%')

    // The error table names each failure's kind.
    await page.getByText(/^Errors \(\d+\)/).click()
    const errors = page.locator('details table tbody tr')
    const kind = (name: string) => errors.filter({ hasText: name }).locator('td').nth(2)
    await expect(kind('Rate limited')).toHaveText('429')
    await expect(kind('Bad key')).toHaveText('http')
    await expect(kind('Stalled stream')).toHaveText('timeout')
    await expect(kind('Never answers')).toHaveText('timeout')
    await expect(kind('Connection reset')).toHaveText('network')
    await expect(kind('Error mid stream')).toHaveText('stream')
  })

  // https://github.com/AryanKansagara/token-bench/issues/2
  test('a stream that ends early without [DONE] is a failure, not a result', async ({ page, stub }) => {
    test.fail(true, 'Known bug: a stream cut off cleanly after some content is recorded as a successful, fast request (https://github.com/AryanKansagara/token-bench/issues/2)')
    await createBenchmark(page, 'Cut off')
    await addEndpoint(page, { name: NAMES['cut-eof'], baseUrl: stub.baseUrl('cut-eof') })
    await runBenchmark(page, { timeoutMs: 1500 })
    const { byName } = await latestRunResults(page)
    expect(byName.get(NAMES['cut-eof'])![0]).toMatchObject({ ok: false })
  })
})
