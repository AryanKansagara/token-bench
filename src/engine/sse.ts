// Incremental Server-Sent Events parser plus the OpenAI chat-completions chunk shape.

export interface SseEvent { event?: string; data: string }

/** Feed raw text in arbitrary pieces; complete events are emitted as soon as their blank line arrives. */
export function createSseParser(onEvent: (e: SseEvent) => void) {
  let buf = ''
  let data: string[] = []
  let event: string | undefined
  const dispatch = () => {
    if (data.length) onEvent({ event, data: data.join('\n') })
    data = []
    event = undefined
  }
  const line = (l: string) => {
    if (l === '') return dispatch()
    if (l.startsWith(':')) return
    const i = l.indexOf(':')
    const field = i < 0 ? l : l.slice(0, i)
    let value = i < 0 ? '' : l.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
  }
  return {
    push(text: string) {
      buf += text
      let m: RegExpExecArray | null
      const re = /\r\n|\r|\n/g
      let start = 0
      while ((m = re.exec(buf))) {
        // A lone \r at the very end might be the first half of \r\n; wait for more input.
        if (m[0] === '\r' && m.index === buf.length - 1) break
        line(buf.slice(start, m.index))
        start = m.index + m[0].length
      }
      buf = buf.slice(start)
    },
    end() {
      if (buf) line(buf)
      buf = ''
      dispatch()
    },
  }
}

export interface ChatDelta {
  done: boolean
  content: string
  /** Reasoning models stream thinking separately; it still counts as generated output. */
  reasoning: string
  finishReason?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: string
}

/** Interprets one SSE data payload from /v1/chat/completions with stream: true. */
export function parseChatData(data: string): ChatDelta {
  const out: ChatDelta = { done: false, content: '', reasoning: '' }
  if (data.trim() === '[DONE]') return { ...out, done: true }
  let j: unknown
  try { j = JSON.parse(data) } catch { return { ...out, error: `Malformed stream chunk: ${data.slice(0, 120)}` } }
  const o = j as { choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; text?: string; finish_reason?: string | null }[]; usage?: ChatDelta['usage'] | null; error?: { message?: string } | string }
  if (o.error) return { ...out, error: typeof o.error === 'string' ? o.error : o.error.message ?? 'Provider returned an error mid-stream' }
  for (const c of o.choices ?? []) {
    out.content += c.delta?.content ?? c.text ?? ''
    out.reasoning += c.delta?.reasoning ?? c.delta?.reasoning_content ?? ''
    if (c.finish_reason) out.finishReason = c.finish_reason
  }
  if (o.usage) out.usage = o.usage
  return out
}

/**
 * Local token approximation for providers that do not report usage.
 * Blends the two classic heuristics (about 4 characters or 0.75 words per token) which keeps
 * English prose and code within roughly 10 percent of BPE tokenizers.
 */
export function approxTokens(text: string): number {
  if (!text) return 0
  const chars = text.length / 4
  const words = (text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []).length * 0.75
  return Math.max(1, Math.round((chars + words) / 2))
}
