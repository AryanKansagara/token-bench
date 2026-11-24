import { test as base, expect, type BrowserContext, type Download, type Page } from '@playwright/test'
import { startStub, type Stub } from './stub.ts'

/** The only external hosts the page asks for: web fonts in index.html. They are answered with an empty stylesheet. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

/** A made-up key. It is not a credential for anything, and the stub never forwards it. */
export const FAKE_KEY = 'sk-test-MADEUP-0000-not-a-real-key-1234567890'

type Watch = (ctx: BrowserContext) => Promise<void>

export const test = base.extend<{ watch: Watch; external: string[]; stub: Stub }>({
  // One stub per test, so the requests it records belong to that test alone.
  stub: async ({}, use) => {
    const stub = await startStub()
    await use(stub)
    await stub.close()
  },

  external: async ({}, use) => { await use([]) },

  // Every context the test opens goes through this: only the app and the stub are reachable,
  // and uncaught page errors fail the test.
  watch: async ({ stub, baseURL, external }, use) => {
    const errors: string[] = []
    const allowed = new Set([new URL(baseURL!).origin, stub.origin])
    await use(async ctx => {
      await ctx.route('**/*', route => {
        const url = new URL(route.request().url())
        if (allowed.has(url.origin)) return route.continue()
        external.push(url.host)
        if (FONT_HOSTS.has(url.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
        return route.abort('blockedbyclient')
      })
      ctx.on('weberror', e => errors.push(String(e.error())))
      // The clipboard is replaced so a test can read what the page copied without browser permissions.
      await ctx.addInitScript(() => {
        const w = window as unknown as { __copied: string[] }
        w.__copied = []
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { w.__copied.push(t) }, readText: async () => w.__copied.at(-1) ?? '' }, configurable: true })
      })
    })
    expect(errors, 'uncaught page errors').toEqual([])
    expect(external.filter(h => !FONT_HOSTS.has(h)), 'requests to hosts other than the app and the stub').toEqual([])
  },

  context: async ({ context, watch }, use) => {
    await watch(context)
    await use(context)
  },
})

export { expect }

export const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '')

export async function downloadText(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  const [d]: [Download, void] = await Promise.all([page.waitForEvent('download'), click()])
  const path = await d.path()
  const { readFile } = await import('node:fs/promises')
  return { name: d.suggestedFilename(), text: await readFile(path, 'utf8') }
}

// ---------- Reading what the app stored (read-only) ----------

interface StoredRun { id: string; label: string; source: string; results: Result[]; endpoints: { id: string; name: string; baseUrl: string }[] }
export interface Result { endpointId: string; ok: boolean; status?: number; errorKind?: string; error?: string; ttftMs?: number; totalMs?: number; outputTokens?: number; inputTokens?: number; tokenSource?: string; chunks?: number[] }
export interface StoredProject { id: string; name: string; runs: StoredRun[]; endpoints: { id: string; name: string; baseUrl: string; model: string }[]; prompts: { id: string; name: string; user: string; maxTokens: number; system?: string }[] }

/** Everything in the app's IndexedDB, as JSON text, for projects and for keys. */
export async function idbDump(page: Page): Promise<{ projects: StoredProject[]; keys: Record<string, string> }> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('token-bench')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['projects', 'keys'], 'readonly')
      const projects = tx.objectStore('projects').getAll()
      const keys: Record<string, string> = {}
      const cur = tx.objectStore('keys').openCursor()
      cur.onsuccess = () => { const c = cur.result; if (c) { keys[String(c.key)] = c.value as string; c.continue() } }
      tx.oncomplete = () => { db.close(); resolve({ projects: projects.result, keys }) }
      tx.onerror = () => reject(tx.error)
    }
  }))
}

export async function latestRunResults(page: Page): Promise<{ run: StoredRun; byName: Map<string, Result[]> }> {
  const { projects } = await idbDump(page)
  const run = projects[0].runs.at(-1)!
  const byName = new Map<string, Result[]>()
  for (const r of run.results) {
    const name = run.endpoints.find(e => e.id === r.endpointId)!.name
    byName.set(name, [...(byName.get(name) ?? []), r])
  }
  return { run, byName }
}

// ---------- Driving the app ----------

export async function createBenchmark(page: Page, name: string) {
  await page.goto('/app')
  await page.getByRole('button', { name: 'New benchmark' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  // A new benchmark opens on its endpoints tab with the preset picker open.
  await expect(page.getByRole('dialog', { name: 'Add an endpoint' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Add an endpoint' })).toBeHidden()
}

/**
 * Adds a Custom endpoint card. Each field is saved on blur, and the app builds each save from the
 * last rendered project, so a field is only committed once the previous save has landed.
 */
export async function addEndpoint(page: Page, e: { name: string; baseUrl: string; model?: string; key?: string }) {
  const dialog = page.getByRole('dialog', { name: 'Add an endpoint' })
  if (!await dialog.isVisible()) await page.getByRole('button', { name: 'Add endpoint' }).click()
  const before = (await idbDump(page)).projects[0].endpoints.length
  await dialog.getByRole('button', { name: /^Custom/ }).click()
  await expect.poll(async () => (await idbDump(page)).projects[0].endpoints.length).toBe(before + 1)
  const card = page.locator('.ep-card').last()
  const saved = async (field: 'name' | 'baseUrl' | 'model', value: string) =>
    expect.poll(async () => (await idbDump(page)).projects[0].endpoints[before][field]).toBe(value)
  for (const [label, field, value] of [['Display name', 'name', e.name], ['Base URL', 'baseUrl', e.baseUrl], ['Model', 'model', e.model ?? 'stub-model']] as const) {
    await card.getByLabel(label).fill(value)
    await card.getByLabel(label).blur()
    await saved(field, value)
  }
  if (e.key) {
    await card.getByLabel(/^API key/).fill(e.key)
    const id = (await idbDump(page)).projects[0].endpoints[before].id
    await expect.poll(async () => (await idbDump(page)).keys[id]).toBe(e.key)
  }
  return card
}

export const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Benchmark sections' }).getByRole('link', { name: new RegExp(`^${name}`) })

/** Runs the benchmark with one prompt (the first), `reps` repetitions and the given timeout, and waits for it to finish. */
export async function runBenchmark(page: Page, o: { reps?: number; concurrency?: number; timeoutMs?: number; label?: string } = {}) {
  await tab(page, 'Run').click()
  const setting = async (label: string, v: number) => { await page.getByLabel(label).fill(String(v)) }
  await setting('Repetitions', o.reps ?? 1)
  await setting('Parallel requests', o.concurrency ?? 4)
  await setting('Ramp (ms per worker)', 0)
  await setting('Timeout (ms)', o.timeoutMs ?? 5000)
  if (o.label) await page.getByLabel('Run label').fill(o.label)
  // Only the first prompt: "none", then tick one.
  const prompts = page.getByRole('group', { name: /^Prompts/ })
  await prompts.getByRole('button', { name: 'none' }).click()
  await prompts.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: 'Start run' }).click()
  await expect(page.getByText('finished')).toBeVisible({ timeout: 60_000 })
  // The run is saved after the last request finishes.
  await expect(page.getByText(/^Run saved: |^Partial run saved: /)).toBeVisible()
}
