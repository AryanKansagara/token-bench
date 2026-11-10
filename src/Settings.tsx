import { useState } from 'react'
import { RANK_LABEL, type RankBy } from './engine/stats.ts'
import { getDefaults, resetDefaults, setDefaults, type Defaults } from './store.ts'
import { setTheme, toast, useDark } from './ui.tsx'
import { useSync } from './sync.ts'

export default function Settings() {
  const [d, setD] = useState<Defaults>(getDefaults)
  const dark = useDark()
  const s = useSync()
  const save = (patch: Partial<Defaults>) => { const n = { ...d, ...patch }; setD(n); setDefaults(n) }
  const num = (k: 'reps' | 'concurrency' | 'rampMs' | 'timeoutMs', label: string, min: number, max: number) => (
    <label className="field"><span>{label}</span><input type="number" min={min} max={max} value={d[k]} onChange={e => save({ [k]: Math.min(max, Math.max(min, +e.target.value || min)) })} /></label>
  )
  return (
    <section className="page narrow">
      <p className="eyebrow">Settings</p>
      <h1>Settings</h1>
      <div className="card pad stack">
        <h2 className="h4">Defaults for new benchmarks</h2>
        <div className="row gap wrap">
          {num('reps', 'Repetitions', 1, 50)}
          {num('concurrency', 'Parallel requests', 1, 64)}
          {num('rampMs', 'Ramp (ms per worker)', 0, 30000)}
          {num('timeoutMs', 'Timeout (ms)', 1000, 600000)}
        </div>
        <label className="field"><span>Rank leaderboards by</span><select value={d.rankBy} onChange={e => save({ rankBy: e.target.value as RankBy })}>{(Object.keys(RANK_LABEL) as RankBy[]).map(k => <option key={k} value={k}>{RANK_LABEL[k]}</option>)}</select></label>
        <p className="muted small">Saved as you type. Existing benchmarks keep their own settings on the Run tab.</p>
      </div>
      <div className="card pad stack">
        <h2 className="h4">Appearance</h2>
        <div className="seg" role="group" aria-label="Theme">
          <button type="button" aria-pressed={!dark} onClick={() => setTheme('light')}>Light</button>
          <button type="button" aria-pressed={dark} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>
      <div className="card pad stack">
        <h2 className="h4">Keys and sync</h2>
        <p className="muted small">API keys live in this browser's IndexedDB and are sent only to the endpoint they belong to. They are excluded from sync, exports and share links. Clearing site data removes them.</p>
        <p className="muted small">{s.user ? `Signed in as ${s.user.email}. Endpoints, prompts and runs sync; keys do not.` : 'Signed out. Everything is stored in this browser. Sign in from the account menu to sync across devices.'}</p>
        <p className="muted small">Shortcuts: 1 to 6 switch benchmark tabs, Ctrl or Cmd + Z undoes the last delete.</p>
        <button type="button" className="btn ghost sm" onClick={() => { resetDefaults(); setD(getDefaults()); toast('Defaults restored.') }}>Restore default settings</button>
      </div>
    </section>
  )
}
