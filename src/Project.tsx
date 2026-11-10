import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { estimateLoop, growingLoop } from './engine/agent.ts'
import { exportRunJson, encodeShare, importRun, resultsCsv, type Issue } from './engine/parse.ts'
import { compareRuns, decodeTps, interTokenLatencies, leaderboard, promptMatrix, RANK_LABEL, relChange, type RankBy, type Summary } from './engine/stats.ts'
import type { Run } from './engine/types.ts'
import { DotPlot, ItlHistograms, Legend, RaceChart, Timeline } from './charts.tsx'
import { colorOf, latestRun } from './projectData.ts'
import { getDefaults, saveProject, useProjects, type Project } from './store.ts'
import { deleteRunCloud } from './sync.ts'
import { CopyButton, download, Empty, fmtDate, fmtMs, fmtTps, go, Link, Modal, SyntheticBadge, toast } from './ui.tsx'

const Setup = lazy(() => import('./Setup.tsx'))
const RunTab = lazy(() => import('./RunTab.tsx'))

const TABS = [['overview', 'Results'], ['endpoints', 'Endpoints'], ['prompts', 'Prompts'], ['run', 'Run'], ['history', 'History'], ['agent', 'Agent loop']] as const

export default function ProjectView({ id, tab }: { id: string; tab: string }) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  useEffect(() => { if (project) document.title = `${project.name} · Token Bench` }, [project?.name])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || document.querySelector('dialog[open]')) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) go(`/app/p/${id}/${TABS[n - 1][0]}`, { keepScroll: true })
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [id])
  if (list === null) return <div className="boot" role="status"><span className="spinner" /> Loading</div>
  if (!project) return <section className="page narrow center"><h1>Benchmark not found</h1><p className="muted">It may have been deleted, or it lives on another device that has not synced yet.</p><Link href="/app" className="btn primary">All benchmarks</Link></section>
  const update = (patch: Partial<Project>) => saveProject({ ...project, ...patch })
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow"><Link href="/app">Benchmarks</Link> /</p>
          <h1 className="row gap-sm wrap">
            <input className="title-input" aria-label="Benchmark name" defaultValue={project.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== project.name) void update({ name: v }) }} />
            {project.sampleId && <SyntheticBadge />}
          </h1>
        </div>
        <div className="row gap-sm wrap">
          {project.runs.length > 0 && <Link className="btn ghost" href={`/app/p/${id}/report`}>Printable report</Link>}
          <Link className="btn accent" href={`/app/p/${id}/run`}>Run benchmark</Link>
        </div>
      </div>
      <nav className="tabs" aria-label="Benchmark sections">
        {TABS.map(([k, l], i) => <Link key={k} href={`/app/p/${id}/${k}`} keepScroll aria-current={tab === k ? 'page' : undefined} title={`Shortcut: ${i + 1}`}>{l}{k === 'history' && project.runs.length > 0 && <span className="count">{project.runs.length}</span>}</Link>)}
      </nav>
      <Suspense fallback={<div className="boot" role="status"><span className="spinner" /> Loading</div>}>
        {tab === 'overview' && <Overview project={project} />}
        {(tab === 'endpoints' || tab === 'prompts') && <Setup project={project} tab={tab} update={update} />}
        {tab === 'run' && <RunTab project={project} update={update} />}
        {tab === 'history' && <History project={project} update={update} />}
        {tab === 'agent' && <Agent project={project} update={update} />}
        {!TABS.some(t => t[0] === tab) && <p>Unknown section. <Link href={`/app/p/${id}`}>Back to results</Link></p>}
      </Suspense>
    </section>
  )
}

export function useRunPick(project: Project) {
  const [runId, setRunId] = useState<string | null>(() => new URLSearchParams(location.search).get('run'))
  const run = project.runs.find(r => r.id === runId) ?? latestRun(project)
  return { run, setRunId }
}

