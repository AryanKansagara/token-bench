// Prompt-suite import (CSV, JSONL, JSON), result import/export, and share links.
import { approxTokens } from './sse.ts'
import type { Endpoint, Prompt, RequestResult, Run } from './types.ts'

export interface Issue { line: number; level: 'error' | 'warn'; message: string }

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF. Returns rows with their starting line number. */
export function parseCsv(text: string, delim = ','): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = []
  let row: string[] = [], cell = '', q = false, line = 1, rowLine = 1
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') q = false
      else { if (ch === '\n') line++; cell += ch }
    } else if (ch === '"' && cell === '') q = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(c => c !== '')) rows.push({ cells: row, line: rowLine })
      row = []; line++; rowLine = line
    } else cell += ch
  }
  row.push(cell)
  if (row.some(c => c !== '')) rows.push({ cells: row, line: rowLine })
  return rows
}

export type Format = 'csv' | 'tsv' | 'jsonl' | 'json' | 'run' | 'unknown'

export function detectFormat(text: string, fileName = ''): Format {
  const t = text.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const j = JSON.parse(t)
      if (j && typeof j === 'object' && !Array.isArray(j) && (j.format === 'token-bench-run' || Array.isArray(j.results))) return 'run'
      return 'json'
    } catch { return t.startsWith('{') ? 'jsonl' : 'unknown' }
  }
  if (/\.tsv$/i.test(fileName) || (t.split('\n')[0].includes('\t') && !t.split('\n')[0].includes(','))) return 'tsv'
  if (/\.jsonl$/i.test(fileName)) return 'jsonl'
  return t ? 'csv' : 'unknown'
}

export interface Mapping { user: number; name: number; system: number; maxTokens: number; suite: number; json: number }
export const FIELDS: { key: keyof Mapping; label: string; required?: boolean; hints: RegExp }[] = [
  { key: 'user', label: 'Prompt text', required: true, hints: /^(prompt|user|input|question|content|message|text|query)$/i },
  { key: 'name', label: 'Name', hints: /^(name|id|title|label|key)$/i },
  { key: 'system', label: 'System prompt', hints: /^(system|system_prompt|instructions)$/i },
  { key: 'maxTokens', label: 'Target output tokens', hints: /^(max_tokens|max_output_tokens|target_tokens|output_tokens|tokens|length|max_new_tokens)$/i },
  { key: 'suite', label: 'Suite', hints: /^(suite|category|group|tag|type)$/i },
  { key: 'json', label: 'JSON mode', hints: /^(json|json_mode|response_format)$/i },
]

export function guessMapping(header: string[]): Mapping {
  const m = { user: -1, name: -1, system: -1, maxTokens: -1, suite: -1, json: -1 } as Mapping
  for (const f of FIELDS) m[f.key] = header.findIndex(h => f.hints.test(h.trim().replace(/\s+/g, '_')))
  // No obvious prompt column: take the first column not claimed by another field.
  if (m.user < 0) m.user = header.findIndex((_, i) => !Object.values(m).includes(i))
  return m
}

const truthy = (s: string) => /^(1|true|yes|y|json|json_object)$/i.test(s.trim())

export interface PromptImport { prompts: Prompt[]; issues: Issue[]; header?: string[]; mapping?: Mapping; rows: number }

