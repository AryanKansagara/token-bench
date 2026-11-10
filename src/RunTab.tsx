import { useEffect, useMemo, useRef, useState } from 'react'
import { runBenchmark } from './engine/runner.ts'
import { replayFetch, sampleRun } from './engine/sample.ts'
import { nodeScript } from './engine/script.ts'
import { decodeTps, quantile } from './engine/stats.ts'
import type { RequestResult, Run, RunConfig } from './engine/types.ts'
import { Dial } from './charts.tsx'
import { colorOf } from './projectData.ts'
import { Diagnosis } from './Setup.tsx'
import { getKeys, uuid, type Project } from './store.ts'
import { Code, CopyButton, download, fmtMs, fmtTps, go, Link, toast } from './ui.tsx'

/** Synthetic endpoints are answered by a local replay; everything else goes to the network. */
function transport(): typeof fetch {
  const replay = replayFetch(sampleRun())
  return ((input: RequestInfo | URL, init?: RequestInit) => String(input).includes('.example/') ? replay(input, init) : fetch(input, init)) as typeof fetch
}

export default function RunTab({ project, update }: { project: Project; update(p: Partial<Project>): unknown }) {
  const cfg = project.config
  const setCfg = (p: Partial<RunConfig>) => void update({ config: { ...cfg, ...p } })
  const [eps, setEps] = useState<Set<string>>(() => new Set(project.endpoints.map(e => e.id)))
  const [prs, setPrs] = useState<Set<string>>(() => new Set(project.prompts.map(p => p.id)))
  const [label, setLabel] = useState('')
  const [live, setLive] = useState<{ results: RequestResult[]; total: number; inFlight: number; t0: number } | null>(null)
  const [running, setRunning] = useState(false)
  const ctrl = useRef<AbortController | null>(null)
  const endpoints = project.endpoints.filter(e => eps.has(e.id))
  const prompts = project.prompts.filter(p => prs.has(p.id))
  const total = endpoints.length * prompts.length * cfg.reps
  const outTokens = prompts.reduce((a, p) => a + p.maxTokens, 0) * endpoints.length * cfg.reps
  useEffect(() => { if (location.hash === '#terminal') setTimeout(() => document.getElementById('terminal')?.scrollIntoView({ behavior: 'smooth' }), 80) }, [])
  useEffect(() => () => ctrl.current?.abort(), [])

  const start = async () => {
    if (!total) return
    const c = new AbortController()
    ctrl.current = c
    setRunning(true)
    const t0 = performance.now()
    let inFlight = 0
    const acc: RequestResult[] = []
    setLive({ results: [], total, inFlight: 0, t0 })
    const keys = await getKeys(endpoints.map(e => e.id))
    const { results, durationMs } = await runBenchmark(endpoints, prompts, cfg, {
      keys, signal: c.signal, fetch: transport(),
      onStart: () => { inFlight++; setLive(l => l && { ...l, inFlight }) },
      onResult: r => { inFlight--; acc.push(r); setLive(l => l && { ...l, results: [...acc], inFlight }) },
    })
    setRunning(false)
    const done = results.filter(r => r.errorKind !== 'aborted')
    if (!done.length) { toast('Run cancelled. Nothing was saved.'); return }
    const run: Run = { id: uuid(), label: label.trim() || `Run ${project.runs.length + 1}, ${new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`, createdAt: Date.now(), source: 'browser', config: cfg, endpoints, prompts, results: done, durationMs }
    await update({ runs: [...project.runs, run] })
    setLabel('')
    const net = done.filter(r => r.errorKind === 'network').length
    if (net === done.length) toast('Every request was blocked by the browser (likely CORS). The run is saved; use the terminal script below for these providers.', { tone: 'error', ttl: 9000 })
    else toast(`${c.signal.aborted ? 'Partial run' : 'Run'} saved: ${done.filter(r => r.ok).length}/${done.length} requests succeeded.`, { tone: 'ok', action: { label: 'View results', run: () => go(`/app/p/${project.id}/overview?run=${run.id}`) } })
  }

  const stats = useMemo(() => live ? project.endpoints.filter(e => eps.has(e.id)).map(e => {
    const ok = live.results.filter(r => r.endpointId === e.id && r.ok)
    const tps = ok.map(decodeTps).filter((x): x is number => x !== null)
    return { e, n: live.results.filter(r => r.endpointId === e.id).length, ok: ok.length, ttft: ok.length ? quantile(ok.map(r => r.ttftMs!), 0.5) : null, tps: tps.length ? quantile(tps, 0.5) : null, err: live.results.filter(r => r.endpointId === e.id && !r.ok && r.errorKind !== 'aborted') }
  }) : [], [live, project.endpoints, eps])
  const maxTps = Math.max(200, ...stats.map(s => s.tps ?? 0)) * 1.15
  const firstNet = live?.results.find(r => r.errorKind === 'network')
  const script = useMemo(() => nodeScript(endpoints.filter(e => !e.baseUrl.includes('.example/')), prompts, cfg), [endpoints, prompts, cfg])

  const num = (k: keyof RunConfig, label: string, min: number, max: number, step = 1, hint?: string) => (
    <label className="field"><span>{label}</span><input type="number" min={min} max={max} step={step} value={cfg[k]} disabled={running} onChange={e => setCfg({ [k]: Math.min(max, Math.max(min, +e.target.value || min)) })} />{hint && <em className="muted small">{hint}</em>}</label>
  )

  if (!project.endpoints.length || !project.prompts.length) return (
    <div className="empty"><h3>Almost ready</h3><p className="muted">A run needs at least one endpoint and one prompt.</p>
      <div className="row gap center-x">{!project.endpoints.length && <Link className="btn accent" href={`/app/p/${project.id}/endpoints?add=1`}>Add endpoints</Link>}{!project.prompts.length && <Link className="btn ghost" href={`/app/p/${project.id}/prompts`}>Pick prompts</Link>}</div></div>
  )

  return (
    <div className="stack-lg">
      <div className="grid-2">
        <div className="card pad stack">
          <h2 className="h4">Settings</h2>
          <div className="row gap wrap">
            {num('reps', 'Repetitions', 1, 50, 1, '3+ for intervals')}
            {num('concurrency', 'Parallel requests', 1, 64, 1, 'total, across endpoints')}
            {num('rampMs', 'Ramp (ms per worker)', 0, 30000, 50)}
            {num('timeoutMs', 'Timeout (ms)', 1000, 600000, 1000)}
            {num('temperature', 'Temperature', 0, 2, 0.1)}
          </div>
          <label className="field"><span>Run label</span><input value={label} onChange={e => setLabel(e.target.value)} placeholder={`Run ${project.runs.length + 1}`} disabled={running} /></label>
        </div>
        <div className="card pad stack">
          <h2 className="h4">What runs</h2>
          <fieldset className="checks"><legend>Endpoints</legend>
            {project.endpoints.map(e => <label key={e.id} className="check"><input type="checkbox" disabled={running} checked={eps.has(e.id)} onChange={ev => { const n = new Set(eps); ev.target.checked ? n.add(e.id) : n.delete(e.id); setEps(n) }} /><i className="sw" style={{ background: colorOf(project, e.id) }} />{e.name}</label>)}
          </fieldset>
          <fieldset className="checks"><legend>Prompts <button type="button" className="linkish small" disabled={running} onClick={() => setPrs(prs.size === project.prompts.length ? new Set() : new Set(project.prompts.map(p => p.id)))}>{prs.size === project.prompts.length ? 'none' : 'all'}</button></legend>
            <div className="checks-scroll">{project.prompts.map(p => <label key={p.id} className="check"><input type="checkbox" disabled={running} checked={prs.has(p.id)} onChange={ev => { const n = new Set(prs); ev.target.checked ? n.add(p.id) : n.delete(p.id); setPrs(n) }} />{p.name} <span className="muted small">{p.maxTokens} tok</span></label>)}</div>
          </fieldset>
          <p className="muted small mono">{total} requests · up to {outTokens.toLocaleString()} output tokens billed by your providers</p>
          <div className="row gap-sm">
            {!running ? <button type="button" className="btn accent lg" disabled={!total} onClick={() => void start()}>Start run</button>
              : <button type="button" className="btn danger lg" onClick={() => ctrl.current?.abort()}>Cancel</button>}
          </div>
        </div>
      </div>

      {live && (
        <div className="card pad stack live" aria-live="polite">
          <div className="row between wrap gap-sm">
            <h2 className="h4">{running ? 'Running' : 'Last run'}: {live.results.length} / {live.total}</h2>
            <span className="muted small mono">{running ? `${live.inFlight} in flight` : 'finished'}</span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={live.total} aria-valuenow={live.results.length}><div style={{ width: `${live.results.length / live.total * 100}%` }} /></div>
          <div className="live-grid">
            {stats.map(s => (
              <div key={s.e.id} className="live-ep" style={{ borderTopColor: colorOf(project, s.e.id) }}>
                <strong>{s.e.name}</strong>
                <div className="row gap-sm center-x wrap">
                  <Dial value={s.ttft} max={3000} log label="TTFT p50" unit="ms" color={colorOf(project, s.e.id)} size={130} />
                  <Dial value={s.tps} max={maxTps} label="decode p50" unit="tok/s" color={colorOf(project, s.e.id)} size={130} />
                </div>
                <span className="muted small mono">{s.ok}/{s.n} ok{s.err.length ? ` · ${s.err.length} failed (${[...new Set(s.err.map(e => e.errorKind === 'rate_limit' ? '429' : e.errorKind))].join(', ')})` : ''}</span>
              </div>
            ))}
          </div>
          <ol className="log mono small" reversed>
            {live.results.slice(-8).reverse().map((r, i) => {
              const e = project.endpoints.find(x => x.id === r.endpointId)
              const p = project.prompts.find(x => x.id === r.promptId)
              return <li key={i} className={r.ok ? '' : 'error'}>{e?.name} · {p?.name} · {r.ok ? `TTFT ${fmtMs(r.ttftMs)}, ${r.outputTokens} tok, ${fmtTps(decodeTps(r))} tok/s, ${fmtMs(r.totalMs)}` : r.error}</li>
            })}
          </ol>
          {firstNet && <Diagnosis r={firstNet} e={project.endpoints.find(e => e.id === firstNet.endpointId)!} project={project} />}
        </div>
      )}

      <div className="card pad stack" id="terminal">
        <h2 className="h4">Run it from your terminal instead</h2>
        <p className="muted small">Browsers enforce CORS; terminals do not. This script runs the identical benchmark (same prompts, settings, timing method) with Node 18+ and no dependencies, then writes a JSON file you import under <Link href={`/app/p/${project.id}/history`}>History</Link>. Keys are read from environment variables and are never written into the script. Also useful for measuring from a server in the same region as your production app.</p>
        <div className="row gap-sm wrap">
          <button type="button" className="btn primary sm" onClick={() => download('token-bench.mjs', script, 'text/javascript')}>Download token-bench.mjs</button>
          <CopyButton text={script} label="Copy script" />
        </div>
        <Code label="Then" code={`node token-bench.mjs results.json`} />
        <details><summary className="small">Preview the script</summary><pre className="script-pre">{script.slice(0, 2400)}{script.length > 2400 ? '\n...' : ''}</pre></details>
      </div>
    </div>
  )
}