function RunPicker({ project, run, onPick }: { project: Project; run: Run; onPick(id: string): void }) {
  return (
    <label className="field inline"><span>Run</span>
      <select value={run.id} onChange={e => onPick(e.target.value)}>
        {[...project.runs].reverse().map(r => <option key={r.id} value={r.id}>{r.label} · {fmtDate(r.createdAt)}</option>)}
      </select>
    </label>
  )
}

const NoRuns = ({ project }: { project: Project }) => (
  <Empty title="No runs yet">
    <p className="muted">{project.endpoints.length ? 'Your endpoints and prompts are ready. Run the benchmark to see results here.' : 'Add the providers you are comparing, then run.'}</p>
    <div className="row gap center-x wrap">
      {!project.endpoints.length && <Link href={`/app/p/${project.id}/endpoints?add=1`} className="btn ghost">Add endpoints</Link>}
      <Link href={`/app/p/${project.id}/run`} className="btn accent">Run benchmark</Link>
      <Link href={`/app/p/${project.id}/history`} className="btn ghost">Import a result file</Link>
    </div>
  </Empty>
)

// ---------- Results ----------

function Overview({ project }: { project: Project }) {
  const { run, setRunId } = useRunPick(project)
  const [by, setBy] = useState<RankBy>(getDefaults().rankBy)
  if (!run) return <NoRuns project={project} />
  return <Results project={project} run={run} by={by} setBy={setBy} onPick={setRunId} />
}

export function summaryRows(run: Run, sums: Summary[], metric: 'ttft' | 'tps' | 'e2e') {
  return sums.map(s => {
    const ok = run.results.filter(r => r.endpointId === s.endpoint.id && r.ok)
    const values = metric === 'tps' ? ok.map(decodeTps).filter((x): x is number => x !== null) : ok.map(r => metric === 'ttft' ? r.ttftMs! : r.totalMs!)
    return { id: s.endpoint.id, label: s.endpoint.name, color: colorOf(run, s.endpoint.id), values, p50: s[metric]?.p50 ?? null, ci: s[metric]?.ci }
  })
}

