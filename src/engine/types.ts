/** An OpenAI-compatible chat completions endpoint. API keys are never stored on this object. */
export interface Endpoint {
  id: string
  name: string
  preset?: string
  baseUrl: string
  model: string
  /** USD per 1M input tokens, entered by the user. */
  inputPrice?: number
  /** USD per 1M output tokens, entered by the user. */
  outputPrice?: number
  /** Send stream_options.include_usage so the final chunk carries exact token counts. */
  streamOptions: boolean
  color?: string
}

export interface Prompt {
  id: string
  name: string
  suite: string
  system?: string
  user: string
  /** Target output length in tokens; also sent as max_tokens. */
  maxTokens: number
  /** Ask for response_format json_object. */
  json?: boolean
}

export type ErrorKind = 'rate_limit' | 'http' | 'network' | 'timeout' | 'stream' | 'aborted'

export interface RequestResult {
  endpointId: string
  promptId: string
  rep: number
  /** ms since the run started. */
  startedAt: number
  ok: boolean
  status?: number
  errorKind?: ErrorKind
  error?: string
  /** Time to first content token, ms. */
  ttftMs?: number
  /** End-to-end latency, ms. */
  totalMs?: number
  outputTokens?: number
  inputTokens?: number
  tokenSource?: 'usage' | 'approx'
  /** Arrival time (ms since request start) of every chunk that carried content. */
  chunks?: number[]
  /** First part of the generated text, kept for inspection and replay. */
  text?: string
}

export interface RunConfig {
  reps: number
  concurrency: number
  /** Delay between starting each additional worker. */
  rampMs: number
  timeoutMs: number
  temperature: number
}

export interface Run {
  id: string
  label: string
  createdAt: number
  source: 'browser' | 'node' | 'import' | 'sample'
  config: RunConfig
  endpoints: Endpoint[]
  prompts: Prompt[]
  results: RequestResult[]
  /** Wall clock duration of the whole run. */
  durationMs?: number
}
