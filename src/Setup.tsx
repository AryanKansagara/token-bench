import { useEffect, useState } from 'react'
import { FIELDS, importPrompts, type Mapping, type PromptImport } from './engine/parse.ts'
import { streamChat } from './engine/request.ts'
import { replayFetch, sampleRun } from './engine/sample.ts'
import { approxTokens } from './engine/sse.ts'
import { PRESETS, SUITES } from './engine/suites.ts'
import type { Endpoint, Prompt, RequestResult } from './engine/types.ts'
import { IssueList } from './Project.tsx'
import { colorOf, SERIES } from './projectData.ts'
import { getKey, setKey, uuid, type Project } from './store.ts'
import { fmtMs, Link, Modal, toast } from './ui.tsx'

type Update = (p: Partial<Project>) => unknown

export default function Setup({ project, tab, update }: { project: Project; tab: 'endpoints' | 'prompts'; update: Update }) {
  return tab === 'endpoints' ? <Endpoints project={project} update={update} /> : <Prompts project={project} update={update} />
}

// ---------- Endpoints ----------

function Endpoints({ project, update }: { project: Project; update: Update }) {
  const [adding, setAdding] = useState(() => new URLSearchParams(location.search).get('add') === '1')
  useEffect(() => { if (adding && location.search) history.replaceState({}, '', location.pathname) }, [])
  const add = (p?: (typeof PRESETS)[number]) => {
    const used = new Set(project.endpoints.map(e => e.color))
    const e: Endpoint = { id: uuid(), name: p?.name ?? 'Custom endpoint', preset: p?.id, baseUrl: p?.baseUrl ?? 'https://', model: p?.model ?? '', streamOptions: true, color: SERIES.find(c => !used.has(c)) ?? SERIES[project.endpoints.length % SERIES.length] }
    void update({ endpoints: [...project.endpoints, e] })
    setAdding(false)
    setTimeout(() => document.getElementById(`ep-${e.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }
  const patch = (id: string, p: Partial<Endpoint>) => void update({ endpoints: project.endpoints.map(e => e.id === id ? { ...e, ...p } : e) })
  const remove = (e: Endpoint) => {
    const before = project.endpoints
    void update({ endpoints: before.filter(x => x.id !== e.id) })
    toast(`Removed ${e.name}. Its key stays on this device until you add it again or delete the benchmark.`, { undo: () => void update({ endpoints: before }) })
  }
  return (
    <div className="stack-lg">
      <div className="row between wrap gap">
        <p className="muted narrow-p">Any OpenAI-compatible <code>/chat/completions</code> endpoint. Keys are saved in this browser's IndexedDB only: never synced, exported or shared. Requests go directly from your browser to the provider.</p>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add endpoint</button>
      </div>
      {project.sampleId && <p className="note">These synthetic endpoints are served by a local replay of recorded timings, so Test and Run work without a key. Add a real provider to compare it against them.</p>}
      {project.endpoints.length === 0 && <div className="empty"><h3>No endpoints yet</h3><p className="muted">Pick a preset to start. You can add the same provider twice with different models.</p><button type="button" className="btn accent" onClick={() => setAdding(true)}>Choose a preset</button></div>}
      <div className="stack">
        {project.endpoints.map(e => <EndpointCard key={e.id} e={e} project={project} patch={p => patch(e.id, p)} remove={() => remove(e)} />)}
      </div>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add an endpoint" wide>
        <div className="preset-grid">
          {PRESETS.map(p => (
            <button key={p.id} type="button" className="preset" onClick={() => add(p)}>
              <strong>{p.name}</strong>
              <span className="mono small">{p.baseUrl.replace(/^https?:\/\//, '')}</span>
              <span className="muted small">{p.model}</span>
            </button>
          ))}
          <button type="button" className="preset" onClick={() => add()}><strong>Custom</strong><span className="muted small">vLLM, SGLang, LiteLLM, your gateway, anything OpenAI-compatible</span></button>
        </div>
        <p className="muted small">Model ids are defaults for Llama 3.3 70B; check each provider's model list for the exact id you use.</p>
      </Modal>
    </div>
  )
}

function EndpointCard({ e, project, patch, remove }: { e: Endpoint; project: Project; patch(p: Partial<Endpoint>): void; remove(): void }) {
  const [key, setKeyState] = useState<string | null>(null)
  const [show, setShow] = useState(false)
  const [test, setTest] = useState<RequestResult | 'running' | null>(null)
  useEffect(() => { void getKey(e.id).then(setKeyState) }, [e.id])
  const preset = PRESETS.find(p => p.id === e.preset)
  const isSample = e.baseUrl.includes('.example/')
  const runTest = async () => {
    setTest('running')
    const p: Prompt = { id: 'test', name: 'Connection test', suite: 'test', user: 'Reply with the single word: ready', maxTokens: 16 }
    setTest(await streamChat(e, key ?? '', p, 0, 0, { timeoutMs: 30000, ...(isSample ? { fetch: replayFetch(sampleRun()) } : {}) }))
  }
  const field = (k: 'name' | 'baseUrl' | 'model', label: string, ph: string) => (
    <label className="field"><span>{label}</span><input defaultValue={e[k]} placeholder={ph} spellCheck={false} onBlur={ev => { const v = ev.target.value.trim(); if (v !== e[k]) patch({ [k]: v }) }} /></label>
  )
  const price = (k: 'inputPrice' | 'outputPrice', label: string) => (
    <label className="field short"><span>{label}</span><input type="number" min={0} step={0.01} defaultValue={e[k] ?? ''} placeholder="$" onBlur={ev => { const v = ev.target.value === '' ? undefined : Math.max(0, +ev.target.value); if (v !== e[k]) patch({ [k]: v }) }} /></label>
  )
  return (
    <article className="card pad ep-card" id={`ep-${e.id}`} style={{ borderLeftColor: colorOf(project, e.id) }}>
      <div className="ep-grid">
        {field('name', 'Display name', 'Cerebras, Llama 3.3 70B')}
        {field('baseUrl', 'Base URL', 'https://api.example.com/v1')}
        {field('model', 'Model', 'llama-3.3-70b')}
        <label className="field"><span>API key <em className="muted">this device only</em></span>
          <div className="row gap-sm">
            <input type={show ? 'text' : 'password'} value={key ?? ''} autoComplete="off" spellCheck={false} placeholder={isSample ? 'not needed for the synthetic replay' : preset?.cors === 'local' ? 'usually not needed' : 'sk-...'} onChange={ev => { setKeyState(ev.target.value); void setKey(e.id, ev.target.value.trim()) }} />
            <button type="button" className="btn ghost sm" onClick={() => setShow(s => !s)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </label>
        {price('inputPrice', 'Input $ / 1M')}
        {price('outputPrice', 'Output $ / 1M')}
        <label className="check"><input type="checkbox" checked={e.streamOptions} onChange={ev => patch({ streamOptions: ev.target.checked })} /> Request usage chunk (<code>stream_options.include_usage</code>)</label>
        <label className="field color"><span>Colour</span><input type="color" value={e.color ?? '#f05a28'} onChange={ev => patch({ color: ev.target.value })} /></label>
      </div>
      {preset?.note && <p className="muted small">{preset.note}{preset.keyUrl && <> Get a key at <a href={preset.keyUrl} target="_blank" rel="noreferrer">{preset.keyUrl.replace(/^https:\/\//, '')}</a>.</>}</p>}
      <div className="row gap-sm wrap">
        <button type="button" className="btn ghost sm" onClick={() => void runTest()} disabled={test === 'running' || !e.model}>{test === 'running' ? 'Testing' : 'Test connection'}</button>
        <button type="button" className="btn danger-ghost sm" onClick={remove}>Remove</button>
        {test && test !== 'running' && (test.ok
          ? <span className="ok-t small" role="status">Streaming works: first token in {fmtMs(test.ttftMs)}, {test.outputTokens} tokens ({test.tokenSource === 'usage' ? 'usage reported' : 'no usage chunk, tokens approximated'}).</span>
          : <span className="error small" role="alert">{test.error}</span>)}
      </div>
      {test && test !== 'running' && !test.ok && <Diagnosis r={test} e={e} project={project} />}
    </article>
  )
}

export function Diagnosis({ r, e, project }: { r: RequestResult; e: Endpoint; project: Project }) {
  if (r.errorKind === 'network') return (
    <div className="note warn stack-sm">
      <strong>The browser blocked this request before the provider answered.</strong>
      <p className="small">Most often CORS: the provider does not allow API calls from web pages on other origins, so the browser refuses to show the response. It can also be a wrong URL, a local server that is not running, or an ad blocker. {e.baseUrl.startsWith('http://localhost') || e.baseUrl.startsWith('http://127.') ? 'For Ollama, restart it with OLLAMA_ORIGINS set to this site (see Docs).' : 'Nothing is wrong with your key.'}</p>
      <p className="small">Fix: <Link href={`/app/p/${project.id}/run#terminal`}>download the terminal script</Link>. It runs the identical benchmark with Node (no CORS outside browsers) and writes a JSON file you import under History.</p>
    </div>
  )
  if (r.status === 401 || r.status === 403) return <p className="note warn small">The provider rejected the key. Check it was copied fully and belongs to this provider.</p>
  if (r.status === 404) return <p className="note warn small">Not found: check the base URL ends at the API version (for example <code>/v1</code>) and the model id exists for this provider.</p>
  if (r.status === 400) return <p className="note warn small">Bad request: often an unknown model id, or a provider that rejects <code>stream_options</code>. Try unticking the usage chunk option.</p>
  if (r.errorKind === 'rate_limit') return <p className="note warn small">Rate limited (429). Free tiers often allow only a few requests per minute: lower concurrency and repetitions on the Run tab.</p>
  return null
}

// ---------- Prompts ----------

function Prompts({ project, update }: { project: Project; update: Update }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [mapping, setMapping] = useState<Mapping | undefined>()
  const [suiteName, setSuiteName] = useState('My prompts')
  const [manual, setManual] = useState(false)
  const imp: PromptImport | null = file ? importPrompts(file.text, file.name, mapping, { maxTokens: 256, suite: suiteName }) : null
  const toggleSuite = (id: string, on: boolean) => {
    const s = SUITES.find(x => x.id === id)!
    const ids = new Set(s.prompts.map(p => p.id))
    void update({ prompts: on ? [...project.prompts.filter(p => !ids.has(p.id)), ...s.prompts] : project.prompts.filter(p => !ids.has(p.id)) })
  }
  const patch = (id: string, p: Partial<Prompt>) => void update({ prompts: project.prompts.map(x => x.id === id ? { ...x, ...p } : x) })
  const remove = (p: Prompt) => {
    const before = project.prompts
    void update({ prompts: before.filter(x => x.id !== p.id) })
    toast(`Removed "${p.name}".`, { undo: () => void update({ prompts: before }) })
  }
  const suites = [...new Set(project.prompts.map(p => p.suite))]
  return (
    <div className="stack-lg">
      <div className="card pad stack">
        <h2 className="h4">Built-in suites</h2>
        <div className="suite-grid">
          {SUITES.map(s => {
            const on = s.prompts.every(p => project.prompts.some(x => x.id === p.id))
            return (
              <label key={s.id} className={`suite${on ? ' on' : ''}`}>
                <input type="checkbox" checked={on} onChange={e => toggleSuite(s.id, e.target.checked)} />
                <strong>{s.name}</strong>
                <span className="muted small">{s.blurb}</span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="card pad stack">
        <div className="row between wrap gap-sm">
          <h2 className="h4">Your prompts</h2>
          <div className="row gap-sm wrap">
            <button type="button" className="btn ghost sm" onClick={() => setManual(true)}>Add one</button>
            <label className="btn primary sm file-btn">Import CSV / JSONL<input type="file" accept=".csv,.tsv,.jsonl,.json,.txt" onChange={async e => { const f = e.target.files?.[0]; if (f) { setMapping(undefined); setFile({ name: f.name, text: await f.text() }) } e.target.value = '' }} /></label>
          </div>
        </div>
        <p className="muted small">Your real traffic is the benchmark that matters. Export a sample of production prompts (see <Link href="/docs#prompts">Docs</Link> for formats): CSV with a <code>prompt</code> column, or JSONL in OpenAI <code>messages</code> format.</p>
        {project.prompts.length === 0 ? <p className="muted">No prompts selected. Tick a suite above or import your own.</p> : suites.map(s => (
          <div key={s} className="stack-sm">
            <h3 className="h5">{s} <span className="muted small">{project.prompts.filter(p => p.suite === s).length}</span></h3>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>Prompt</th><th className="num">Input ≈ tok</th><th className="num">Target out</th><th>JSON</th><th /></tr></thead>
              <tbody>{project.prompts.filter(p => p.suite === s).map(p => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td className="small clip" title={p.user.slice(0, 600)}>{p.user.slice(0, 140)}{p.user.length > 140 ? '…' : ''}</td>
                  <td className="num mono">{approxTokens((p.system ?? '') + p.user).toLocaleString()}</td>
                  <td className="num"><input className="cell-input num-in" type="number" min={1} max={32768} aria-label={`Target output tokens for ${p.name}`} defaultValue={p.maxTokens} onBlur={e => { const v = Math.min(32768, Math.max(1, Math.round(+e.target.value || 1))); if (v !== p.maxTokens) patch(p.id, { maxTokens: v }) }} /></td>
                  <td><input type="checkbox" aria-label={`JSON mode for ${p.name}`} checked={!!p.json} onChange={e => patch(p.id, { json: e.target.checked || undefined })} /></td>
                  <td><button type="button" className="btn danger-ghost sm" onClick={() => remove(p)}>Remove</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
        ))}
      </div>

      <Modal open={!!file} onClose={() => setFile(null)} title={`Import ${file?.name ?? ''}`} wide>
        {imp && (
          <div className="stack">
            <p className="muted small">{imp.header ? `Detected ${file!.name.endsWith('.tsv') ? 'TSV' : 'CSV'} with ${imp.rows} rows.` : `Detected ${/\.jsonl$/i.test(file!.name) || file!.text.trimStart().startsWith('{"') ? 'JSONL' : 'JSON'} with ${imp.rows} records.`} {imp.prompts.length} prompt{imp.prompts.length === 1 ? '' : 's'} ready.</p>
            {imp.header && imp.mapping && (
              <div className="map-grid">
                {FIELDS.map(f => (
                  <label key={f.key} className="field"><span>{f.label}{f.required && ' *'}</span>
                    <select value={imp.mapping![f.key]} onChange={e => setMapping({ ...imp.mapping!, [f.key]: +e.target.value })}>
                      <option value={-1}>{f.required ? 'Choose a column' : 'Not in file'}</option>
                      {imp.header!.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <label className="field"><span>Suite name for rows without one</span><input value={suiteName} onChange={e => setSuiteName(e.target.value)} /></label>
            {imp.prompts.length > 0 && <div className="preview small"><strong>Preview:</strong> {imp.prompts.slice(0, 3).map(p => <div key={p.id} className="clip">{p.name}: {p.user.slice(0, 120)} <span className="muted">({p.maxTokens} tok{p.json ? ', JSON' : ''})</span></div>)}</div>}
            <IssueList issues={imp.issues} />
            <div className="row end gap">
              <button type="button" className="btn ghost" onClick={() => setFile(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={!imp.prompts.length} onClick={() => { void update({ prompts: [...project.prompts, ...imp.prompts] }); setFile(null); toast(`Added ${imp.prompts.length} prompts.`, { tone: 'ok' }) }}>Add {imp.prompts.length} prompts</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={manual} onClose={() => setManual(false)} title="Add a prompt">
        <form className="stack" onSubmit={e => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          const user = String(f.get('user')).trim()
          if (!user) return
          const p: Prompt = { id: uuid(), name: String(f.get('name')).trim() || user.slice(0, 48), suite: String(f.get('suite')).trim() || 'My prompts', user, maxTokens: Math.max(1, Math.min(32768, +String(f.get('max')) || 256)), ...(String(f.get('system')).trim() ? { system: String(f.get('system')).trim() } : {}), ...(f.get('json') ? { json: true } : {}) }
          void update({ prompts: [...project.prompts, p] })
          setManual(false)
        }}>
          <label className="field"><span>Name</span><input name="name" placeholder="Support triage" /></label>
          <label className="field"><span>System prompt (optional)</span><textarea name="system" rows={2} /></label>
          <label className="field"><span>User prompt</span><textarea name="user" rows={5} required /></label>
          <div className="row gap wrap">
            <label className="field"><span>Target output tokens</span><input name="max" type="number" min={1} max={32768} defaultValue={256} /></label>
            <label className="field"><span>Suite</span><input name="suite" defaultValue="My prompts" /></label>
            <label className="check"><input type="checkbox" name="json" /> JSON mode</label>
          </div>
          <div className="row end gap"><button type="button" className="btn ghost" onClick={() => setManual(false)}>Cancel</button><button className="btn primary">Add prompt</button></div>
        </form>
      </Modal>
    </div>
  )
}
