import { addEndpoint, createBenchmark, expect, FAKE_KEY, idbDump, runBenchmark, tab, test } from './fixtures.ts'

test.describe('what the app promises to keep', () => {
  test('benchmarks, endpoints, keys, prompts, settings and runs survive a reload', async ({ page, stub }) => {
    await createBenchmark(page, 'Keeps its state')
    await addEndpoint(page, { name: 'Local stub', baseUrl: stub.baseUrl('ok'), key: FAKE_KEY })
    await tab(page, 'Prompts').click()
    await page.getByRole('button', { name: 'Remove' }).first().click()
    await runBenchmark(page, { reps: 2, concurrency: 3, timeoutMs: 4000, label: 'Persisted run' })
    const url = page.url()

    await page.reload()
    await expect(page.getByLabel('Repetitions')).toHaveValue('2')
    await expect(page.getByLabel('Parallel requests')).toHaveValue('3')
    await expect(page.getByLabel('Timeout (ms)')).toHaveValue('4000')
    expect(url).toContain('/run')

    await tab(page, 'Endpoints').click()
    const card = page.locator('.ep-card')
    await expect(card.getByLabel('Display name')).toHaveValue('Local stub')
    await expect(card.getByLabel('Base URL')).toHaveValue(stub.baseUrl('ok'))
    await expect(card.getByLabel(/^API key/)).toHaveValue(FAKE_KEY)

    await tab(page, 'Prompts').click()
    await expect(page.locator('tbody tr')).toHaveCount(4) // five built-in chat prompts, one removed

    await tab(page, 'History').click()
    await expect(page.getByRole('textbox', { name: 'Run label' })).toHaveValue('Persisted run')

    await page.goto('/app')
    await expect(page.locator('.proj')).toContainText('Keeps its state')
    await expect(page.locator('.proj')).toContainText('1 endpoint · 4 prompts · 1 run')
    await expect(page.locator('.proj')).toContainText('Fastest: Local stub')
  })

  test('renaming a benchmark persists', async ({ page }) => {
    await createBenchmark(page, 'Old name')
    const name = page.getByRole('textbox', { name: 'Benchmark name' })
    await name.fill('New name')
    await name.blur()
    await expect.poll(async () => (await idbDump(page)).projects[0].name).toBe('New name')
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Benchmark name' })).toHaveValue('New name')
    await expect(page).toHaveTitle('New name · Token Bench')
  })

  test('settings defaults persist across reloads and seed new benchmarks', async ({ page }) => {
    await page.goto('/settings')
    await page.getByLabel('Repetitions').fill('7')
    await page.getByLabel('Timeout (ms)').fill('12000')
    await page.getByLabel('Rank leaderboards by').selectOption('ttft')
    await page.reload()
    await expect(page.getByLabel('Repetitions')).toHaveValue('7')
    await expect(page.getByLabel('Timeout (ms)')).toHaveValue('12000')
    await expect(page.getByLabel('Rank leaderboards by')).toHaveValue('ttft')

    await createBenchmark(page, 'Uses defaults')
    await addEndpoint(page, { name: 'Needed so the Run tab shows settings', baseUrl: 'http://127.0.0.1:9/v1' })
    await tab(page, 'Run').click()
    await expect(page.getByLabel('Repetitions')).toHaveValue('7')
    await expect(page.getByLabel('Timeout (ms)')).toHaveValue('12000')

    await page.goto('/settings')
    await page.getByRole('button', { name: 'Restore default settings' }).click()
    await expect(page.getByLabel('Repetitions')).toHaveValue('3')
    await page.reload()
    await expect(page.getByLabel('Repetitions')).toHaveValue('3')
  })

  test('a deleted benchmark stays deleted after a reload, and undo brings it back', async ({ page }) => {
    await createBenchmark(page, 'Delete me')
    await page.goto('/app')
    await page.getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByText('Deleted Delete me.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No benchmarks yet' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'No benchmarks yet' })).toBeVisible()
    expect((await idbDump(page)).projects).toHaveLength(0)

    await page.goto('/app')
    await createBenchmark(page, 'Undo me')
    await page.goto('/app')
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.proj')).toContainText('Undo me')
    await page.reload()
    await expect(page.locator('.proj')).toContainText('Undo me')
  })

  test('an unknown benchmark id says so instead of showing an empty page', async ({ page }) => {
    await page.goto('/app/p/does-not-exist/overview')
    await expect(page.getByRole('heading', { name: 'Benchmark not found' })).toBeVisible()
    await page.goto('/no/such/page')
    await expect(page).toHaveTitle(/Not found/)
  })
})