function Results({ project, run, by, setBy, onPick }: { project: Project; run: Run; by: RankBy; setBy(b: RankBy): void; onPick(id: string): void }) {
  const sums = useMemo(() => leaderboard(run, by), [run, by])
  const matrix = useMemo(() => promptMatrix(run), [run])
  const nameOf = (id: string) => run.endpoints.find(e => e.id === id)?.name ?? id
  const promptName = (id: string) => run.prompts.find(p => p.id === id)?.name ?? id
  const [racePrompt, setRacePrompt] = useState(() => [...run.prompts].sort((a, b) => b.maxTokens - a.maxTokens)[0]?.id ?? '')
  const race = run.endpoints.map(e => ({ id: e.id, label: e.name, color: colorOf(run, e.id), r: run.results.find(r => r.endpointId === e.id && r.promptId === racePrompt && r.ok)! })).filter(x => x.r)
  const errors = run.results.filter(r => !r.ok && r.errorKind !== 'aborted')
  const networkFails = errors.filter(r => r.errorKind === 'network').length
  const best = sums[0]
  const share = async () => {
    try {
      const s = await encodeShare(run)
      const url = `${location.origin}/app/share#r=${s}`
      await navigator.clipboard.writeText(url)
      toast(`Share link copied (${Math.round(url.length / 1000)}k characters). It contains summary timings and prompt names, never keys.`, { tone: 'ok' })
    } catch { toast('Could not copy the link. Export JSON instead.', { tone: 'error' }) }
  }
  const slug = `${project.name}-${run.label}`.replace(/[^\w]+/g, '-').toLowerCase()
  return (
    <div className="stack-lg">
      <div className="toolbar">
        {project.runs.length > 1 ? <RunPicker project={project} run={run} onPick={onPick} /> : <span className="muted small">{run.label} · {fmtDate(run.createdAt)}</span>}
        <span className="muted small">{run.results.length} requests · {run.config.reps}× each · concurrency {run.config.concurrency}{run.durationMs ? ` · ${fmtMs(run.durationMs)} wall clock` : ''}{run.source === 'node' ? ' · terminal run' : ''}</span>
        <div className="row gap-sm wrap push">
          <button type="button" className="btn ghost sm" onClick={() => download(`${slug}.csv`, resultsCsv(run, decodeTps))}>CSV</button>
          <button type="button" className="btn ghost sm" onClick={() => download(`${slug}.json`, exportRunJson(run), 'application/json')}>JSON</button>
          <button type="button" className="btn ghost sm" onClick={() => void share()}>Copy share link</button>
          <Link className="btn ghost sm" href={`/app/p/${project.id}/report?run=${run.id}`}>Report</Link>
        </div>
      </div>
      {run.source === 'sample' && <p className="note">Synthetic data: providers A, B and C are fake and their timings are generated. Use it to learn the charts, not to choose a vendor.</p>}
      {networkFails > 0 && <p className="note warn">{networkFails} request{networkFails === 1 ? '' : 's'} failed before reaching the provider, which in a browser usually means CORS. <Link href={`/app/p/${project.id}/run#terminal`}>Run the same benchmark from your terminal</Link> and import the file.</p>}

      {best?.e2e && (
        <div className="kpis">
          <div className="kpi"><span>Fastest end to end</span><strong>{best.endpoint.name}</strong><em className="mono">{fmtMs(sums.slice().sort((a, b) => (a.e2e?.p50 ?? Infinity) - (b.e2e?.p50 ?? Infinity))[0].e2e?.p50)}</em></div>
          <KpiBest sums={sums} label="Lowest median TTFT" pick={s => s.ttft?.p50} fmt={fmtMs} />
          <KpiBest sums={sums} label="Fastest decode" pick={s => s.tps ? -s.tps.p50 : undefined} fmt={v => `${fmtTps(-v)} tok/s`} />
          <KpiBest sums={sums} label="Most consistent" pick={s => s.tpsCv ?? undefined} fmt={v => `CV ${(v * 100).toFixed(0)}%`} />
        </div>
      )}

      <div className="card pad">
        <div className="row between wrap gap-sm">
          <h2 className="h4">Leaderboard on your prompts</h2>
          <label className="field inline"><span>Rank by</span><select value={by} onChange={e => setBy(e.target.value as RankBy)}>{(Object.keys(RANK_LABEL) as RankBy[]).map(k => <option key={k} value={k}>{RANK_LABEL[k]}</option>)}</select></label>
        </div>
        <LeaderTable sums={sums} run={run} />
        <p className="muted small">Medians with 95% bootstrap intervals in brackets. Decode speed counts tokens after the first, over the time after the first token. {sums.some(s => s.usageShare < 1 && s.ok) && 'Rows marked ≈ used the local token approximation because the provider did not report usage.'}</p>
      </div>

      <div className="grid-2">
        <div className="card pad"><DotPlot title="Time to first token" rows={summaryRows(run, sums, 'ttft')} format={fmtMs} log /></div>
        <div className="card pad"><DotPlot title="Output tokens per second" rows={summaryRows(run, sums, 'tps')} format={fmtTps} higherBetter log /></div>
      </div>
      <div className="card pad"><DotPlot title="End-to-end latency" rows={summaryRows(run, sums, 'e2e')} format={fmtMs} log /></div>

      <div className="card pad">
        <div className="row between wrap gap-sm">
          <h2 className="h4">The race on one prompt</h2>
          <label className="field inline"><span>Prompt</span><select value={racePrompt} onChange={e => setRacePrompt(e.target.value)}>{run.prompts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        </div>
        {race.length ? <RaceChart title={promptName(racePrompt)} series={race} /> : <p className="muted small">No successful request for this prompt.</p>}
      </div>

      <div className="card pad">
        <h2 className="h4">Per prompt medians</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Prompt</th><th className="num">Target</th>{run.endpoints.map(e => <th key={e.id} className="num"><i className="sw" style={{ background: colorOf(run, e.id) }} />{e.name}</th>)}</tr></thead>
            <tbody>{matrix.map(m => (
              <tr key={m.prompt.id}>
                <td><strong>{m.prompt.name}</strong> <span className="muted small">{m.prompt.suite}</span></td>
                <td className="num mono">{m.prompt.maxTokens}</td>
                {m.cells.map(c => <td key={c.endpointId} className={`num mono${m.winner === c.endpointId ? ' win' : ''}`}>{c.e2e === null ? <span className="error">{c.total ? 'failed' : 'n/a'}</span> : <>{fmtMs(c.e2e)}<span className="sub">{fmtMs(c.ttft)} · {fmtTps(c.tps)} t/s{c.ok < c.total ? ` · ${c.total - c.ok} err` : ''}</span></>}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="muted small">End-to-end median, then TTFT and decode speed. Highlight marks the fastest endpoint for each prompt.</p>
      </div>

      <div className="card pad">
        <h2 className="h4">Inter-token latency</h2>
        <p className="muted small">Gaps between streamed chunks, spread over the tokens in each chunk. A long right tail is what readers feel as stutter. Jitter = median change between consecutive gaps.</p>
        <ItlHistograms rows={sums.map(s => ({ id: s.endpoint.id, label: `${s.endpoint.name}${s.jitterMs !== null ? ` · jitter ${s.jitterMs.toFixed(2)} ms` : ''}`, color: colorOf(run, s.endpoint.id), values: run.results.filter(r => r.endpointId === s.endpoint.id).flatMap(interTokenLatencies) }))} />
      </div>

      <div className="card pad">
        <Timeline results={run.results} colorOf={id => colorOf(run, id)} labelOf={r => `${nameOf(r.endpointId)} / ${promptName(r.promptId)}`} />
        <Legend items={run.endpoints.map(e => ({ label: e.name, color: colorOf(run, e.id) }))} />
      </div>

      {errors.length > 0 && (
        <details className="card pad">
          <summary><h2 className="h4 inline">Errors ({errors.length})</h2></summary>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Endpoint</th><th>Prompt</th><th>Kind</th><th>Message</th><th className="num">After</th></tr></thead>
            <tbody>{errors.map((r, i) => <tr key={i}><td>{nameOf(r.endpointId)}</td><td>{promptName(r.promptId)}</td><td><span className={`badge ${r.errorKind === 'rate_limit' ? 'warn' : 'bad'}`}>{r.errorKind === 'rate_limit' ? '429' : r.errorKind}</span></td><td className="small break-word">{r.error}</td><td className="num mono">{fmtMs(r.totalMs)}</td></tr>)}</tbody>
          </table></div>
        </details>
      )}
    </div>
  )
}

function KpiBest({ sums, label, pick, fmt }: { sums: Summary[]; label: string; pick(s: Summary): number | undefined; fmt(v: number): string }) {
  const c = sums.filter(s => pick(s) !== undefined).sort((a, b) => pick(a)! - pick(b)!)[0]
  if (!c) return null
  return <div className="kpi"><span>{label}</span><strong>{c.endpoint.name}</strong><em className="mono">{fmt(pick(c)!)}</em></div>
}

export function LeaderTable({ sums, run }: { sums: Summary[]; run: Run }) {
  const ci = (s: { ci: [number, number] } | null, f: (n: number) => string) => s && s.ci[0] !== s.ci[1] ? <span className="sub">[{f(s.ci[0])} to {f(s.ci[1])}]</span> : null
  return (
    <div className="table-wrap">
      <table className="table leader">
        <thead><tr><th>#</th><th>Endpoint</th><th className="num">TTFT p50</th><th className="num">TTFT p90</th><th className="num">Tokens/s p50</th><th className="num">E2E p50</th><th className="num">E2E p99</th><th className="num">Consistency</th><th className="num">Errors</th><th className="num">429s</th><th className="num">$ / 1M</th></tr></thead>
        <tbody>{sums.map((s, i) => (
          <tr key={s.endpoint.id}>
            <td className="mono">{s.ok ? i + 1 : '–'}</td>
            <td><i className="sw" style={{ background: colorOf(run, s.endpoint.id) }} /><strong>{s.endpoint.name}</strong><span className="sub mono">{s.endpoint.model}</span></td>
            <td className="num mono">{fmtMs(s.ttft?.p50)}{ci(s.ttft, fmtMs)}</td>
            <td className="num mono">{fmtMs(s.ttft?.p90)}</td>
            <td className="num mono">{s.usageShare < 1 && s.ok ? '≈' : ''}{fmtTps(s.tps?.p50)}{ci(s.tps, fmtTps)}</td>
            <td className="num mono">{fmtMs(s.e2e?.p50)}{ci(s.e2e, fmtMs)}</td>
            <td className="num mono">{fmtMs(s.e2e?.p99)}</td>
            <td className="num mono" title="Coefficient of variation of decode speed across requests">{s.tpsCv === null ? 'n/a' : `${(s.tpsCv * 100).toFixed(0)}%`}</td>
            <td className={`num mono${s.errorRate > 0.05 ? ' error' : ''}`}>{(s.errorRate * 100).toFixed(0)}%</td>
            <td className={`num mono${s.rateLimitRate > 0 ? ' warn-t' : ''}`}>{(s.rateLimitRate * 100).toFixed(0)}%</td>
            <td className="num mono" title={s.cost !== null ? `$${s.cost.toFixed(4)} for this run` : 'Enter prices on the Endpoints tab'}>{s.blendedPer1M === null ? '–' : `$${s.blendedPer1M.toFixed(2)}`}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

// ---------- History and compare ----------

function History({ project, update }: { project: Project; update(p: Partial<Project>): unknown }) {
  const runs = project.runs
  const [a, setA] = useState(runs[runs.length - 2]?.id ?? '')
  const [b, setB] = useState(runs[runs.length - 1]?.id ?? '')
  const [imp, setImp] = useState<{ run: Run | null; issues: Issue[]; name: string } | null>(null)
  const ra = runs.find(r => r.id === a), rb = runs.find(r => r.id === b)
  const rows = useMemo(() => ra && rb && ra !== rb ? compareRuns(ra, rb) : [], [ra, rb])
  const onFile = async (f: File) => setImp({ ...importRun(await f.text()), name: f.name })
  const remove = (r: Run) => {
    const before = project.runs
    void update({ runs: before.filter(x => x.id !== r.id) })
    const t = setTimeout(() => void deleteRunCloud(r.id), 9000)
    toast(`Deleted run "${r.label}".`, { undo: () => { clearTimeout(t); void update({ runs: before }) } })
  }
  return (
    <div className="stack-lg">
      <div className="card pad stack">
        <div className="row between wrap gap-sm">
          <h2 className="h4">Runs</h2>
          <label className="btn ghost sm file-btn">Import result file<input type="file" accept=".json,application/json" onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }} /></label>
        </div>
        {runs.length === 0 ? <p className="muted">No runs yet. Run the benchmark, or import a JSON result from the terminal script or a colleague.</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Label</th><th>When</th><th>Source</th><th className="num">Requests</th><th className="num">Endpoints</th><th /></tr></thead>
            <tbody>{[...runs].reverse().map(r => (
              <tr key={r.id}>
                <td><input className="cell-input" aria-label="Run label" defaultValue={r.label} onBlur={e => { const v = e.target.value.trim(); if (v && v !== r.label) void update({ runs: runs.map(x => x.id === r.id ? { ...x, label: v } : x) }) }} /></td>
                <td className="small">{fmtDate(r.createdAt)}</td>
                <td><span className="badge">{r.source}</span></td>
                <td className="num mono">{r.results.length}</td>
                <td className="num mono">{r.endpoints.length}</td>
                <td className="row gap-sm end"><Link className="btn ghost sm" href={`/app/p/${project.id}/overview?run=${r.id}`}>Open</Link><button type="button" className="btn danger-ghost sm" onClick={() => remove(r)}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {runs.length >= 2 && (
        <div className="card pad stack">
          <h2 className="h4">Compare two runs</h2>
          <div className="row gap wrap">
            <label className="field"><span>Before</span><select value={a} onChange={e => setA(e.target.value)}>{runs.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
            <label className="field"><span>After</span><select value={b} onChange={e => setB(e.target.value)}>{runs.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
          </div>
          {a === b ? <p className="muted small">Pick two different runs.</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Endpoint</th><th className="num">TTFT p50</th><th className="num">Tokens/s p50</th><th className="num">E2E p50</th><th className="num">E2E p99</th><th className="num">Error rate</th></tr></thead>
              <tbody>{rows.map(r => (
                <tr key={r.key}>
                  <td><strong>{r.name}</strong>{!r.a && <span className="badge">new</span>}{!r.b && <span className="badge">dropped</span>}</td>
                  <Delta a={r.a?.ttft?.p50} b={r.b?.ttft?.p50} f={fmtMs} lowerBetter />
                  <Delta a={r.a?.tps?.p50} b={r.b?.tps?.p50} f={fmtTps} />
                  <Delta a={r.a?.e2e?.p50} b={r.b?.e2e?.p50} f={fmtMs} lowerBetter />
                  <Delta a={r.a?.e2e?.p99} b={r.b?.e2e?.p99} f={fmtMs} lowerBetter />
                  <td className="num mono">{r.a ? `${(r.a.errorRate * 100).toFixed(0)}%` : '–'} → {r.b ? `${(r.b.errorRate * 100).toFixed(0)}%` : '–'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <p className="muted small">Endpoints are matched by base URL and model, so runs imported from other devices line up. Changes under about 10% are often noise at 3 repetitions; check the intervals on each run.</p>
        </div>
      )}

      <Modal open={!!imp} onClose={() => setImp(null)} title={`Import ${imp?.name ?? ''}`}>
        {imp && <ImportReport imp={imp} onAdd={run => { void update({ runs: [...project.runs, run].sort((x, y) => x.createdAt - y.createdAt) }); setImp(null); toast(`Imported "${run.label}".`, { tone: 'ok' }); go(`/app/p/${project.id}/overview?run=${run.id}`) }} onCancel={() => setImp(null)} />}
      </Modal>
    </div>
  )
}

export function ImportReport({ imp, onAdd, onCancel }: { imp: { run: Run | null; issues: Issue[] }; onAdd(r: Run): void; onCancel(): void }) {
  const errs = imp.issues.filter(i => i.level === 'error').length
  return (
    <div className="stack">
      {imp.run ? <p><strong>{imp.run.label}</strong>: {imp.run.results.length} requests across {imp.run.endpoints.length} endpoints and {imp.run.prompts.length} prompts.</p> : <p className="error">Nothing could be imported.</p>}
      <IssueList issues={imp.issues} />
      {imp.run && errs > 0 && <p className="muted small">{errs} row{errs === 1 ? ' was' : 's were'} skipped. The rest import normally.</p>}
      <div className="row end gap"><button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>{imp.run && <button type="button" className="btn primary" onClick={() => onAdd(imp.run!)}>Add to history</button>}</div>
    </div>
  )
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <p className="ok-t small">Validation passed: no issues.</p>
  return (
    <div className="issues" role="list" aria-label="Validation report">
      {issues.slice(0, 200).map((i, k) => <div key={k} role="listitem" className={`issue ${i.level}`}><span className="mono">line {i.line}</span><span className="badge">{i.level}</span>{i.message}</div>)}
      {issues.length > 200 && <p className="muted small">and {issues.length - 200} more</p>}
    </div>
  )
}

function Delta({ a, b, f, lowerBetter }: { a?: number | null; b?: number | null; f(n: number): string; lowerBetter?: boolean }) {
  const d = relChange(a, b)
  const good = d === null ? null : lowerBetter ? d < -0.03 : d > 0.03
  const bad = d === null ? null : lowerBetter ? d > 0.03 : d < -0.03
  return <td className="num mono">{a == null ? '–' : f(a)} → {b == null ? '–' : f(b)}{d !== null && <span className={`delta ${good ? 'good' : bad ? 'bad' : ''}`}>{d > 0 ? '+' : ''}{(d * 100).toFixed(0)}%</span>}</td>
}

// ---------- Agent loop estimator ----------

function Agent({ project, update }: { project: Project; update(p: Partial<Project>): unknown }) {
  const { run, setRunId } = useRunPick(project)
  const L = project.loop
  const set = (patch: Partial<Project['loop']>) => void update({ loop: { ...L, ...patch } })
  const steps = useMemo(() => growingLoop(L.steps, L.firstInput, L.output, L.toolTokens), [L])
  const est = useMemo(() => run ? run.endpoints.map(e => ({ e, r: estimateLoop(run.results.filter(r => r.endpointId === e.id), steps, { toolMs: L.toolMs }) })) : [], [run, steps, L.toolMs])
  if (!run) return <NoRuns project={project} />
  const max = Math.max(1, ...est.map(x => x.r?.p90 ?? 0))
  const num = (k: keyof Project['loop'], label: string, min: number, maxV: number, step = 1) => (
    <label className="field"><span>{label}</span><input type="number" min={min} max={maxV} step={step} value={L[k]} onChange={e => set({ [k]: Math.min(maxV, Math.max(min, Math.round(+e.target.value || min))) })} /></label>
  )
  return (
    <div className="stack-lg">
      <div className="card pad stack">
        <div className="row between wrap gap-sm"><h2 className="h4">Time to finish this agent loop</h2>{project.runs.length > 1 && <RunPicker project={project} run={run} onPick={setRunId} />}</div>
        <p className="muted small">An agent makes k model calls in sequence: each waits for the first token, streams its output, runs a tool, and the context grows. Latency multiplies by k. Estimated by resampling this run's measured (TTFT, tokens/s) pairs 2,000 times.</p>
        <div className="row gap wrap">
          {num('steps', 'Sequential calls (k)', 1, 200)}
          {num('firstInput', 'First prompt tokens', 1, 200000, 100)}
          {num('output', 'Output tokens per call', 1, 32000, 50)}
          {num('toolTokens', 'Tool result tokens per call', 0, 50000, 100)}
          {num('toolMs', 'Tool time per call (ms)', 0, 120000, 50)}
        </div>
        <p className="muted small mono">Context grows to {steps[steps.length - 1].inputTokens.toLocaleString()} tokens by call {L.steps}. Total generated: {(L.steps * L.output).toLocaleString()} tokens.</p>
      </div>
      <div className="card pad">
        <div className="loop-bars">
          {est.map(({ e, r }) => (
            <div key={e.id} className="loop-row">
              <div className="loop-name"><i className="sw" style={{ background: colorOf(run, e.id) }} />{e.name}</div>
              {r ? <>
                <div className="loop-track" aria-hidden="true">
                  <div className="loop-p90" style={{ width: `${r.p90 / max * 100}%`, background: colorOf(run, e.id) }} />
                  <div className="loop-p50" style={{ width: `${r.p50 / max * 100}%`, background: colorOf(run, e.id) }} />
                </div>
                <div className="loop-val mono"><strong>{fmtMs(r.p50)}</strong> typical · {fmtMs(r.p90)} p90</div>
                <div className="loop-note muted small">{r.prefillModel ? 'TTFT modelled as growing with context (fit from your long and short prompts).' : 'TTFT resampled as measured; add long-context prompts to model prefill growth.'} {r.samples} samples. Tool time {fmtMs(L.toolMs * L.steps)} of the total.</div>
              </> : <div className="muted small">No successful requests to estimate from.</div>}
            </div>
          ))}
        </div>
      </div>
      <CopyButton text={est.map(({ e, r }) => `${e.name}: ${r ? `${fmtMs(r.p50)} typical, ${fmtMs(r.p90)} p90` : 'n/a'}`).join('\n') + `\n(${L.steps} calls, ${L.output} output tokens each, context from ${L.firstInput} tokens, ${L.toolMs} ms tool time per call)`} label="Copy estimate" />
    </div>
  )
}
