import { useEffect, useState } from 'react'
import { leaderboard } from './engine/stats.ts'
import { createBlankProject, createSampleProject, latestRun } from './projectData.ts'
import { deleteProject, useProjects } from './store.ts'
import { Empty, fmtDate, fmtMs, go, Link, Modal, SyntheticBadge, toast } from './ui.tsx'

export default function Workspace() {
  const list = useProjects()
  const [naming, setNaming] = useState(false)
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    if (q.get('new') === '1') { history.replaceState({}, '', '/app'); setNaming(true) }
    if (q.get('sample') === '1') void createSampleProject().then(p => go(`/app/p/${p.id}${q.get('tab') ? '/' + q.get('tab') : ''}`, { replace: true }))
  }, [])

  const create = async (name: string) => {
    const p = await createBlankProject(name || 'Provider shortlist')
    go(`/app/p/${p.id}/endpoints?add=1`)
  }
  const sample = async () => { const p = await createSampleProject(); go(`/app/p/${p.id}`) }

  if (list === null) return <div className="boot" role="status"><span className="spinner" /> Loading</div>
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Benchmarks</h1>
          <p className="muted">One project per decision, for example "Agent backend, Q4". Each keeps its endpoints, prompt suites and every run, so you can rerun next month and see what changed.</p>
        </div>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={() => go('/app/share?import=1')}>Import a result</button>
          <button type="button" className="btn primary" onClick={() => setNaming(true)}>New benchmark</button>
        </div>
      </div>

      {list.length === 0 ? (
        <Empty title="No benchmarks yet" icon={<EmptyArt />}>
          <p className="muted">Start with the recorded synthetic benchmark to see every chart without a key, or add your own providers and prompts.</p>
          <div className="row gap center-x wrap">
            <button type="button" className="btn accent" onClick={() => void sample()}>Try the sample</button>
            <button type="button" className="btn ghost" onClick={() => setNaming(true)}>Import your data</button>
          </div>
        </Empty>
      ) : (
        <div className="proj-grid">
          {list.map(p => {
            const last = latestRun(p)
            const top = last ? leaderboard(last)[0] : null
            return (
              <article key={p.id} className="card proj">
                <Link href={`/app/p/${p.id}`} className="proj-link">
                  <h3>{p.name} {p.sampleId && <SyntheticBadge />}</h3>
                  <p className="muted small">{p.endpoints.length} endpoint{p.endpoints.length === 1 ? '' : 's'} · {p.prompts.length} prompt{p.prompts.length === 1 ? '' : 's'} · {p.runs.length} run{p.runs.length === 1 ? '' : 's'}</p>
                  <div className="proj-meta">
                    {last ? <><span>Last run {fmtDate(last.createdAt)}</span>{top?.e2e && <span>Fastest: <b>{top.endpoint.name}</b>, {fmtMs(top.e2e.p50)} median</span>}</> : <span>No runs yet</span>}
                  </div>
                </Link>
                <div className="row gap-sm proj-actions">
                  <Link href={`/app/p/${p.id}/run`} className="btn ghost sm">Run</Link>
                  {last && <Link href={`/app/p/${p.id}/report`} className="btn ghost sm">Report</Link>}
                  <button type="button" className="btn danger-ghost sm" onClick={async () => {
                    const undo = await deleteProject(p.id)
                    toast(`Deleted ${p.name}.`, { undo: () => void undo() })
                  }}>Delete</button>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {list.length > 0 && !list.some(p => p.sampleId) && (
        <div className="samples">
          <h2 className="h4">Sample</h2>
          <button type="button" className="card sample-card" onClick={() => void sample()}>
            <strong>Synthetic providers A, B, C</strong> <SyntheticBadge />
            <span className="muted small">Two recorded runs a month apart, seven prompts, rate limits and stalls included. Works without any key.</span>
          </button>
        </div>
      )}

      <Modal open={naming} onClose={() => setNaming(false)} title="New benchmark">
        <form onSubmit={e => { e.preventDefault(); void create(String(new FormData(e.currentTarget).get('name') ?? '').trim()) }} className="stack">
          <label className="field"><span>Name</span><input name="name" autoFocus placeholder="Agent backend, Q4" /></label>
          <p className="muted small">Next: add the providers you are choosing between (presets for Cerebras, Groq, Together, Fireworks, OpenRouter and local servers), then pick or import prompts.</p>
          <div className="row end gap"><button type="button" className="btn ghost" onClick={() => setNaming(false)}>Cancel</button><button className="btn primary">Create</button></div>
        </form>
      </Modal>
    </section>
  )
}

const EmptyArt = () => (
  <svg className="empty-art" viewBox="0 0 120 80" aria-hidden="true">
    <path d="M10 70 L30 70 L36 20 L110 12" className="ea-a" />
    <path d="M10 70 L44 70 L52 40 L110 30" className="ea-b" />
    <path d="M10 70 L64 70 L76 62 L110 55" className="ea-c" />
  </svg>
)
