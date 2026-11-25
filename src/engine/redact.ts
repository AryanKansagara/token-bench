// Removes API keys from text a provider sent back, before that text is shown, saved, exported or synced.
import type { RequestResult, Run } from './types.ts'

/**
 * Makes a function that replaces every recognisable copy of `keys` in a text with "[key hidden]": the whole key in any case,
 * fragments of 8 or more characters, starts and ends left around a mask ("sk-te***7890"), a key cut off
 * at the end of the text, keys broken up by spaces or line breaks, and the same inside percent, JSON,
 * HTML entity, base64 or hex encoding. With `guess`, also text that looks like a key although it is not
 * one of `keys` (a key that was since changed or removed, or that belongs to someone else).
 *
 * Not recognised: hashes and other one-way or unusual transforms (reversed, encrypted, compressed),
 * fragments shorter than 8 characters in the middle of a key, and keys under 4 characters.
 *
 * Self-contained on purpose: the terminal script embeds this function's own source.
 */
export function keyHider(keys: string[], guess = false): (text: string) => string {
  /** A reading of the text. `s` and `e` give each character's span in the original; absent when it is the original. */
  type View = { str: string; s?: number[]; e?: number[] }
  const lower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase())
  const list = [...new Set(keys.map(k => lower(k.trim().replace(/^bearer\s+/i, '').replace(/\s/g, ''))))].filter(k => k.length >= 4)
  if (!list.length && !guess) return text => text
  const undo = (v: View): View => {
    const s: number[] = [], e: number[] = []
    let str = '', at = 0
    const copy = (to: number) => { for (; at < to; at++) { str += v.str[at]; s.push(v.s ? v.s[at] : at); e.push(v.e ? v.e[at] : at + 1) } }
    for (const m of v.str.matchAll(/%([0-9a-f]{2})|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|&#x([0-9a-f]{1,4});|&#(\d{1,5});|\\([/"\\])|&(amp|quot|lt|gt);/gi)) {
      copy(m.index)
      const hex = m[1] ?? m[2] ?? m[3] ?? m[4], last = at + m[0].length - 1
      str += hex ? String.fromCharCode(parseInt(hex, 16)) : m[5] ? String.fromCharCode(+m[5] & 0xffff) : m[6] ?? { amp: '&', quot: '"', lt: '<', gt: '>' }[m[7].toLowerCase()]!
      s.push(v.s ? v.s[at] : at); e.push(v.e ? v.e[last] : last + 1)
      at += m[0].length
    }
    if (!at) return v
    copy(v.str.length)
    return { str, s, e }
  }

  // Pieces to look for: every run of `size` characters of the key, and of its base64 and hex forms.
  const bytes = (s: string) => String.fromCharCode(...new TextEncoder().encode(s))
  const grams = (forms: string[], size: number) => {
    const bySize = new Map<number, Set<string>>()
    for (const f of forms) {
      const n = Math.min(size, f.length)
      if (n < 8) continue
      const set = bySize.get(n) ?? new Set<string>()
      for (let i = 0; i + n <= f.length; i++) set.add(f.slice(i, i + n))
      bySize.set(n, set)
    }
    return bySize
  }
  const encoded: string[] = []
  for (const k of new Set(keys.map(x => x.trim()).filter(x => x.length >= 8))) {
    encoded.push([...bytes(k)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
    // Base64 depends on where in a 3-byte group the key starts, so all three positions are tried.
    for (let o = 0; o < 3; o++) {
      const b = bytes(k)
      const whole = Math.floor((o + b.length) / 3) * 4
      const b64 = btoa('\0'.repeat(o) + b).slice(o ? o + 1 : 0, whole || undefined).replace(/=+$/, '')
      encoded.push(lower(b64), lower(b64.replace(/\+/g, '-').replace(/\//g, '_')))
    }
  }
  const plain = grams(list, 8), coded = grams(encoded, 12), loose = grams(list, 12)

  const token = /[A-Za-z0-9_*•…-]/
  const base64 = /[A-Za-z0-9+/=_-]/
  const alnum = /[A-Za-z0-9]/
  /** First two characters of every piece, so that almost every position is ruled out without a lookup. */
  const starts = (sets: Map<number, Set<string>>) => { const t = new Set<number>(); for (const set of sets.values()) for (const g of set) t.add(g.charCodeAt(0) * 65536 + g.charCodeAt(1)); return t }
  const search = (str: string, sets: Map<number, Set<string>>, first: Set<number>, word: RegExp | null, found: (from: number, to: number) => void) => {
    if (sets.size) for (let i = 0; i + 8 <= str.length; i++) {
      if (!first.has(str.charCodeAt(i) * 65536 + str.charCodeAt(i + 1))) continue
      for (const [n, set] of sets) {
        if (i + n > str.length || !set.has(str.slice(i, i + n))) continue
        let a = i, b = i + n
        // The rest of the same word goes too: what is left over is usually more of the key.
        if (word) { while (a > 0 && word.test(str[a - 1])) a--; while (b < str.length && word.test(str[b])) b++ }
        found(a, b)
        if (word) i = Math.max(i, b - n)
      }
    }
  }
  const plainStarts = starts(plain), codedStarts = starts(coded), looseStarts = starts(loose)

  return text => {
    if (!text) return text
    const hit = new Uint8Array(text.length)
    // The text as written, then with escapes undone. Three passes cover text that was escaped more than once.
    const views: View[] = [{ str: text }]
    for (let i = 0; i < 3; i++) {
      const next = undo(views[i])
      if (next === views[i]) break
      views.push(next)
    }
    for (const v of views) {
      const str = lower(v.str)
      const mark = (from: number, to: number) => { if (to > from) hit.fill(1, v.s ? v.s[from] : from, v.e ? v.e[to - 1] : to) }
      search(str, plain, plainStarts, token, mark)
      search(str, coded, codedStarts, base64, mark)
      // Keys broken up by white space or invisible characters.
      const packed = str.replace(/[\s\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
      if (packed.length !== str.length) {
        let where: number[] | null = null
        search(packed, loose, looseStarts, null, (a, b) => {
          if (!where) { where = []; for (let i = 0; i < str.length; i++) if (!/[\s\u00ad\u200b-\u200d\u2060\ufeff]/.test(str[i])) where.push(i) }
          mark(where[a], where[b - 1] + 1)
        })
      }

      const free = (a: number, b: number) => !alnum.test(str[a - 1] ?? ' ') && !alnum.test(str[b] ?? ' ')
      for (const k of list) {
        // Short keys only as a whole word, so a key "test" does not blank part of "latest".
        if (k.length < 8) for (let i = str.indexOf(k); i >= 0; i = str.indexOf(k, i + 1)) if (free(i, i + k.length)) mark(i, i + k.length)
        // "key ending in 7890": a short start or end standing alone, when it has a digit.
        if (k.length >= 8) for (let n = 4; n < 8; n++) for (const part of [k.slice(0, n), k.slice(-n)]) {
          if (/\d/.test(part)) for (let i = str.indexOf(part); i >= 0; i = str.indexOf(part, i + 1)) if (free(i, i + n)) mark(i, i + n)
        }
        // Cut off by a length limit: the text ends with the start of the key.
        for (let n = Math.min(k.length - 1, 7); n >= 4; n--) if (str.endsWith(k.slice(0, n)) && !alnum.test(str[str.length - n - 1] ?? ' ')) { mark(str.length - n, str.length); break }
      }

      // Masked copies: what is left visible next to the mask is the start or the end of the key.
      const edge = /[\s"'`<>(){}[\],;:=*•●∙·…█#]/
      if (list.length) for (const m of str.matchAll(/[*•●∙·…█#]+|\.{2,}|x{3,}|[[<(]?(?:redacted|masked|hidden)[\])>]?/g)) {
        const end = m.index + m[0].length
        let a = m.index, b = end
        while (a > 0 && !edge.test(str[a - 1])) a--
        while (b < str.length && !edge.test(str[b]) && !(/[.!?]/.test(str[b]) && !alnum.test(str[b + 1] ?? ' '))) b++
        const left = str.slice(a, m.index), right = str.slice(end, b)
        // Dots, x and words also occur in ordinary prose, so they need a longer match.
        const strict = !/^[*•●∙█]{2,}$/.test(m[0])
        const isLeft = list.some(k => left.length >= (strict ? 4 : 2) && k.startsWith(left))
        const isRight = list.some(k => right.length >= (strict ? 4 : 2) && k.endsWith(right))
        if (isLeft || isRight) mark(isLeft ? a : m.index, isRight ? b : end)
      }

      if (guess) {
        const tail = (re: RegExp) => { for (const m of v.str.matchAll(re)) { const t = m[m.length - 1]; mark(m.index + m[0].length - t.length, m.index + m[0].length) } }
        // Common key prefixes, Google keys, JWTs, and any long value introduced as a key or bearer token.
        tail(/(?<![A-Za-z0-9])((?:sk|csk|gsk|fw|xai|hf|r8|nvapi|pplx|tgp|rk|pk)[-_](?=[\w-]*\d)[\w-]{12,})/gi)
        tail(/(?<![A-Za-z0-9])(AIza[\w-]{30,})/g)
        tail(/(?<![A-Za-z0-9])(eyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?)/g)
        tail(/\bBearer\s+((?=[^\s"']*\d)[\w.~+/=-]{12,})/gi)
        tail(/\b(?:api|access|secret|auth)?[ _-]?(?:key|token|credential)s?(?: (?:provided|supplied|is|was))?(?:\s*[:=]\s*|\s+)["'`]?((?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{16,})/gi)
      }
    }

    let out = ''
    for (let i = 0; i < text.length; i++) {
      if (!hit[i]) out += text[i]
      else if (!i || !hit[i - 1]) out += '[key hidden]'
    }
    return out
  }
}

export const hideKeys = (text: string, keys: string[], guess = false) => keyHider(keys, guess)(text)

/** Every string a provider could have put on a result, without keys. Returns the same object when nothing changed. */
export const cleanResult = (r: RequestResult, keys: string[]) => clean(r, keyHider(keys), keyHider(keys))

function clean(r: RequestResult, hide: (s: string) => string, hideInError: (s: string) => string): RequestResult {
  const scrub = (v: unknown, g: boolean): unknown => typeof v === 'string' ? (g ? hideInError : hide)(v)
    : Array.isArray(v) ? v.map(x => scrub(x, g))
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [(g ? hideInError : hide)(k), scrub(x, g)])) : v
  let out: Record<string, unknown> | null = null
  for (const [k, v] of Object.entries(r)) {
    // Ids and enums are ours; chunk timings are numbers and can be thousands long.
    if (v === undefined || typeof v === 'number' || typeof v === 'boolean' || ['endpointId', 'promptId', 'errorKind', 'tokenSource', 'chunks'].includes(k)) continue
    // Guessing is for error text only: generated text may legitimately contain example keys.
    const next = scrub(v, k === 'error')
    if (JSON.stringify(next) !== JSON.stringify(v)) (out ??= { ...r })[k] = next
  }
  return (out as RequestResult | null) ?? r
}

/** A run without keys in its results. Returns the same object when nothing changed. */
export function cleanRun(run: Run, keys: string[] = []): Run {
  // A run from an older version or another device may hold anything; never let it stop the page loading.
  if (!Array.isArray(run.results)) return run
  const hide = keyHider(keys), hideInError = keyHider(keys, true)
  let changed = false
  const results = run.results.map(r => { const c = r && typeof r === 'object' ? clean(r, hide, hideInError) : r; changed ||= c !== r; return c })
  return changed ? { ...run, results } : run
}
