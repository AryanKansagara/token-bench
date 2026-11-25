import { deflateRawSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { addEndpoint, copied, createBenchmark, expect, idbDump, runBenchmark, tab, test } from './fixtures.ts'
import type { Stub } from './stub.ts'

const encode = (o: unknown) => deflateRawSync(Buffer.from(JSON.stringify(o))).toString('base64url')

const sharedRun = (over: Record<string, unknown> = {}) => ({
  format: 'token-bench-run', version: 1, label: 'Shared run', source: 'node', createdAt: Date.UTC(2026, 10, 1),
  config: { reps: 1, concurrency: 1, rampMs: 0, timeoutMs: 30000, temperature: 0 },
  endpoints: [{ id: 'e1', name: 'Their server', baseUrl: 'http://their.example/v1', model: 'm1', streamOptions: true }],
  prompts: [{ id: 'p1', name: 'Greeting', suite: 'Mine', user: 'Say hello', maxTokens: 32 }],
  results: [{ endpointId: 'e1', promptId: 'p1', rep: 0, startedAt: 0, ok: true, status: 200, ttftMs: 120, totalMs: 520, outputTokens: 32, tokenSource: 'usage' }],
  ...over,
})

async function shareLinkFromRun(page: Page, stub: Stub) {
  await createBenchmark(page, 'Shared benchmark')
  await addEndpoint(page, { name: 'Fast stub', baseUrl: stub.baseUrl('ok') })
  await addEndpoint(page, { name: 'Limited stub', baseUrl: stub.baseUrl('rate') })
  await runBenchmark(page, { reps: 2, timeoutMs: 5000, label: 'Share me' })
  await tab(page, 'Results').click()
  const table = page.locator('table.leader')
  await expect(table).toBeVisible()
  const leaderboard = await table.innerText()
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect(page.getByText(/^Share link copied/)).toBeVisible()
  return { link: await copied(page), leaderboard }
}

test.describe('share links', () => {
  test('a link restores the results for someone with an empty browser, errors included', async ({ page, stub, browser, watch, baseURL }) => {
    const { link, leaderboard } = await shareLinkFromRun(page, stub)
    expect(link.startsWith(`${baseURL}/app/share#r=`)).toBe(true)

    const other = await browser.newContext()
    await watch(other)
    const friend = await other.newPage()
    await friend.goto(link)
    await expect(friend.getByRole('heading', { name: 'Shared benchmark result' })).toBeVisible()
    await expect(friend.getByText('Share me: 4 requests across 2 endpoints and 1 prompts')).toBeVisible()
    await expect(friend.getByText('Validation passed: no issues.')).toBeVisible()
    await friend.getByRole('button', { name: 'Add to history' }).click()

    await expect(friend).toHaveURL(/\/app\/p\/[\w-]+\/overview\?run=/)
    await expect(friend.getByRole('textbox', { name: 'Benchmark name' })).toHaveValue('Shared: Share me')
    const restored = await friend.locator('table.leader').innerText()
    expect(restored).toBe(leaderboard)
    await expect(friend.getByText(/^Errors \(2\)/)).toBeVisible()

    // The recipient has data but no key, and the shared run kept its rate limit.
    const stored = await idbDump(friend)
    expect(stored.keys).toEqual({})
    expect(stored.projects[0].runs[0].results.filter(r => r.errorKind === 'rate_limit')).toHaveLength(2)
    await other.close()
  })

  test('a link can be added to an existing benchmark', async ({ page, stub }) => {
    const { link } = await shareLinkFromRun(page, stub)
    await page.goto(link)
    await page.getByLabel('Add to').selectOption({ label: 'Shared benchmark' })
    await page.getByRole('button', { name: 'Add to history' }).click()
    await expect(page).toHaveURL(/\/overview\?run=/)
    await tab(page, 'History').click()
    const labels = page.getByRole('textbox', { name: 'Run label' })
    await expect(labels).toHaveCount(2)
    expect(await labels.evaluateAll(els => els.map(e => (e as HTMLInputElement).value))).toEqual(['Share me', 'Share me'])
    expect((await idbDump(page)).projects).toHaveLength(1)
  })

  for (const [what, hash, message] of [
    ['truncated', (l: string) => l.slice(0, Math.floor(l.length / 2)), /damaged or truncated|Invalid JSON|Missing/],
    ['not compressed data', () => 'AAAAAAAAAAAAAAAA', /damaged or truncated/],
    ['valid data, wrong shape', () => encode({ hello: 'world' }), /Missing "endpoints" or "results"/],
    ['valid shape, no usable results', () => encode(sharedRun({ results: [] })), /No usable results/],
  ] as const) {
    test(`a ${what} link says so and adds nothing`, async ({ page }) => {
      const full = encode(sharedRun())
      await page.goto(`/app/share#r=${hash(full)}`)
      await expect(page.getByRole('heading', { name: 'Shared benchmark result' })).toBeVisible()
      await expect(page.getByText('Nothing could be imported.')).toBeVisible()
      await expect(page.getByRole('list', { name: 'Validation report' })).toContainText(message)
      await expect(page.getByRole('button', { name: 'Add to history' })).toHaveCount(0)
      expect((await idbDump(page)).projects).toHaveLength(0)
    })
  }

  test('markup in a shared run is shown as text and never runs', async ({ page }) => {
    const evil = sharedRun({ label: '<img src=x onerror="window.__xss=1">Run' })
    evil.endpoints[0].name = '<svg onload="window.__xss=2">Lab'
    await page.goto(`/app/share#r=${encode(evil)}`)
    await expect(page.getByText('<img src=x onerror="window.__xss=1">Run: 1 requests')).toBeVisible()
    await page.getByRole('button', { name: 'Add to history' }).click()
    await expect(page.locator('table.leader')).toContainText('<svg onload="window.__xss=2">Lab')
    await expect(page.locator('main img, main svg[onload]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  })

  // https://github.com/AryanKansagara/token-bench/issues/4
  test('opening a second link in the same tab shows the second link', async ({ page }) => {
    await page.goto(`/app/share#r=${encode(sharedRun({ label: 'First link' }))}`)
    await expect(page.getByText('First link: 1 requests')).toBeVisible()
    await page.goto(`/app/share#r=${encode(sharedRun({ label: 'Second link' }))}`)
    await expect(page.getByText('Second link: 1 requests')).toBeVisible()
    await expect(page.getByText('First link')).toHaveCount(0)
    // Back and forward follow the address too, a damaged link replaces a good one, and what is added is what is shown.
    await page.goBack()
    await expect(page.getByText('First link: 1 requests')).toBeVisible()
    await page.goto('/app/share#r=AAAAAAAAAAAAAAAA')
    await expect(page.getByText(/damaged or truncated/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add to history' })).toHaveCount(0)
    await page.goto(`/app/share#r=${encode(sharedRun({ label: 'Second link' }))}`)
    await expect(page.getByText('Second link: 1 requests')).toBeVisible()
    await page.getByRole('button', { name: 'Add to history' }).click()
    await expect(page).toHaveURL(/\/overview\?run=/)
    expect((await idbDump(page)).projects.flatMap(p => p.runs.map(r => r.label))).toEqual(['Second link'])
  })

  test('a file chosen on the page stays when the address does not change, and no fragment is not an error', async ({ page }) => {
    await page.goto('/app/share')
    await expect(page.getByText('Or open a share link someone sent you.')).toBeVisible()
    await page.locator('input[type=file]').setInputFiles({ name: 'r.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sharedRun({ label: 'From a file' }))) })
    await expect(page.getByText('From a file: 1 requests')).toBeVisible()
    await expect(page.getByText(/damaged or truncated/)).toHaveCount(0)
  })

  // https://github.com/AryanKansagara/token-bench/issues/4
  test('"Skip to content" keeps the shared result on screen', async ({ page }) => {
    await page.goto(`/app/share#r=${encode(sharedRun({ label: 'Kept' }))}`)
    await expect(page.getByText('Kept: 1 requests')).toBeVisible()
    await page.getByRole('link', { name: 'Skip to content' }).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#main$/)
    await expect(page.getByText('Kept: 1 requests')).toBeVisible()
    await expect(page.getByText(/damaged or truncated/)).toHaveCount(0)
    await page.reload()
    await expect(page.getByText('Or open a share link someone sent you.')).toBeVisible()
  })

  for (const hash of ['#r=', '#foo', '#R=abc', '#r=%25'])
    test(`a link with no usable payload (${hash}) says it is damaged`, async ({ page }) => {
      await page.goto(`/app/share${hash}`)
      await expect(page.getByText(/damaged or truncated/)).toBeVisible()
      await expect(page.getByText('Nothing could be imported.')).toBeVisible()
    })
})
