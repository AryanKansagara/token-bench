import type { Locator, Page } from '@playwright/test'
import { createBenchmark, downloadText, expect, FAKE_KEY, idbDump, tab, test } from './fixtures.ts'

const upload = (page: Page, name: string, text: string | Buffer, mimeType = 'text/plain') =>
  page.locator('input[type=file]').setInputFiles({ name, mimeType, buffer: Buffer.isBuffer(text) ? text : Buffer.from(text) })

const report = (within: Page | Locator) => within.getByRole('list', { name: 'Validation report' })

/** A minimal, valid result file for one endpoint, with `extra` result rows appended. */
function resultFile(extra: unknown[] = [], over: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 'token-bench-run', version: 1, label: 'Terminal run', source: 'node', createdAt: Date.UTC(2026, 10, 1),
    config: { reps: 1, concurrency: 1, rampMs: 0, timeoutMs: 30000, temperature: 0 },
    endpoints: [{ id: 'e1', name: 'Lab server', baseUrl: 'http://lab.example/v1', model: 'm1', streamOptions: true }],
    prompts: [{ id: 'p1', name: 'Greeting', suite: 'Mine', user: 'Say hello', maxTokens: 32 }],
    results: [{ endpointId: 'e1', promptId: 'p1', rep: 0, startedAt: 0, ok: true, status: 200, ttftMs: 120, totalMs: 520, outputTokens: 32, tokenSource: 'usage' }, ...extra],
    ...over,
  })
}

test.describe('prompt import', () => {
  test('CSV: maps columns, reports every problem with its line number, and adds the good rows', async ({ page }) => {
    await createBenchmark(page, 'Prompt import')
    await tab(page, 'Prompts').click()
    const csv = [
      'name,prompt,max_tokens,suite',
      'Greeting,Say hello,32,Mine',
      ',,64,Mine',
      'Quoted,"Explain ""CORS""',
      'in two lines",notanumber,Mine',
      'Greeting,Duplicate name,16,Mine',
      'Short row',
    ].join('\n')
    await upload(page, 'prompts.csv', csv, 'text/csv')
    const dialog = page.getByRole('dialog', { name: 'Import prompts.csv' })
    await expect(dialog).toContainText('Detected CSV with 5 rows.')

    const issues = report(dialog).getByRole('listitem')
    await expect(issues).toHaveCount(5)
    await expect(issues.filter({ hasText: 'line 3' })).toContainText('Empty prompt text; row skipped.')
    await expect(issues.filter({ hasText: 'line 4' })).toContainText('Target output tokens "notanumber" is not a number from 1 to 32768; using 256.')
    await expect(issues.filter({ hasText: 'line 6' })).toContainText('Duplicate name "Greeting".')
    await expect(issues.filter({ hasText: 'line 7' })).toHaveCount(2)
    await expect(issues.filter({ hasText: 'line 7' }).first()).toContainText('Has 1 columns, header has 4.')
    await expect(issues.filter({ hasText: 'line 7' }).last()).toContainText('Empty prompt text; row skipped.')
    // The row with an embedded quote and newline is one prompt.
    await expect(dialog.locator('.preview')).toContainText('Quoted: Explain "CORS"')

    await dialog.getByRole('button', { name: /^Add \d+ prompts$/ }).click()
    await expect(page.getByText('Added 3 prompts.')).toBeVisible()
    const mine = page.locator('table', { hasText: 'Greeting' })
    await expect(mine.locator('tbody tr')).toHaveCount(3)
    expect((await idbDump(page)).projects[0].prompts.filter(p => p.name === 'Greeting')).toHaveLength(2)
  })

  test('JSONL in OpenAI messages format imports; a broken line is reported and skipped', async ({ page }) => {
    await createBenchmark(page, 'JSONL import')
    await tab(page, 'Prompts').click()
    await upload(page, 'traffic.jsonl', [
      JSON.stringify({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'What is TTFT?' }], max_tokens: 64 }),
      '{"messages": [',
      JSON.stringify({ prompt: 'Name three HTTP verbs', name: 'Verbs' }),
    ].join('\n'))
    const dialog = page.getByRole('dialog', { name: 'Import traffic.jsonl' })
    await expect(dialog).toContainText('2 prompts ready.')
    await expect(report(dialog).getByRole('listitem')).toHaveCount(1)
    await expect(report(dialog)).toContainText('line 2')
    await expect(report(dialog)).toContainText('Not valid JSON; line skipped.')
    await dialog.getByRole('button', { name: 'Add 2 prompts' }).click()
    const stored = (await idbDump(page)).projects[0].prompts
    expect(stored.find(p => p.name === 'What is TTFT?')).toMatchObject({ system: 'Be brief.', maxTokens: 64 })
    expect(stored.some(p => p.name === 'Verbs')).toBe(true)
  })

  for (const [name, content, message] of [
    ['empty.csv', '', 'The file is empty or not CSV, TSV, JSONL or JSON.'],
    ['result.json', resultFile(), 'This file is a benchmark result, not a prompt suite.'],
    ['broken.json', '[{"prompt": "a"', 'The file is empty or not CSV, TSV, JSONL or JSON.'],
    ['noprompts.csv', 'name,prompt\n,\n,   \n', 'Empty prompt text; row skipped.'],
  ] as const) {
    test(`a bad prompt file (${name}) says why and cannot be added`, async ({ page }) => {
      await createBenchmark(page, 'Bad prompt file')
      await tab(page, 'Prompts').click()
      const before = (await idbDump(page)).projects[0].prompts.length
      await upload(page, name, content)
      const dialog = page.getByRole('dialog', { name: `Import ${name}` })
      await expect(report(dialog)).toContainText(message)
      await expect(dialog.getByRole('button', { name: /^Add 0 prompts$/ })).toBeDisabled()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      expect((await idbDump(page)).projects[0].prompts).toHaveLength(before)
    })
  }
})

