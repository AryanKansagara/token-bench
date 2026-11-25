import { addEndpoint, createBenchmark, expect, idbDump, runBenchmark, tab, test } from './fixtures.ts'

test.describe('failed and cancelled runs never look fast', () => {
  test('a run where every request fails saves the failures and shows no winner, no timings and no estimate', async ({ page, stub }) => {
    await createBenchmark(page, 'Everything fails')
    await addEndpoint(page, { name: 'Limited', baseUrl: stub.baseUrl('rate') })
    await addEndpoint(page, { name: 'Stalled', baseUrl: stub.baseUrl('stall') })
    await addEndpoint(page, { name: 'Wrong page', baseUrl: stub.baseUrl('html') })
    await runBenchmark(page, { reps: 2, timeoutMs: 1000 })
    await expect(page.getByText('Run saved: 0/6 requests succeeded.')).toBeVisible()

    await tab(page, 'Results').click()
    // No winner cards, no rank, no timings, every error rate at 100%.
    await expect(page.locator('.kpis')).toHaveCount(0)
    await expect(page.getByText('Fastest end to end')).toHaveCount(0)
    const rows = page.locator('table.leader tbody tr')
    await expect(rows).toHaveCount(3)
    for (const row of await rows.all()) {
      const cells = row.locator('td')
      await expect(cells.nth(0)).toHaveText('–')
      for (const i of [2, 3, 4, 5, 6]) await expect(cells.nth(i)).toHaveText(/^(n\/a|–)$/)
      await expect(cells.nth(8)).toHaveText('100%')
    }
    await expect(page.getByText('No successful request for this prompt.')).toBeVisible()
    await expect(page.getByText('Errors (6)')).toBeVisible()

    // The report and the agent-loop estimate say there is nothing to report.
    await page.goto(page.url().replace(/\/overview$/, '/report'))
    await expect(page.getByRole('heading', { name: 'Summary' })).toHaveCount(0)
    await expect(page.getByText('had the lowest median end-to-end latency')).toHaveCount(0)
    await page.goBack()
    await tab(page, 'Agent loop').click()
    await expect(page.getByText('No successful requests to estimate from.').first()).toBeVisible()

    // The workspace card names no fastest provider either.
    await page.goto('/app')
    await expect(page.locator('.proj')).toContainText('1 run')
    await expect(page.locator('.proj')).not.toContainText('Fastest')
  })

  test('with one working and one failing endpoint only the working one is ranked or named best', async ({ page, stub }) => {
    await createBenchmark(page, 'One works')
    await addEndpoint(page, { name: 'Works', baseUrl: stub.baseUrl('ok') })
    await addEndpoint(page, { name: 'Dead', baseUrl: stub.baseUrl('unauthorized') })
    await runBenchmark(page, { reps: 2, timeoutMs: 5000 })
    await tab(page, 'Results').click()
    const rows = page.locator('table.leader tbody tr')
    await expect(rows.filter({ hasText: 'Works' }).locator('td').first()).toHaveText('1')
    await expect(rows.filter({ hasText: 'Dead' }).locator('td').first()).toHaveText('–')
    for (const kpi of await page.locator('.kpi').all()) {
      await expect(kpi).toContainText('Works')
      await expect(kpi).not.toContainText('Dead')
    }
    await expect(page.locator('.kpi').first()).toBeVisible()
  })

  test('cancelling a run that has produced nothing saves nothing', async ({ page, stub }) => {
    await createBenchmark(page, 'Cancelled')
    await addEndpoint(page, { name: 'Silent', baseUrl: stub.baseUrl('stall-headers') })
    await tab(page, 'Run').click()
    await page.getByRole('group', { name: /^Prompts/ }).getByRole('button', { name: 'none' }).click()
    await page.getByRole('group', { name: /^Prompts/ }).getByRole('checkbox').first().check()
    await page.getByRole('button', { name: 'Start run' }).click()
    await expect(page.getByText('1 in flight')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Run cancelled. Nothing was saved.')).toBeVisible()
    expect((await idbDump(page)).projects[0].runs).toHaveLength(0)
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled()
  })

  test('a run needs an endpoint and a prompt, and says so', async ({ page }) => {
    await createBenchmark(page, 'Nothing to run')
    await tab(page, 'Run').click()
    await expect(page.getByRole('heading', { name: 'Almost ready' })).toBeVisible()
    await expect(page.getByText('A run needs at least one endpoint and one prompt.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start run' })).toHaveCount(0)
  })
})
