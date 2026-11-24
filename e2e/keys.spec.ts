import { inflateRawSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { addEndpoint, copied, createBenchmark, downloadText, expect, FAKE_KEY, idbDump, runBenchmark, tab, test } from './fixtures.ts'
import type { Stub } from './stub.ts'

const urlSafeToJson = (hash: string) => inflateRawSync(Buffer.from(hash.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString('utf8')

async function benchmarkWithKey(page: Page, stub: Stub, scenario: 'ok' | 'echo-key') {
  await createBenchmark(page, 'Key handling')
  await addEndpoint(page, { name: 'Keyed endpoint', baseUrl: stub.baseUrl(scenario), key: FAKE_KEY })
  await runBenchmark(page, { timeoutMs: 5000, label: 'Keyed run' })
}

test.describe('API keys stay on the device', () => {
  test('a made-up key is sent to its endpoint and appears in no stored project, export, share link, report or script', async ({ page, stub }) => {
    await benchmarkWithKey(page, stub, 'ok')

    // Sent to the endpoint it belongs to, as a bearer token.
    expect(stub.requests('ok')[0].authorization).toBe(`Bearer ${FAKE_KEY}`)

    // The key store is the only place it lives.
    const { projects, keys } = await idbDump(page)
    expect(Object.values(keys)).toEqual([FAKE_KEY])
    expect(JSON.stringify(projects)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(projects)).not.toContain('MADEUP')
    const state = await page.context().storageState()
    expect(JSON.stringify(state)).not.toContain('MADEUP')

    // Exports, share link, generated script and printable report.
    await tab(page, 'Results').click()
    const csv = await downloadText(page, () => page.getByRole('button', { name: 'CSV', exact: true }).click())
    const json = await downloadText(page, () => page.getByRole('button', { name: 'JSON', exact: true }).click())
    expect(csv.name).toMatch(/\.csv$/); expect(csv.text.split('\n')[0]).toContain('endpoint,model,base_url')
    expect(json.name).toMatch(/\.json$/); expect(JSON.parse(json.text).format).toBe('token-bench-run')

    await page.getByRole('button', { name: 'Copy share link' }).click()
    await expect(page.getByText(/^Share link copied/)).toBeVisible()
    const link = await copied(page)
    expect(link).toMatch(/\/app\/share#r=[\w-]+$/)
    const shared = urlSafeToJson(link.split('#r=')[1])
    expect(JSON.parse(shared).results).toHaveLength(1)

    await tab(page, 'Run').click()
    const script = await downloadText(page, () => page.getByRole('button', { name: 'Download token-bench.mjs' }).click())
    expect(script.text).toContain('TB_KEY_KEYED_ENDPOINT_1')

    for (const [what, text] of [['CSV', csv.text], ['JSON', json.text], ['share link', link + shared], ['script', script.text]] as const) {
      expect(text, what).not.toContain(FAKE_KEY)
      expect(text, what).not.toContain('MADEUP')
    }

    await page.goto(page.url().replace(/\/run$/, '/report'))
    await expect(page.getByRole('heading', { name: 'Key handling' })).toBeVisible()
    expect(await page.content()).not.toContain('MADEUP')
    expect(await page.locator('body').innerText()).not.toContain('MADEUP')
  })

  test('the key is hidden while typing, shown on request, and survives a reload on this device', async ({ page, stub }) => {
    await createBenchmark(page, 'Key persistence')
    const card = await addEndpoint(page, { name: 'Keyed endpoint', baseUrl: stub.baseUrl('ok'), key: FAKE_KEY })
    const key = card.getByLabel(/^API key/)
    await expect(key).toHaveAttribute('type', 'password')
    await card.getByRole('button', { name: 'Show' }).click()
    await expect(key).toHaveAttribute('type', 'text')

    await page.reload()
    await expect(page.locator('.ep-card').getByLabel(/^API key/)).toHaveValue(FAKE_KEY)
    await expect(page.locator('.ep-card').getByLabel(/^API key/)).toHaveAttribute('type', 'password')
  })

  // https://github.com/AryanKansagara/token-bench/issues/3
  test('a provider error that repeats the key does not carry it into saved results', async ({ page, stub }) => {
    test.fail(true, 'Known bug: provider error text is stored verbatim in the run, so an echoed key reaches exports, share links and sync (https://github.com/AryanKansagara/token-bench/issues/3)')
    await benchmarkWithKey(page, stub, 'echo-key')
    const { projects } = await idbDump(page)
    expect(JSON.stringify(projects)).not.toContain(FAKE_KEY)
  })
})
