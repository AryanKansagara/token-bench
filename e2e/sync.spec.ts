import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, FAKE_KEY, idbDump, test } from './fixtures.ts'

// Cloud sync is compiled out of the normal build. This builds the app once more against an in-process
// stand-in for the sync API on 127.0.0.1; the real backend is never contacted.

const freePort = () => new Promise<number>(r => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => r(port)) }) })

interface Row { id: string; project_id?: string; app?: string; data: unknown; [k: string]: unknown }

/** Just enough of the PostgREST protocol for sync: select, insert, upsert, update and delete with eq and in. */
function cloud() {
  const tables: Record<string, Row[]> = { projects: [], project_versions: [] }
  const uploads: string[] = []
  const state = { allowUpdate: true }
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end()
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x')
      const name = url.pathname.replace('/rest/v1/', '')
      const json = (b: unknown) => res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(b))
      if (!(name in tables)) return json({})
      const match = (r: Row) => [...url.searchParams].every(([k, v]) => v.startsWith('eq.') ? String(r[k]) === v.slice(3) : v.startsWith('in.') ? v.slice(4, -1).split(',').includes(String(r[k])) : true)
      if (raw) uploads.push(raw)
      if (req.method === 'GET') return json(tables[name].filter(match))
      if (req.method === 'DELETE') { tables[name] = tables[name].filter(r => !match(r)); return json([]) }
      if (req.method === 'PATCH') {
        const hit = state.allowUpdate ? tables[name].filter(match) : []
        hit.forEach(r => Object.assign(r, JSON.parse(raw)))
        return json(hit.map(r => ({ id: r.id })))
      }
      const rows = [JSON.parse(raw)].flat() as Row[]
      tables[name] = [...tables[name].filter(r => !rows.some(x => x.id === r.id)), ...rows]
      json([])
    })
  })
  return { tables, uploads, state, server }
}

test.describe('cloud sync', () => {
  for (const allowUpdate of [true, false]) {
    test(`a key repeated in an error is neither uploaded nor left in the cloud (${allowUpdate ? 'rows can be updated' : 'rows can only be replaced'})`, async ({ browser }) => {
      test.setTimeout(120_000)
      const { tables, uploads, state, server } = cloud()
      state.allowUpdate = allowUpdate
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
      const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const dir = await mkdtemp(join(tmpdir(), 'token-bench-sync-'))
      const port = await freePort()
      const vite = join(process.cwd(), 'node_modules/vite/bin/vite.js')
      await promisify(execFile)(process.execPath, [vite, 'build', '--outDir', dir, '--emptyOutDir'], { env: { ...process.env, VITE_SUPABASE_URL: api, VITE_SUPABASE_PUBLISHABLE_KEY: 'made-up' } })
      const preview = spawn(process.execPath, [vite, 'preview', '--outDir', dir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' })
      const app = `http://127.0.0.1:${port}`
      const context = await browser.newContext()
      try {
        await expect.poll(() => fetch(app).then(r => r.status, () => 0)).toBe(200)
        const other: string[] = []
        await context.route('**/*', route => {
          const u = new URL(route.request().url())
          if (u.origin === app || u.origin === api) return route.continue()
          if (u.host.startsWith('fonts.')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
          other.push(u.host)
          return route.abort()
        })
        const run = (id: string) => ({
          id, label: id, createdAt: 1, source: 'browser', config: { reps: 1, concurrency: 1, rampMs: 0, timeoutMs: 1000, temperature: 0 },
          endpoints: [{ id: 'e1', name: 'E', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', streamOptions: true }], prompts: [{ id: 'p', name: 'P', suite: 's', user: 'u', maxTokens: 8 }],
          results: [{ endpointId: 'e1', promptId: 'p', rep: 0, startedAt: 0, ok: false, status: 401, errorKind: 'http', error: `HTTP 401: Incorrect API key provided: ${FAKE_KEY}.` }],
        })
        // Uploaded by an older version: one run this device also has, and one only the cloud has.
        tables.projects.push({ id: 'p1', app: 'token-bench', name: 'Old', updated_at: new Date(5).toISOString(), data: { project: { endpoints: [], prompts: [], config: {}, loop: {} } } })
        for (const id of ['both', 'cloud-only']) tables.project_versions.push({ id, project_id: 'p1', label: id, data: run(id) })
        const page = await context.newPage()
        await page.goto(`${app}/app`)
        await expect(page.getByRole('heading', { name: 'Benchmarks', exact: true })).toBeVisible()
        await idbDump(page)
        await page.evaluate(({ runs, key }) => new Promise<void>((resolve, reject) => {
          const user = { id: 'u1', email: 'someone@example.com', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' }
          localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 99999, expires_at: Math.floor(Date.now() / 1000) + 99999, user }))
          const open = indexedDB.open('token-bench')
          open.onsuccess = () => {
            const tx = open.result.transaction(['projects', 'keys'], 'readwrite')
            tx.objectStore('projects').put({ id: 'p1', name: 'Old', createdAt: 1, updatedAt: 9, endpoints: runs[0].endpoints, prompts: runs[0].prompts, config: runs[0].config, loop: { steps: 1, firstInput: 1, output: 1, toolTokens: 0, toolMs: 0 }, runs })
            tx.objectStore('keys').put(key, 'e1')
            tx.oncomplete = () => { open.result.close(); resolve() }
            tx.onerror = () => reject(tx.error)
          }
        }), { runs: [run('both'), run('local-only')], key: FAKE_KEY })
        await page.reload()

        await expect.poll(() => tables.project_versions.map(v => v.id).sort()).toEqual(['both', 'cloud-only', 'local-only'])
        await expect.poll(() => JSON.stringify(tables)).not.toContain('MADEUP')
        for (const v of tables.project_versions) expect(JSON.stringify(v)).toContain('Incorrect API key provided: [key hidden].')
        expect(uploads.join('\n')).not.toContain('MADEUP')
        await expect.poll(async () => (await idbDump(page)).projects[0].runs.map(r => r.id).sort()).toEqual(['both', 'cloud-only', 'local-only'])
        expect(JSON.stringify((await idbDump(page)).projects)).not.toContain('MADEUP')
        expect(other).toEqual([])
      } finally {
        await context.close()
        preview.kill()
        server.close()
        server.closeAllConnections()
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
})
