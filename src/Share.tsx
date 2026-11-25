import { useEffect, useState } from 'react'
import { decodeShare, importRun, type Issue } from './engine/parse.ts'
import type { Run } from './engine/types.ts'
import { ImportReport } from './Project.tsx'
import { DEFAULT_LOOP } from './projectData.ts'
import { defaultConfig, saveProject, useProjects, uuid } from './store.ts'
import { go, toast } from './ui.tsx'

/** "Skip to content" moves to #main, which is not a share link. */
const isAnchor = () => location.hash === '#main'

/** Opens a share link (#r=...) or an uploaded result file, then files it under an existing or new benchmark. */
export default function Share() {
  const list = useProjects()
  const [imp, setImp] = useState<{ run: Run | null; issues: Issue[] } | null>(null)
  const [target, setTarget] = useState('new')
  const [hash, setHash] = useState(() => isAnchor() ? '' : location.hash)
  useEffect(() => {
    // A second link opened in the same tab changes only the fragment, and the page is not reloaded.
    const onHash = () => { if (!isAnchor()) setHash(location.hash) }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    let current = true
    const show = (i: typeof imp) => { if (current) setImp(i) }
    setImp(null)
    if (hash.length > 1) {
      const m = hash.match(/r=([\w-]+)/)
      ;(m ? decodeShare(m[1]) : Promise.reject(new Error('no payload'))).then(t => show(importRun(t)), () => show({ run: null, issues: [{ line: 1, level: 'error', message: 'This share link is damaged or truncated. Ask for the JSON file instead.' }] }))
    }
    return () => { current = false }
  }, [hash])
  const add = async (run: Run) => {
    const now = Date.now()
    const existing = list?.find(p => p.id === target)
    const p = existing
      ? await saveProject({ ...existing, runs: [...existing.runs, run].sort((a, b) => a.createdAt - b.createdAt) })
      : await saveProject({ id: uuid(), name: `Shared: ${run.label}`, createdAt: now, updatedAt: now, endpoints: run.endpoints, prompts: run.prompts, runs: [run], config: defaultConfig(), loop: DEFAULT_LOOP })
    toast('Result added. Add your own keys on Endpoints to rerun it.', { tone: 'ok' })
    go(`/app/p/${p.id}/overview?run=${run.id}`)
  }
  return (
    <section className="page narrow stack">
      <p className="eyebrow">Import</p>
      <h1>Shared benchmark result</h1>
      <p className="muted">Results contain timings, endpoint names, base URLs, models and prompts. They never contain API keys.</p>
      <div className="card pad stack">
        <label className="btn ghost sm file-btn">Choose a result JSON file<input type="file" accept=".json,application/json" onChange={async e => { const f = e.target.files?.[0]; if (f) setImp(importRun(await f.text())) }} /></label>
        {imp ? <>
          {imp.run && list && (
            <label className="field"><span>Add to</span>
              <select value={target} onChange={e => setTarget(e.target.value)}>
                <option value="new">A new benchmark</option>
                {list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          <ImportReport imp={imp} onAdd={r => void add(r)} onCancel={() => go('/app')} />
        </> : hash.length <= 1 && <p className="muted small">Or open a share link someone sent you.</p>}
      </div>
    </section>
  )
}
