import { useEffect, useMemo, useRef, useState } from 'react'
import { sampleRun, sampleText } from './engine/sample.ts'
import { Dial } from './charts.tsx'
import { colorOf } from './projectData.ts'
import { fmtMs, fmtTps, Link } from './ui.tsx'

const RACE_PROMPT = 'builtin:code-1'

/** Replays the synthetic recorded run in real time: same chunk arrival times, same token counts. */
function Race() {
  const run = useMemo(() => sampleRun('rerun', 0), [])
  const lanes = useMemo(() => run.endpoints.map(e => {
    // The median-duration repetition, so the replay is typical rather than a lucky or stalled request.
    const reps = run.results.filter(x => x.endpointId === e.id && x.promptId === RACE_PROMPT && x.ok).sort((a, b) => a.totalMs! - b.totalMs!)
    const r = reps[Math.floor((reps.length - 1) / 2)]
    return { e, r, text: sampleText(r.outputTokens!, true), color: colorOf(run, e.id) }
  }), [run])
  const end = Math.max(...lanes.map(l => l.r.totalMs!))
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const [t, setT] = useState(reduced ? end : 0)
  const boxes = useRef<(HTMLPreElement | null)[]>([])
  useEffect(() => {
    if (reduced) return
    let raf = 0, t0 = performance.now()
    const tick = (now: number) => {
      let e = now - t0
      if (e > end + 2600) { t0 = now; e = 0 }
      setT(e)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [end, reduced])
  useEffect(() => { boxes.current.forEach(b => { if (b) b.scrollTop = b.scrollHeight }) })
  return (
    <div className="race" aria-label="Replay of a synthetic recorded benchmark: three fake providers streaming the same code prompt">
      <div className="race-head mono">
        <span><i className="live-dot" />REPLAY · SYNTHETIC RECORDING</span>
        <span>t = {fmtMs(Math.min(t, end))}</span>
      </div>
      <p className="race-prompt mono">&gt; Write a TypeScript function that parses a Server-Sent Events stream incrementally…</p>
      <div className="race-lanes">
        {lanes.map(({ e, r, text, color }, i) => {
          const c = r.chunks!
          const n = c.filter(x => x <= t).length
          const tokens = Math.round(n / c.length * r.outputTokens!)
          const started = t >= r.ttftMs!
          const done = t >= r.totalMs!
          const tps = started && t - r.ttftMs! > 30 ? (tokens - 1) / ((Math.min(t, r.totalMs!) - r.ttftMs!) / 1000) : null
          return (
            <div key={e.id} className={`lane${done ? ' done' : ''}`} style={{ ['--lane' as string]: color }}>
              <div className="lane-top">
                <strong>{e.name.replace(' (synthetic)', '')}</strong>
                <span className="mono small">{done ? `done in ${fmtMs(r.totalMs)}` : started ? `${tokens} tok` : 'waiting for first token'}</span>
              </div>
              <div className="lane-dials">
                <Dial value={started ? r.ttftMs! : t > 0 ? Math.min(t, r.ttftMs!) : null} max={1500} log label={started ? 'TTFT' : 'waiting'} unit="ms" color={color} size={118} />
                <Dial value={tps} max={2200} label="output" unit="tok/s" color={color} size={118} />
              </div>
              <pre className="lane-text" ref={el => { boxes.current[i] = el }}>{text.slice(0, Math.round(n / c.length * text.length))}{!done && <span className="caret" />}</pre>
              <div className="lane-bar"><div style={{ width: `${Math.min(100, tokens / r.outputTokens! * 100)}%` }} /></div>
            </div>
          )
        })}
      </div>
      <p className="race-note small">Providers A, B and C are synthetic. Timings are generated, then replayed at real speed. Run it against real providers with your own key.</p>
    </div>
  )
}

const METRICS = [
  ['TTFT', 'Time to first token', 'How long users stare at a spinner. Measured to the first chunk that carries content, not the first byte.'],
  ['TOK/S', 'Output tokens per second', 'Decode speed after the first token, from the provider\'s usage chunk or a local tokenizer approximation.'],
  ['E2E', 'End-to-end latency', 'The full request, with p50/p90/p99 and 95% bootstrap intervals so you know when a difference is noise.'],
  ['ITL', 'Inter-token latency and jitter', 'The gaps between chunks. Stalls mid-stream are what a reader experiences as stutter.'],
  ['429', 'Errors and rate limits', 'Every failure is classified: 429, HTTP, timeout, mid-stream error, or blocked by the browser.'],
  ['$', 'Cost per 1M tokens', 'From the prices you enter, at your prompts\' real input to output mix.'],
] as const

export function Landing() {
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <p className="eyebrow mono">Benchmark for OpenAI-compatible inference APIs</p>
            <h1 className="display">How fast is <span className="grad">your inference</span>, really?</h1>
            <p className="lede">Token Bench runs real streamed requests against any provider with your own key, on your own prompts, and measures time to first token, output tokens per second, end-to-end latency and consistency. Then it tells you how long your agent loop will take.</p>
            <div className="row gap wrap">
              <Link href="/app?sample=1" className="btn accent lg">Try the sample</Link>
              <Link href="/app?new=1" className="btn primary lg">Benchmark your providers</Link>
            </div>
            <p className="muted small">No sign-up. Keys stay in your browser. Presets for Cerebras, Groq, Together, Fireworks, OpenRouter, Ollama and llama.cpp.</p>
          </div>
          <Race />
        </div>
      </section>

      <section className="band">
        <div className="wrap-in">
          <p className="eyebrow mono">What it measures</p>
          <h2 className="display-sm">Six numbers that decide a provider</h2>
          <div className="metric-grid">
            {METRICS.map(([k, t, d]) => <article key={k} className="metric"><span className="mono metric-k">{k}</span><h3>{t}</h3><p className="muted">{d}</p></article>)}
          </div>
        </div>
      </section>

      <section className="band alt">
        <div className="wrap-in split">
          <div>
            <p className="eyebrow mono">Agent loops</p>
            <h2 className="display-sm">Latency multiplies</h2>
            <p>An agent that makes eight sequential calls pays the time to first token eight times and streams eight answers while its context grows. Token Bench resamples your measured requests to estimate the typical and p90 time for a loop you describe, including prefill cost as context grows.</p>
            <Link href="/app?sample=1&tab=agent" className="btn primary">See the estimator</Link>
          </div>
          <LoopArt />
        </div>
      </section>

      <section className="band">
        <div className="wrap-in">
          <p className="eyebrow mono">How it works</p>
          <div className="steps">
            <div><span className="mono step-n">01</span><h3>Add endpoints</h3><p className="muted">Base URL, model, key. The key is stored in IndexedDB on this device and sent only to that endpoint.</p></div>
            <div><span className="mono step-n">02</span><h3>Choose prompts</h3><p className="muted">Built-in suites for short chat, long-context summarisation, code and JSON mode, or import your own CSV or JSONL.</p></div>
            <div><span className="mono step-n">03</span><h3>Run and compare</h3><p className="muted">N parallel requests with a ramp, interleaved across providers. Save runs, compare them next month, export CSV, JSON or a printable report.</p></div>
            <div><span className="mono step-n">04</span><h3>Blocked by CORS?</h3><p className="muted">Some APIs refuse browser calls. Download a dependency-free Node script that runs the identical benchmark and import its results.</p></div>
          </div>
        </div>
      </section>

      <section className="cta-band">
        <div className="wrap-in center">
          <h2 className="display-sm">Stop trusting someone else's leaderboard</h2>
          <p>Your prompts, your region, your concurrency, today.</p>
          <div className="row gap center-x wrap"><Link href="/app?sample=1" className="btn primary lg">Try the sample</Link><Link href="/docs" className="btn ghost lg">Read the docs</Link></div>
        </div>
      </section>
    </>
  )
}

function LoopArt() {
  const rows = [['A', 0.18, 0.12, '#f05a28'], ['B', 0.3, 0.42, '#2f8f9d'], ['C', 0.5, 1.6, '#9b6ad6']] as const
  const total = (ttft: number, dec: number) => 8 * (ttft + dec + 0.4)
  const max = total(0.5, 1.6)
  return (
    <figure className="loop-art card pad" aria-label="Illustration: eight sequential calls on three synthetic providers">
      {rows.map(([n, ttft, dec, c]) => (
        <div key={n} className="loop-art-row">
          <span className="mono">{n}</span>
          <div className="loop-art-track">
            {Array.from({ length: 8 }, (_, i) => <span key={i} style={{ width: `${(ttft + dec) / max * 100}%`, marginRight: `${0.4 / max * 100}%`, background: c }} />)}
          </div>
          <span className="mono small">{fmtTps(total(ttft, dec))} s</span>
        </div>
      ))}
      <figcaption className="muted small">8 calls, 0.4 s tool time each. Synthetic providers.</figcaption>
    </figure>
  )
}
