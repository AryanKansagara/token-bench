import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { addEndpoint, createBenchmark, downloadText, expect, tab, test } from './fixtures.ts'

const run = promisify(execFile)

test('the downloaded terminal script runs against the stub and its result file imports', async ({ page, stub }) => {
  test.setTimeout(120_000)
  await createBenchmark(page, 'Terminal fallback')
  await addEndpoint(page, { name: 'Fast stub', baseUrl: stub.baseUrl('ok') })
  await addEndpoint(page, { name: 'Limited stub', baseUrl: stub.baseUrl('rate') })
  await tab(page, 'Run').click()
  await page.getByRole('group', { name: /^Prompts/ }).getByRole('button', { name: 'none' }).click()
  await page.getByRole('group', { name: /^Prompts/ }).getByRole('checkbox').first().check()
  await page.getByLabel('Repetitions').fill('2')
  const script = await downloadText(page, () => page.getByRole('button', { name: 'Download token-bench.mjs' }).click())
  expect(script.name).toBe('token-bench.mjs')

  const dir = await mkdtemp(join(tmpdir(), 'token-bench-e2e-'))
  try {
    await writeFile(join(dir, script.name), script.text)
    const { stderr } = await run(process.execPath, [script.name, 'results.json'], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 })
    expect(stderr).toContain('[4/4]')
    expect(stderr).toContain('Wrote results.json')
    const file = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'))
    expect(file.source).toBe('node')
    expect(file.results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(2)
    expect(file.results.filter((r: { errorKind?: string }) => r.errorKind === 'rate_limit')).toHaveLength(2)
    expect(stub.requests('ok')).toHaveLength(2)

    // Import it into a fresh benchmark: the terminal numbers and the failures arrive intact.
    await createBenchmark(page, 'From the terminal')
    await tab(page, 'History').click()
    await page.locator('input[type=file]').setInputFiles(join(dir, 'results.json'))
    const dialog = page.getByRole('dialog', { name: 'Import results.json' })
    await expect(dialog).toContainText('4 requests across 2 endpoints')
    await expect(dialog).toContainText('Validation passed: no issues.')
    await dialog.getByRole('button', { name: 'Add to history' }).click()
    await expect(page.locator('.toolbar')).toContainText('· terminal run')
    const rows = page.locator('table.leader tbody tr')
    await expect(rows.filter({ hasText: 'Fast stub' }).locator('td').first()).toHaveText('1')
    await expect(rows.filter({ hasText: 'Limited stub' }).locator('td').nth(9)).toHaveText('100%')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the terminal script refuses to start without keys for hosted providers', async ({ page }) => {
  await createBenchmark(page, 'Needs keys')
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await page.getByRole('dialog', { name: 'Add an endpoint' }).getByRole('button', { name: /^Groq/ }).click()
  await tab(page, 'Run').click()
  const script = await downloadText(page, () => page.getByRole('button', { name: 'Download token-bench.mjs' }).click())
  const dir = await mkdtemp(join(tmpdir(), 'token-bench-e2e-'))
  try {
    await writeFile(join(dir, script.name), script.text)
    const err = await run(process.execPath, [script.name, 'out.json'], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeout: 30_000 }).then(() => null, e => e as { code: number; stderr: string })
    expect(err, 'script should exit non-zero').not.toBeNull()
    expect(err!.code).toBe(1)
    expect(err!.stderr).toContain('Set these environment variables first')
    expect(err!.stderr).toContain('export TB_KEY_GROQ_1=')
    await expect(readFile(join(dir, 'out.json'))).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
