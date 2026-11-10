import { sampleRun, SAMPLE_ENDPOINTS, SAMPLE_PROMPTS } from './engine/sample.ts'
import { SUITES } from './engine/suites.ts'
import type { Run } from './engine/types.ts'
import { defaultConfig, getProjects, saveProject, uuid, type Project } from './store.ts'

export const DEFAULT_LOOP: Project['loop'] = { steps: 8, firstInput: 2000, output: 300, toolTokens: 800, toolMs: 400 }

/** Distinct, accessible series colours (orange first, after the brand). */
export const SERIES = ['#f05a28', '#2f8f9d', '#9b6ad6', '#d4a20a', '#3f9f5f', '#d0487a', '#5b7bd5', '#8a6d4e']
export const colorOf = (run: Pick<Run, 'endpoints'>, id: string) => {
  const i = run.endpoints.findIndex(e => e.id === id)
  return run.endpoints[i]?.color ?? SERIES[i % SERIES.length]
}

export async function createSampleProject(): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === 'synthetic')
  if (existing) return existing
  const now = Date.now()
  return saveProject({
    id: uuid(), name: 'Synthetic providers A, B, C', createdAt: now, updatedAt: now, sampleId: 'synthetic',
    endpoints: SAMPLE_ENDPOINTS, prompts: SAMPLE_PROMPTS, config: { ...defaultConfig(), reps: 2, concurrency: 3 }, loop: DEFAULT_LOOP,
    runs: [sampleRun('baseline'), sampleRun('rerun')].map(r => ({ ...r, id: uuid() })),
  })
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, endpoints: [], prompts: SUITES[0].prompts, runs: [], config: defaultConfig(), loop: DEFAULT_LOOP })
}

export const latestRun = (p: Project): Run | undefined => p.runs[p.runs.length - 1]
