// Concurrency runner: N parallel workers pulling from one queue, started one by one with a ramp delay.
import { streamChat, type RequestOpts } from './request.ts'
import type { Endpoint, Prompt, RequestResult, Run, RunConfig } from './types.ts'

export interface PoolOpts {
  concurrency: number
  rampMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Runs tasks with at most `concurrency` in flight. Results keep task order. Stops picking new tasks once aborted. */
export async function runPool<T>(tasks: (() => Promise<T>)[], o: PoolOpts): Promise<(T | undefined)[]> {
  const out: (T | undefined)[] = new Array(tasks.length)
  const n = Math.max(1, Math.min(Math.floor(o.concurrency) || 1, tasks.length))
  const sleep = o.sleep ?? realSleep
  let next = 0
  const worker = async (i: number) => {
    if (i > 0 && o.rampMs) await sleep(o.rampMs * i)
    while (!o.signal?.aborted) {
      const k = next++
      if (k >= tasks.length) return
      out[k] = await tasks[k]()
    }
  }
  await Promise.all(Array.from({ length: n }, (_, i) => worker(i)))
  return out
}

export interface Job { endpoint: Endpoint; prompt: Prompt; rep: number }

/**
 * Builds the request schedule. Repetitions are interleaved across endpoints and prompts so a
 * provider's slow minute does not land on a single prompt, and every provider sees the same conditions.
 */
export function schedule(endpoints: Endpoint[], prompts: Prompt[], reps: number): Job[] {
  const jobs: Job[] = []
  for (let rep = 0; rep < reps; rep++)
    for (const prompt of prompts)
      for (const endpoint of endpoints) jobs.push({ endpoint, prompt, rep })
  return jobs
}

export interface BenchOpts extends RequestOpts {
  keys: Record<string, string>
  onResult?: (r: RequestResult, done: number, total: number) => void
  onStart?: (j: Job) => void
  sleep?: (ms: number) => Promise<void>
}

export async function runBenchmark(endpoints: Endpoint[], prompts: Prompt[], cfg: RunConfig, o: BenchOpts): Promise<Pick<Run, 'results' | 'durationMs'>> {
  const now = o.now ?? (() => performance.now())
  const jobs = schedule(endpoints, prompts, cfg.reps)
  const t0 = now()
  let done = 0
  const results = await runPool(jobs.map(j => async () => {
    o.onStart?.(j)
    const r = await streamChat(j.endpoint, o.keys[j.endpoint.id] ?? '', j.prompt, j.rep, Math.round(now() - t0), { ...o, timeoutMs: cfg.timeoutMs, temperature: cfg.temperature })
    o.onResult?.(r, ++done, jobs.length)
    return r
  }), { concurrency: cfg.concurrency, rampMs: cfg.rampMs, signal: o.signal, sleep: o.sleep })
  return { results: results.filter((r): r is RequestResult => !!r), durationMs: Math.round(now() - t0) }
}