test.describe('result file import', () => {
  test('an exported result file imports into another benchmark with the same numbers', async ({ page }) => {
    await page.goto('/app?sample=1')
    const source = await page.locator('table.leader').innerText()
    const file = await downloadText(page, () => page.getByRole('button', { name: 'JSON', exact: true }).click())

    await createBenchmark(page, 'Import target')
    await tab(page, 'History').click()
    await expect(page.getByText('No runs yet.')).toBeVisible()
    await upload(page, file.name, file.text, 'application/json')
    const dialog = page.getByRole('dialog', { name: `Import ${file.name}` })
    await expect(dialog).toContainText('requests across 3 endpoints')
    await expect(dialog).toContainText('Validation passed: no issues.')
    await dialog.getByRole('button', { name: 'Add to history' }).click()
    await expect(page).toHaveURL(/\/overview\?run=/)
    await expect(page.locator('table.leader')).toBeVisible()
    expect(await page.locator('table.leader').innerText()).toBe(source)
  })

  test('a terminal result file with one bad row imports the rest and names the row', async ({ page }) => {
    await createBenchmark(page, 'Terminal import')
    await tab(page, 'History').click()
    await upload(page, 'results.json', resultFile([
      { endpointId: 'e1', promptId: 'p1', rep: 1, startedAt: 10, ok: true, ttftMs: 900, totalMs: 100 }, // finished before it started
      { endpointId: 'ghost', promptId: 'p1', rep: 2, startedAt: 20, ok: false },
      { endpointId: 'e1', promptId: 'p1', rep: 3, startedAt: 30, ok: false, status: 429, error: 'slow down' },
    ]), 'application/json')
    const dialog = page.getByRole('dialog', { name: 'Import results.json' })
    await expect(dialog).toContainText('Terminal run: 2 requests across 1 endpoints')
    await expect(report(dialog)).toContainText('results[1] is marked ok but its timings are missing or inconsistent; skipped.')
    await expect(report(dialog)).toContainText('results[2] references an unknown endpoint; skipped.')
    await expect(dialog).toContainText('2 rows were skipped.')
    await dialog.getByRole('button', { name: 'Add to history' }).click()
    // The 429 row is kept and counted as a rate limit, not dropped.
    const row = page.locator('table.leader tbody tr').first()
    await expect(row.locator('td').nth(9)).toHaveText('50%')
  })

  for (const [name, content, message] of [
    ['empty.json', '', 'Invalid JSON'],
    ['text.json', 'this is not json', 'Invalid JSON'],
    ['prompts.json', '[{"prompt":"a"}]', 'Missing "endpoints" or "results". Expected a Token Bench result file.'],
    ['nothing-usable.json', resultFile([], { results: [{ endpointId: 'e1', promptId: 'p1', ok: true, ttftMs: 5 }] }), 'No usable results.'],
    ['truncated.json', resultFile().slice(0, 300), 'Invalid JSON'],
  ] as const) {
    test(`a bad result file (${name}) is refused with a message and adds nothing`, async ({ page }) => {
      await createBenchmark(page, 'Bad result file')
      await tab(page, 'History').click()
      await upload(page, name, content, 'application/json')
      const dialog = page.getByRole('dialog', { name: `Import ${name}` })
      await expect(dialog).toContainText('Nothing could be imported.')
      await expect(report(dialog)).toContainText(message)
      await expect(dialog.getByRole('button', { name: 'Add to history' })).toHaveCount(0)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      expect((await idbDump(page)).projects[0].runs).toHaveLength(0)
      await expect(page.getByText('No runs yet.')).toBeVisible()
    })
  }

  test('a key field inside a result file is discarded and never stored', async ({ page }) => {
    await createBenchmark(page, 'Key in file')
    await tab(page, 'History').click()
    const withKey = JSON.parse(resultFile())
    withKey.endpoints[0].apiKey = FAKE_KEY
    withKey.endpoints[0].key = FAKE_KEY
    await upload(page, 'leaky.json', JSON.stringify(withKey), 'application/json')
    const dialog = page.getByRole('dialog', { name: 'Import leaky.json' })
    await expect(report(dialog)).toContainText('endpoints[0] contained an API key field; it was discarded.')
    await dialog.getByRole('button', { name: 'Add to history' }).click()
    await expect(page.locator('table.leader')).toBeVisible()
    const { projects, keys } = await idbDump(page)
    expect(JSON.stringify(projects)).not.toContain('MADEUP')
    expect(Object.keys(keys)).toHaveLength(0)
  })

  test('markup in a result file is shown as text and never runs', async ({ page }) => {
    await createBenchmark(page, 'Hostile file')
    await tab(page, 'History').click()
    const evil = JSON.parse(resultFile())
    evil.label = '<img src=x onerror="window.__xss=1">Run'
    evil.endpoints[0].name = '<script>window.__xss=2</script>Lab'
    await upload(page, 'evil.json', JSON.stringify(evil), 'application/json')
    await page.getByRole('dialog').getByRole('button', { name: 'Add to history' }).click()
    await expect(page.locator('table.leader')).toContainText('<script>window.__xss=2</script>Lab')
    await expect(page.getByText('<img src=x onerror="window.__xss=1">Run').first()).toBeVisible()
    await expect(page.locator('main img')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  })
})
