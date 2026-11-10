// Built-in prompt suites and provider presets.
import { rng } from './stats.ts'
import type { Prompt } from './types.ts'

export interface Preset { id: string; name: string; baseUrl: string; model: string; keyUrl: string; cors: 'yes' | 'varies' | 'local'; note: string }

/** Defaults pick the same open model (Llama 3.3 70B) everywhere so the first comparison is like for like. */
export const PRESETS: Preset[] = [
  { id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b', keyUrl: 'https://cloud.cerebras.ai', cors: 'varies', note: 'Model ids differ per provider; check the provider model list.' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', cors: 'varies', note: '' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyUrl: 'https://api.together.ai/settings/api-keys', cors: 'varies', note: '' },
  { id: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', keyUrl: 'https://fireworks.ai/account/api-keys', cors: 'varies', note: '' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct', keyUrl: 'https://openrouter.ai/settings/keys', cors: 'yes', note: 'Routes to an upstream provider; pin one with provider routing if you want a stable comparison.' },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', keyUrl: '', cors: 'local', note: 'Start Ollama with OLLAMA_ORIGINS set to this site, or use the Node script.' },
  { id: 'llamacpp', name: 'llama.cpp server (local)', baseUrl: 'http://localhost:8080/v1', model: 'local', keyUrl: '', cors: 'local', note: 'llama-server allows browser requests by default.' },
]

const words = (n: number) => `Answer in about ${Math.round(n * 0.75)} words.`

/** A long synthetic on-call log, deterministic, so the summarisation prompts are identical on every device. */
export function syntheticLog(targetChars: number, seed: number): string {
  const r = rng(seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const svc = ['checkout-api', 'search-indexer', 'payments-gateway', 'auth-service', 'feature-store', 'image-resizer', 'ledger-writer', 'notifications']
  const evt = [
    'p99 latency rose from {a} ms to {b} ms after the {d} deploy; rolled back and latency recovered within {m} minutes.',
    'error rate on {s} reached {p}% for {m} minutes; cause was connection pool exhaustion against the primary database.',
    'a cron job on {s} retried without backoff and generated {a} duplicate messages; idempotency keys prevented double charges.',
    'disk on a {s} node passed 92% full; log rotation was misconfigured after the base image upgrade.',
    'certificate for an internal {s} endpoint expired; clients failed TLS handshakes until the cert was reissued {m} minutes later.',
    'autoscaler added {a} replicas of {s} during a traffic spike but cold starts took {m} minutes, so the queue backed up.',
    'a config change disabled caching in {s}; origin load tripled and the change was reverted.',
    'third-party rate limits throttled {s} to {p}% of normal throughput; a token bucket was added client side.',
  ]
  const out: string[] = ['SYNTHETIC ON-CALL LOG (generated for benchmarking, not real events)', '']
  let day = 1, len = 0
  while (len < targetChars) {
    const s = pick(svc)
    const line = `Day ${day}, ${String(Math.floor(r() * 24)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')} UTC, ${s}: ` + pick(evt)
      .replace('{a}', String(100 + Math.floor(r() * 900))).replace('{b}', String(1000 + Math.floor(r() * 4000)))
      .replace('{d}', `v${1 + Math.floor(r() * 9)}.${Math.floor(r() * 20)}`).replace('{m}', String(3 + Math.floor(r() * 50)))
      .replace('{p}', String(2 + Math.floor(r() * 30))).replace('{s}', s)
    out.push(line)
    len += line.length + 1
    if (r() < 0.3) day++
  }
  return out.join('\n')
}

export interface Suite { id: string; name: string; blurb: string; prompts: Prompt[] }

export const SUITES: Suite[] = [
  {
    id: 'chat', name: 'Short chat', blurb: 'Five short conversational prompts, about 150 output tokens each. Dominated by time to first token.',
    prompts: [
      ['Explain the difference between latency and throughput to a product manager.', 150],
      ['Give three tips for writing a clear bug report.', 150],
      ['What is a context window in a language model?', 120],
      ['Suggest a name for a CLI tool that benchmarks HTTP APIs, and explain why in one sentence each for three options.', 150],
      ['Summarise the idea of eventual consistency in plain English.', 150],
    ].map(([q, n], i) => ({ id: `builtin:chat-${i + 1}`, name: `Chat ${i + 1}`, suite: 'Short chat', user: `${q} ${words(n as number)}`, maxTokens: n as number })),
  },
  {
    id: 'long', name: 'Long-context summarisation', blurb: 'Synthetic on-call logs of about 3k and 12k input tokens. Measures prefill speed: watch TTFT grow.',
    prompts: [
      { id: 'builtin:long-3k', name: 'Summarise 3k-token log', suite: 'Long context', system: 'You are an SRE writing a weekly incident summary.', user: `Summarise the main incident themes in this log as five bullet points, then name the single riskiest service.\n\n${syntheticLog(12_000, 3)}`, maxTokens: 300 },
      { id: 'builtin:long-12k', name: 'Summarise 12k-token log', suite: 'Long context', system: 'You are an SRE writing a weekly incident summary.', user: `Summarise the main incident themes in this log as five bullet points, then name the single riskiest service.\n\n${syntheticLog(48_000, 12)}`, maxTokens: 300 },
    ],
  },
  {
    id: 'code', name: 'Code generation', blurb: 'Four coding tasks with about 600 output tokens. Dominated by decode speed.',
    prompts: [
      'Write a TypeScript function that parses a Server-Sent Events stream incrementally from string chunks, with tests.',
      'Write a Python function that computes p50, p90 and p99 latency with bootstrap confidence intervals, with docstrings.',
      'Implement an LRU cache in Go with Get and Put in O(1), and a short benchmark.',
      'Write a SQL query that finds the 10 slowest API endpoints by p95 latency per day from a requests(ts, path, ms) table, then explain it.',
    ].map((q, i) => ({ id: `builtin:code-${i + 1}`, name: `Code ${i + 1}`, suite: 'Code', system: 'You are a senior engineer. Reply with code first, then a brief explanation.', user: q, maxTokens: 600 })),
  },
  {
    id: 'json', name: 'JSON mode', blurb: 'Three structured-output prompts with response_format json_object. Some providers are slower in constrained decoding.',
    prompts: [
      ['Extract the people, companies and dates from: "On 3 March 2026 Dana Ruiz left Northwind to join Contoso as CTO, replacing Lee Park." Return {"people":[],"companies":[],"dates":[]}.', 200],
      ['Generate 8 realistic but fictional product catalog items as {"items":[{"sku","name","price_usd","tags"}]}.', 400],
      ['Classify the sentiment and urgency of this ticket and return {"sentiment","urgency","summary"}: "Checkout has been failing for all EU customers for 20 minutes and we are losing orders."', 120],
    ].map(([q, n], i) => ({ id: `builtin:json-${i + 1}`, name: `JSON ${i + 1}`, suite: 'JSON mode', system: 'Reply with a single JSON object only.', user: q as string, maxTokens: n as number, json: true })),
  },
]
