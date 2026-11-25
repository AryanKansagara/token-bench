import { inflateRawSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { addEndpoint, copied, createBenchmark, downloadText, expect, FAKE_KEY, idbDump, runBenchmark, tab, test } from './fixtures.ts'
import type { Stub } from './stub.ts'

const urlSafeToJson = (hash: string) => inflateRawSync(Buffer.from(hash.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString('utf8')

async function benchmarkWithKey(page: Page, stub: Stub, scenario: 'ok') {
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
  for (const scenario of ['echo-key', 'echo-stream'] as const) {
    test(`a provider error that repeats the key (${scenario}) does not carry it onto the screen, into saved results, exports, share links or the report`, async ({ page, stub }) => {
      await createBenchmark(page, 'Key handling')
      const card = await addEndpoint(page, { name: 'Keyed endpoint', baseUrl: stub.baseUrl(scenario), key: FAKE_KEY })
      await card.getByRole('button', { name: 'Test connection' }).click()
      await expect(card.getByRole('alert')).toContainText('[key hidden]')
      expect(await page.locator('body').innerText()).not.toMatch(LEFT)
      await runBenchmark(page, { label: 'Keyed run' })
      await expect(page.locator('.log')).toContainText('[key hidden]')
      expect(await page.locator('body').innerText()).not.toMatch(LEFT)
      expect(stub.requests(scenario).at(-1)!.authorization).toBe(`Bearer ${FAKE_KEY}`)
      await expectNoKey(page)
    })
  }

  test('a key already saved in an old run is removed when the app opens', async ({ page, stub }) => {
    await createBenchmark(page, 'Old data')
    await addEndpoint(page, { name: 'Keyed endpoint', baseUrl: stub.baseUrl('ok'), key: FAKE_KEY })
    await runBenchmark(page, { label: 'Old run' })
    // What an older version would have saved, including a key that is no longer stored on this device.
    await putInFirstRun(page, [`HTTP 401: Incorrect API key provided: ${FAKE_KEY}.`, `HTTP 401: Incorrect API key provided: ${GONE_KEY}.`])
    const before = (await idbDump(page)).projects[0] as unknown as { updatedAt: number }
    expect(JSON.stringify(before)).toContain(FAKE_KEY)
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Benchmark name' })).toHaveValue('Old data')
    await expect.poll(async () => JSON.stringify((await idbDump(page)).projects)).not.toMatch(LEFT)
    const after = (await idbDump(page)).projects[0] as unknown as { updatedAt: number }
    expect(after.updatedAt, 'cleaning is not an edit').toBe(before.updatedAt)
    await expectNoKey(page)
  })

  test('a key in an imported result file is not saved', async ({ page, stub }) => {
    await createBenchmark(page, 'Imported')
    await addEndpoint(page, { name: 'Keyed endpoint', baseUrl: stub.baseUrl('ok'), key: FAKE_KEY })
    await tab(page, 'History').click()
    const file = { format: 'token-bench-run', label: 'From a friend', endpoints: [{ id: 'e', model: 'm' }], results: [{ endpointId: 'e', promptId: 'p', ok: false, status: 401, error: `denied ${FAKE_KEY} and ${GONE_KEY}`, text: `You sent ${FAKE_KEY}` }] }
    await page.locator('input[type=file]').setInputFiles({ name: 'run.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
    await page.getByRole('button', { name: 'Add to history' }).click()
    await expect(page.locator('table.leader')).toBeVisible()
    await expectNoKey(page)
  })
})

/** A second made-up key, never stored on the device. */
const GONE_KEY = 'sk-old-MADEUP-9999-not-a-real-key-0987654321'
/** Any recognisable part of either key. */
const LEFT = /MADEUP|not-a-real|1234567890|0987654321|\*7890|sk-tes/i

async function expectNoKey(page: Page) {
  expect(JSON.stringify((await idbDump(page)).projects)).not.toMatch(LEFT)
  expect(JSON.stringify((await page.context().storageState()).origins)).not.toMatch(LEFT)
  await tab(page, 'Results').click()
  await page.getByText(/^Errors \(\d+\)/).click()
  await expect(page.locator('details table tbody')).toContainText('[key hidden]')
  expect(await page.content()).not.toMatch(LEFT)
  const csv = await downloadText(page, () => page.getByRole('button', { name: 'CSV', exact: true }).click())
  const json = await downloadText(page, () => page.getByRole('button', { name: 'JSON', exact: true }).click())
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect(page.getByText(/^Share link copied/)).toBeVisible()
  const shared = urlSafeToJson((await copied(page)).split('#r=')[1])
  for (const [what, text] of [['CSV', csv.text], ['JSON', json.text], ['share link', shared]] as const) {
    expect(text, what).toContain('[key hidden]')
    expect(text, what).not.toMatch(LEFT)
  }
  await page.getByRole('link', { name: 'Printable report' }).click()
  await expect(page.locator('.report')).toBeVisible()
  expect(await page.content()).not.toMatch(LEFT)
  await page.goBack()
}

/** Replaces the first saved run's results with failures carrying these messages, as raw IndexedDB data. */
async function putInFirstRun(page: Page, errors: string[]) {
  await page.evaluate(errors => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('token-bench')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('projects', 'readwrite'), s = tx.objectStore('projects'), all = s.getAll()
      all.onsuccess = () => {
        const p = all.result[0], r = p.runs[0].results[0]
        p.runs[0].results = errors.map((error, rep) => ({ endpointId: r.endpointId, promptId: r.promptId, rep, startedAt: 0, ok: false, status: 401, errorKind: 'http', error, totalMs: 5 }))
        s.put(p)
      }
      tx.oncomplete = () => { open.result.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  }), errors)
}