export function importPrompts(text: string, fileName = '', mapping?: Mapping, defaults: { maxTokens: number; suite: string } = { maxTokens: 256, suite: 'My prompts' }, makeId: () => string = () => crypto.randomUUID()): PromptImport {
  const fmt = detectFormat(text, fileName)
  const issues: Issue[] = []
  const prompts: Prompt[] = []
  const addPrompt = (line: number, raw: { user?: unknown; name?: unknown; system?: unknown; maxTokens?: unknown; suite?: unknown; json?: unknown }) => {
    const user = typeof raw.user === 'string' ? raw.user.trim() : ''
    if (!user) { issues.push({ line, level: 'error', message: 'Empty prompt text; row skipped.' }); return }
    let maxTokens = defaults.maxTokens
    if (raw.maxTokens !== undefined && raw.maxTokens !== '' && raw.maxTokens !== null) {
      const n = Number(raw.maxTokens)
      if (!Number.isFinite(n) || n < 1 || n > 32768) issues.push({ line, level: 'warn', message: `Target output tokens "${String(raw.maxTokens)}" is not a number from 1 to 32768; using ${defaults.maxTokens}.` })
      else maxTokens = Math.round(n)
    }
    const tokens = approxTokens(user)
    if (tokens > 120_000) issues.push({ line, level: 'warn', message: `Prompt is about ${tokens.toLocaleString()} tokens; many models cap context at 128k.` })
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : user.replace(/\s+/g, ' ').slice(0, 48)
    if (prompts.some(p => p.name === name)) issues.push({ line, level: 'warn', message: `Duplicate name "${name}".` })
    prompts.push({ id: makeId(), name, suite: typeof raw.suite === 'string' && raw.suite.trim() ? raw.suite.trim() : defaults.suite, ...(typeof raw.system === 'string' && raw.system.trim() ? { system: raw.system.trim() } : {}), user, maxTokens, ...(raw.json === true || (typeof raw.json === 'string' && truthy(raw.json)) ? { json: true } : {}) })
  }
  const fromObject = (o: unknown, line: number) => {
    if (typeof o === 'string') return addPrompt(line, { user: o })
    if (!o || typeof o !== 'object') { issues.push({ line, level: 'error', message: 'Expected an object or a string.' }); return }
    const j = o as Record<string, unknown>
    let user = j.prompt ?? j.user ?? j.input ?? j.question ?? j.content ?? j.text
    let system = j.system
    if (Array.isArray(j.messages)) {
      const msgs = j.messages as { role?: string; content?: unknown }[]
      const str = (c: unknown) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p as { text?: string }).text ?? '').join('') : ''
      system = system ?? msgs.filter(m => m.role === 'system').map(m => str(m.content)).join('\n') ?? undefined
      const rest = msgs.filter(m => m.role !== 'system')
      user = rest.length === 1 ? str(rest[0].content) : rest.map(m => `${m.role ?? 'user'}: ${str(m.content)}`).join('\n\n')
      if (rest.length > 1) issues.push({ line, level: 'warn', message: `${rest.length} chat turns were flattened into one user message.` })
    }
    const rf = j.response_format as { type?: string } | undefined
    addPrompt(line, { user, name: j.name ?? j.id ?? j.title, system, maxTokens: j.max_tokens ?? j.maxTokens ?? j.target_tokens ?? j.max_output_tokens, suite: j.suite ?? j.category, json: j.json ?? (rf?.type === 'json_object' || rf?.type === 'json_schema') })
  }

  if (fmt === 'jsonl') {
    const lines = text.split(/\r?\n/)
    lines.forEach((l, i) => {
      if (!l.trim()) return
      try { fromObject(JSON.parse(l), i + 1) } catch { issues.push({ line: i + 1, level: 'error', message: 'Not valid JSON; line skipped.' }) }
    })
    return { prompts, issues, rows: lines.filter(l => l.trim()).length }
  }
  if (fmt === 'json') {
    let j: unknown
    try { j = JSON.parse(text) } catch (e) { return { prompts, issues: [{ line: 1, level: 'error', message: `Invalid JSON: ${(e as Error).message}` }], rows: 0 } }
    const arr = Array.isArray(j) ? j : Array.isArray((j as { prompts?: unknown }).prompts) ? (j as { prompts: unknown[] }).prompts : [j]
    arr.forEach((o, i) => fromObject(o, i + 1))
    return { prompts, issues, rows: arr.length }
  }
  if (fmt === 'run') return { prompts, issues: [{ line: 1, level: 'error', message: 'This file is a benchmark result, not a prompt suite. Import it from History.' }], rows: 0 }
  if (fmt === 'unknown') return { prompts, issues: [{ line: 1, level: 'error', message: 'The file is empty or not CSV, TSV, JSONL or JSON.' }], rows: 0 }

  const rows = parseCsv(text, fmt === 'tsv' ? '\t' : ',')
  if (!rows.length) return { prompts, issues: [{ line: 1, level: 'error', message: 'No rows found.' }], rows: 0 }
  const header = rows[0].cells.map(h => h.trim())
  const m = mapping ?? guessMapping(header)
  if (m.user < 0) return { prompts, issues: [{ line: 1, level: 'error', message: 'Pick which column holds the prompt text.' }], header, mapping: m, rows: rows.length - 1 }
  for (const r of rows.slice(1)) {
    if (r.cells.length !== header.length) issues.push({ line: r.line, level: 'warn', message: `Has ${r.cells.length} columns, header has ${header.length}.` })
    const at = (i: number) => i >= 0 ? r.cells[i] ?? '' : undefined
    addPrompt(r.line, { user: at(m.user), name: at(m.name), system: at(m.system), maxTokens: at(m.maxTokens), suite: at(m.suite), json: at(m.json) })
  }
  return { prompts, issues, header, mapping: m, rows: rows.length - 1 }
}

