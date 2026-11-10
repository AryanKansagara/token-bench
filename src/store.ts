import { useSyncExternalStore } from 'react'
import type { Endpoint, Prompt, Run, RunConfig } from './engine/types.ts'

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  endpoints: Endpoint[]
  prompts: Prompt[]
  /** Benchmark history: each run is a dated snapshot with its own copy of endpoints and prompts. */
  runs: Run[]
  config: RunConfig
  /** Agent loop estimator inputs. */
  loop: { steps: number; firstInput: number; output: number; toolTokens: number; toolMs: number }
  sampleId?: string
}

// ---------- Tiny IndexedDB wrapper (falls back to memory in private modes) ----------

const DB = 'token-bench'
type StoreName = 'projects' | 'keys'
let dbp: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  return dbp ??= new Promise(res => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('projects', { keyPath: 'id' })
        req.result.createObjectStore('keys')
      }
      req.onsuccess = () => res(req.result)
      req.onerror = () => res(null)
    } catch { res(null) }
  })
}
const mem = { projects: new Map<string, unknown>(), keys: new Map<string, unknown>() }

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  if (!d) throw new Error('no-idb')
  return new Promise((res, rej) => {
    const r = fn(d.transaction(store, mode).objectStore(store))
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  try { return await tx(store, 'readonly', s => s.getAll()) as T[] } catch { return [...mem[store].values()] as T[] }
}
async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  try { return await tx(store, 'readonly', s => s.get(key)) as T | undefined } catch { return mem[store].get(key) as T | undefined }
}
async function idbPut(store: StoreName, value: unknown, key?: string) {
  try { await tx(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key)) } catch { mem[store].set(key ?? (value as { id: string }).id, value) }
}
async function idbDel(store: StoreName, key: string) {
  try { await tx(store, 'readwrite', s => s.delete(key)) } catch { mem[store].delete(key) }
}

// ---------- API keys: this device only, never part of a project, never synced or exported ----------

export const getKey = async (endpointId: string) => (await idbGet<string>('keys', endpointId)) ?? ''
export const setKey = (endpointId: string, key: string) => key ? idbPut('keys', key, endpointId) : idbDel('keys', endpointId)
export async function getKeys(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const id of ids) out[id] = await getKey(id)
  return out
}

// ---------- In-memory project list with subscribers ----------

let projects: Project[] = []
let loaded = false
const subs = new Set<() => void>()
const emit = () => { projects = [...projects]; subs.forEach(f => f()) }
const changeHooks = new Set<(p: Project) => void>()

export const onProjectChange = (f: (p: Project) => void) => { changeHooks.add(f); return () => changeHooks.delete(f) }

export async function loadProjects() {
  projects = (await idbGetAll<Project>('projects')).sort((a, b) => b.updatedAt - a.updatedAt)
  loaded = true
  emit()
}

export function useProjects() {
  return useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f) }, () => loaded ? projects : null)
}

export const getProjects = () => projects
export const getProject = (id: string) => projects.find(p => p.id === id)

export async function saveProject(p: Project, opts: { touch?: boolean; silent?: boolean } = {}) {
  const next = opts.touch === false ? p : { ...p, updatedAt: Date.now() }
  await idbPut('projects', next)
  const i = projects.findIndex(x => x.id === p.id)
  if (i >= 0) projects[i] = next
  else projects.unshift(next)
  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  emit()
  if (!opts.silent) changeHooks.forEach(f => f(next))
  return next
}

/** Deletes locally; returns an undo function. Keys are kept until the undo window has passed. */
export async function deleteProject(id: string): Promise<() => Promise<void>> {
  const p = getProject(id)
  projects = projects.filter(x => x.id !== id)
  emit()
  await idbDel('projects', id)
  addTombstone(id)
  const purge = setTimeout(() => { for (const e of p?.endpoints ?? []) void setKey(e.id, '') }, 15000)
  return async () => {
    clearTimeout(purge)
    if (!p) return
    removeTombstone(id)
    await saveProject(p)
  }
}

export const uuid = () => crypto.randomUUID()

// Tombstones keep a project deleted offline from coming back on the next sync.
const TOMB = 'token-bench.tombstones'
export const tombstones = (): string[] => { try { return JSON.parse(localStorage.getItem(TOMB) ?? '[]') } catch { return [] } }
const addTombstone = (id: string) => localStorage.setItem(TOMB, JSON.stringify([...new Set([...tombstones(), id])]))
const removeTombstone = (id: string) => localStorage.setItem(TOMB, JSON.stringify(tombstones().filter(x => x !== id)))
export const clearTombstones = (ids: string[]) => localStorage.setItem(TOMB, JSON.stringify(tombstones().filter(x => !ids.includes(x))))

// ---------- App defaults (settings page) ----------

export interface Defaults extends RunConfig { rankBy: 'e2e' | 'ttft' | 'tps' | 'cost' }
const DEF_KEY = 'token-bench.defaults'
const BASE_DEFAULTS: Defaults = { reps: 3, concurrency: 2, rampMs: 250, timeoutMs: 60000, temperature: 0, rankBy: 'e2e' }
export function getDefaults(): Defaults {
  try { return { ...BASE_DEFAULTS, ...JSON.parse(localStorage.getItem(DEF_KEY) ?? '{}') } } catch { return BASE_DEFAULTS }
}
export const setDefaults = (d: Defaults) => localStorage.setItem(DEF_KEY, JSON.stringify(d))
export const resetDefaults = () => localStorage.removeItem(DEF_KEY)

export function defaultConfig(): RunConfig {
  const { rankBy: _r, ...c } = getDefaults()
  return c
}
