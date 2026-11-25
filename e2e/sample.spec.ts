import { expect, test } from './fixtures.ts'

test.describe('labelled sample, no key', () => {
  test('landing page offers the sample and it opens with a leaderboard and percentiles', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('REPLAY · SYNTHETIC RECORDING')).toBeVisible()
    await page.getByRole('link', { name: 'Try the sample' }).first().click()
    await expect(page).toHaveURL(/\/app\/p\/[\w-]+$/)
    await expect(page.getByText('Synthetic', { exact: true })).toBeVisible()
    await expect(page.getByText(/Synthetic data: providers A, B and C are fake/)).toBeVisible()

    const table = page.locator('table.leader')
    await expect(table.getByRole('columnheader')).toHaveText(['#', 'Endpoint', 'TTFT p50', 'TTFT p90', 'Tokens/s p50', 'E2E p50', 'E2E p99', 'Consistency', 'Errors', '429s', '$ / 1M'])
    const rows = table.locator('tbody tr')
    await expect(rows).toHaveCount(3)
    for (const [i, name] of ['Provider A', 'Provider B', 'Provider C'].entries()) {
      const row = rows.nth(i)
      await expect(row).toContainText(`${name} (synthetic)`)
      await expect(row.locator('td').nth(0)).toHaveText(String(i + 1))
      // p50 and p90 TTFT, decode speed, p50 and p99 end to end: real numbers with units.
      await expect(row.locator('td').nth(2)).toHaveText(/^\d[\d.,]*\s?(ms|s)/)
      await expect(row.locator('td').nth(3)).toHaveText(/^\d[\d.,]*\s?(ms|s)/)
      await expect(row.locator('td').nth(4)).toHaveText(/^≈?\d[\d.,]*/)
      await expect(row.locator('td').nth(5)).toHaveText(/^\d[\d.,]*\s?(ms|s)/)
      await expect(row.locator('td').nth(6)).toHaveText(/^\d[\d.,]*\s?(ms|s)/)
    }
    await expect(page.getByText('Fastest end to end')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Per prompt medians' })).toBeVisible()
  })

  test('the sample endpoints can be tested without a key and never touch the network', async ({ page, stub, external }) => {
    await page.goto('/app?sample=1&tab=endpoints')
    await expect(page.getByText('These synthetic endpoints are served by a local replay')).toBeVisible()
    const card = page.locator('.ep-card').first()
    await expect(card.getByLabel(/^API key/)).toHaveValue('')
    await card.getByRole('button', { name: 'Test connection' }).click()
    await expect(card.getByRole('status').filter({ hasText: 'Streaming works' })).toBeVisible()
    expect(external.filter(h => h.endsWith('.example'))).toEqual([])
    expect(stub.seen).toEqual([])
  })

  test('the sample survives a reload and a second visit does not duplicate it', async ({ page }) => {
    await page.goto('/app?sample=1')
    await expect(page.locator('table.leader')).toBeVisible()
    await page.goto('/app')
    await expect(page.locator('.proj')).toHaveCount(1)
    await page.reload()
    await expect(page.locator('.proj')).toHaveCount(1)
    await expect(page.locator('.proj')).toContainText('2 runs')
    await page.goto('/app?sample=1')
    await page.goto('/app')
    await expect(page.locator('.proj')).toHaveCount(1)
  })
})