// ---------- Results ----------

export const RUN_FORMAT = 'token-bench-run'

const ERROR_KINDS = new Set(['rate_limit', 'http', 'network', 'timeout', 'stream', 'aborted'])
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : undefined

/** Validates a result file (from the Node script, an export, or a share link). Drops what it cannot trust. */
export function importRun(text: string, makeId: () => string = () => crypto.randomUUID()): { run: Run | null; issues: Issue[] } {
  const issues: Issue[] = []
  let j: Record<string, unknown>
  try { j = JSON.parse(text) } catch (e) { return { run: null, issues: [{ line: 1, level: 'error', message: `Invalid JSON: ${(e as Error).message}` }] } }
  if (!j || typeof j !== 'object' || !Array.isArray(j.results) || !Array.isArray(j.endpoints)) return { run: null, issues: [{ line: 1, level: 'error', message: 'Missing "endpoints" or "results". Expected a Token Bench result file.' }] }
  const endpoints: Endpoint[] = []
  ;(j.endpoints as Record<string, unknown>[]).forEach((e, i) => {
    if (!e || typeof e.id !== 'string' || typeof e.model !== 'string') { issues.push({ line: i + 1, level: 'error', message: `endpoints[${i}] needs an id and a model.` }); return }
    endpoints.push({ id: e.id, name: typeof e.name === 'string' ? e.name : e.model, baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : '', model: e.model, streamOptions: e.streamOptions !== false, ...(num(e.inputPrice) !== undefined ? { inputPrice: num(e.inputPrice) } : {}), ...(num(e.outputPrice) !== undefined ? { outputPrice: num(e.outputPrice) } : {}), ...(typeof e.preset === 'string' ? { preset: e.preset } : {}), ...(typeof e.color === 'string' ? { color: e.color } : {}) })
    if ('apiKey' in e || 'key' in e) issues.push({ line: i + 1, level: 'warn', message: `endpoints[${i}] contained an API key field; it was discarded.` })
  })
  const prompts: Prompt[] = Array.isArray(j.prompts) ? (j.prompts as Record<string, unknown>[]).filter(p => p && typeof p.id === 'string').map(p => ({ id: p.id as string, name: typeof p.name === 'string' ? p.name : p.id as string, suite: typeof p.suite === 'string' ? p.suite : 'Imported', user: typeof p.user === 'string' ? p.user : '', maxTokens: num(p.maxTokens) ?? 256, ...(typeof p.system === 'string' ? { system: p.system } : {}), ...(p.json ? { json: true } : {}) })) : []
  const epIds = new Set(endpoints.map(e => e.id))
  const results: RequestResult[] = []
  ;(j.results as Record<string, unknown>[]).forEach((r, i) => {
    const line = i + 1
    if (!r || typeof r.endpointId !== 'string' || !epIds.has(r.endpointId)) { issues.push({ line, level: 'error', message: `results[${i}] references an unknown endpoint; skipped.` }); return }
    if (typeof r.promptId !== 'string') { issues.push({ line, level: 'error', message: `results[${i}] has no promptId; skipped.` }); return }
    const ok = r.ok === true
    const ttftMs = num(r.ttftMs), totalMs = num(r.totalMs)
    if (ok && (ttftMs === undefined || totalMs === undefined || ttftMs < 0 || totalMs < ttftMs)) { issues.push({ line, level: 'error', message: `results[${i}] is marked ok but its timings are missing or inconsistent; skipped.` }); return }
    if (!prompts.some(p => p.id === r.promptId)) prompts.push({ id: r.promptId, name: r.promptId, suite: 'Imported', user: '', maxTokens: 256 })
    results.push({
      endpointId: r.endpointId, promptId: r.promptId, rep: num(r.rep) ?? 0, startedAt: num(r.startedAt) ?? 0, ok,
      ...(num(r.status) !== undefined ? { status: num(r.status) } : {}),
      ...(!ok ? { errorKind: (ERROR_KINDS.has(r.errorKind as string) ? r.errorKind : num(r.status) === 429 ? 'rate_limit' : 'http') as RequestResult['errorKind'], error: typeof r.error === 'string' ? r.error.slice(0, 400) : 'Failed' } : {}),
      ...(ttftMs !== undefined ? { ttftMs } : {}), ...(totalMs !== undefined ? { totalMs } : {}),
      ...(num(r.outputTokens) !== undefined ? { outputTokens: num(r.outputTokens) } : {}),
      ...(num(r.inputTokens) !== undefined ? { inputTokens: num(r.inputTokens) } : {}),
      ...(r.tokenSource === 'usage' || r.tokenSource === 'approx' ? { tokenSource: r.tokenSource } : {}),
      ...(Array.isArray(r.chunks) && r.chunks.every(c => typeof c === 'number') ? { chunks: r.chunks as number[] } : {}),
      ...(typeof r.text === 'string' ? { text: r.text.slice(0, 2000) } : {}),
    })
  })
  if (!results.length) issues.push({ line: 1, level: 'error', message: 'No usable results.' })
  const cfg = (j.config ?? {}) as Record<string, unknown>
  const run: Run = {
    id: makeId(), label: typeof j.label === 'string' ? j.label : 'Imported run', createdAt: num(j.createdAt) ?? Date.now(),
    source: j.source === 'node' ? 'node' : j.source === 'sample' ? 'sample' : 'import',
    config: { reps: num(cfg.reps) ?? 1, concurrency: num(cfg.concurrency) ?? 1, rampMs: num(cfg.rampMs) ?? 0, timeoutMs: num(cfg.timeoutMs) ?? 60000, temperature: num(cfg.temperature) ?? 0 },
    endpoints, prompts, results, ...(num(j.durationMs) !== undefined ? { durationMs: num(j.durationMs) } : {}),
  }
  return { run: results.length ? run : null, issues }
}

