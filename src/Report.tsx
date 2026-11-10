import { useEffect, useMemo } from 'react'
import { estimateLoop, growingLoop } from './engine/agent.ts'
import { leaderboard, promptMatrix } from './engine/stats.ts'
import { DotPlot } from './charts.tsx'
import { LeaderTable, summaryRows } from './Project.tsx'
import { colorOf, latestRun } from './projectData.ts'
import { useProjects } from './store.ts'
import { fmtDate, fmtMs, fmtTps, Link, ThemeToggle } from './ui.tsx'

export default function Report({ id }: { id: string }) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const runId = new URLSearchParams(location.search).get('run')
  const run = project ? project.runs.find(r => r.id === runId) ?? latestRun(project) : undefined
  const sums = useMemo(() => run ? leaderboard(run, 'e2e') : [], [run])
  const matrix = useMemo(() => run ? promptMatrix(run) : [], [run])
  const loop = project?.loop
  const est = useMemo(() => run && loop ? run.endpoints.map(e => ({ e, r: estimateLoop(run.results.filter(r => r.endpointId === e.id), growingLoop(loop.steps, loop.firstInput, loop.output, loop.toolTokens), { toolMs: loop.toolMs }) })) : [], [run, loop])
  useEffect(() => { if (project && run) document.title = `${project.name}: ${run.label} · Token Bench report` }, [project, run])
  if (list === null) return <div className="boot" role="status"><span className="spinner" /> Loading</div>
  if (!project || !run) return <section className="page narrow center"><h1>No report</h1><p className="muted">This benchmark has no runs yet.</p><Link href="/app" className="btn primary">Benchmarks</Link></section>
  const best = sums[0]
  const fastestTps = [...sums].sort((a, b) => (b.tps?.p50 ?? 0) - (a.tps?.p50 ?? 0))[0]
  return (
    <article className="report">
      <div className="report-bar no-print">
        <Link href={`/app/p/${id}/overview?run=${run.id}`} className="btn ghost sm">Back</Link>
        <div className="row gap-sm"><ThemeToggle /><button type="button" className="btn primary sm" onClick={() => print()}>Print or save PDF</button></div>
      </div>
      <header className="report-head">
        <p className="eyebrow">Inference benchmark report</p>
        <h1>{project.name}</h1>
        <p className="muted">{run.label} · {fmtDate(run.createdAt)} · {run.results.length} streamed requests · {run.endpoints.length} endpoints · {run.prompts.length} prompts × {run.config.reps} repetitions · concurrency {run.config.concurrency} · temperature {run.config.temperature}{run.source === 'node' ? ' · measured from a terminal' : run.source === 'browser' ? ' · measured from a browser' : ''}</p>
        {run.source === 'sample' && <p className="note">Synthetic data: providers A, B and C are fake. This report demonstrates the format only.</p>}
      </header>
      {best?.e2e && (
        <section>
          <h2>Summary</h2>
          <p><strong>{best.endpoint.name}</strong> had the lowest median end-to-end latency on these prompts ({fmtMs(best.e2e.p50)}, 95% interval {fmtMs(best.e2e.ci[0])} to {fmtMs(best.e2e.ci[1])}). {fastestTps?.tps && <>Fastest decode: <strong>{fastestTps.endpoint.name}</strong> at {fmtTps(fastestTps.tps.p50)} output tokens per second. </>}{sums.filter(s => s.errorRate > 0).map(s => `${s.endpoint.name} failed ${(s.errorRate * 100).toFixed(0)}% of requests${s.rateLimitRate ? ` (${(s.rateLimitRate * 100).toFixed(0)}% rate limited)` : ''}`).join('; ')}{sums.some(s => s.errorRate > 0) ? '.' : 'No endpoint returned errors.'}</p>
        </section>
      )}
      <section><h2>Leaderboard</h2><LeaderTable sums={sums} run={run} /></section>
      <section className="report-charts">
        <DotPlot title="Time to first token" rows={summaryRows(run, sums, 'ttft')} format={fmtMs} log />
        <DotPlot title="Output tokens per second" rows={summaryRows(run, sums, 'tps')} format={fmtTps} higherBetter log />
        <DotPlot title="End-to-end latency" rows={summaryRows(run, sums, 'e2e')} format={fmtMs} log />
      </section>
      <section>
        <h2>Per prompt (median end to end)</h2>
        <table className="table">
          <thead><tr><th>Prompt</th>{run.endpoints.map(e => <th key={e.id} className="num"><i className="sw" style={{ background: colorOf(run, e.id) }} />{e.name}</th>)}</tr></thead>
          <tbody>{matrix.map(m => <tr key={m.prompt.id}><td>{m.prompt.name} <span className="muted small">{m.prompt.maxTokens} tok</span></td>{m.cells.map(c => <td key={c.endpointId} className={`num mono${m.winner === c.endpointId ? ' win' : ''}`}>{fmtMs(c.e2e)}</td>)}</tr>)}</tbody>
        </table>
      </section>
      {loop && (
        <section>
          <h2>Agent loop estimate</h2>
          <p className="muted small">{loop.steps} sequential calls, {loop.output} output tokens each, context growing from {loop.firstInput.toLocaleString()} tokens by {loop.toolTokens} tool tokens per call, {loop.toolMs} ms tool time per call.</p>
          <table className="table"><thead><tr><th>Endpoint</th><th className="num">Typical (p50)</th><th className="num">Slow (p90)</th></tr></thead>
            <tbody>{est.map(({ e, r }) => <tr key={e.id}><td>{e.name}</td><td className="num mono">{fmtMs(r?.p50)}</td><td className="num mono">{fmtMs(r?.p90)}</td></tr>)}</tbody></table>
        </section>
      )}
      <section className="small muted">
        <h2>Method</h2>
        <p>Each request is a streamed OpenAI-compatible chat completion. TTFT is the time from sending the request to the first chunk with content. Decode speed is (output tokens − 1) divided by the time after the first token. Output tokens come from the provider's usage chunk where available, otherwise a local approximation (≈). Medians carry 95% percentile-bootstrap intervals (1,000 resamples). Consistency is the coefficient of variation of decode speed. Prices are user-entered. Requests were interleaved across endpoints so no provider got a quieter minute.</p>
        <p>Generated with Token Bench, an independent tool not affiliated with any provider measured here.</p>
      </section>
    </article>
  )
}