export function exportRunJson(run: Run): string {
  return JSON.stringify({ format: RUN_FORMAT, version: 1, ...run }, null, 1)
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function resultsCsv(run: Run, tps: (r: RequestResult) => number | null): string {
  const head = ['endpoint', 'model', 'base_url', 'prompt', 'suite', 'rep', 'started_ms', 'ok', 'status', 'error_kind', 'error', 'ttft_ms', 'total_ms', 'output_tokens', 'input_tokens', 'token_source', 'decode_tokens_per_s', 'chunks']
  const ep = new Map(run.endpoints.map(e => [e.id, e]))
  const pr = new Map(run.prompts.map(p => [p.id, p]))
  const lines = run.results.map(r => {
    const e = ep.get(r.endpointId), p = pr.get(r.promptId), t = tps(r)
    return [e?.name, e?.model, e?.baseUrl, p?.name ?? r.promptId, p?.suite, r.rep, r.startedAt, r.ok, r.status, r.errorKind, r.error, r.ttftMs?.toFixed(1), r.totalMs?.toFixed(1), r.outputTokens, r.inputTokens, r.tokenSource, t?.toFixed(1), r.chunks?.length].map(csvCell).join(',')
  })
  return [head.join(','), ...lines].join('\n') + '\n'
}

// ---------- Share links: the run minus chunk timings and text, deflated into the URL hash ----------

export function shareable(run: Run): Run {
  return { ...run, prompts: run.prompts.map(p => ({ ...p, user: p.user.length > 400 ? p.user.slice(0, 400) + ' [truncated]' : p.user })), results: run.results.map(({ chunks: _c, text: _t, ...r }) => r) }
}

const b64url = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream) {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(t))
  return new Uint8Array(await out.arrayBuffer())
}

export async function encodeShare(run: Run): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(exportRunJson(shareable(run))), new CompressionStream('deflate-raw')))
}

export async function decodeShare(s: string): Promise<string> {
  return new TextDecoder().decode(await pipe(unb64url(s), new DecompressionStream('deflate-raw')))
}
