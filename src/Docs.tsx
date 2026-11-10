import { PRESETS } from './engine/suites.ts'
import { Code, Link } from './ui.tsx'

const CSV = `name,prompt,max_tokens,suite,json
triage-1,"Classify this ticket: ""Checkout fails for EU users""",120,Support,
summary-1,"Summarise the following call transcript: ...",300,Summaries,
extract-1,"Extract invoice fields as JSON from: ...",200,Extraction,yes`

const JSONL = `{"name": "triage-1", "messages": [{"role": "system", "content": "You are a support triage bot."}, {"role": "user", "content": "Checkout fails for EU users"}], "max_tokens": 120}
{"name": "extract-1", "prompt": "Extract invoice fields from: ...", "max_tokens": 200, "response_format": {"type": "json_object"}}`

const SQL = `-- Sample 200 recent production prompts from a request log table (Postgres).
-- Adjust table and column names to your logging schema.
SELECT
  id::text                         AS name,
  request_body->'messages'         AS messages,
  LEAST(COALESCE((response_body->'usage'->>'completion_tokens')::int, 256), 4096) AS max_tokens
FROM llm_requests
WHERE created_at > now() - interval '7 days'
  AND status = 200
ORDER BY random()
LIMIT 200;
-- Export as JSON lines, one object per row:
-- \\copy (SELECT row_to_json(t) FROM (...query above...) t) TO 'prompts.jsonl'`

const OLLAMA = `# macOS app: set the variable for launchd, then restart Ollama
launchctl setenv OLLAMA_ORIGINS "https://token-bench.vercel.app"
# or when running the server yourself
OLLAMA_ORIGINS="https://token-bench.vercel.app" ollama serve`

const RESULT = `{
  "format": "token-bench-run", "version": 1,
  "label": "Terminal run 2026-11-10 14:02", "createdAt": 1793541720000, "source": "node",
  "config": { "reps": 3, "concurrency": 2, "rampMs": 250, "timeoutMs": 60000, "temperature": 0 },
  "endpoints": [{ "id": "…", "name": "Cerebras", "baseUrl": "https://api.cerebras.ai/v1", "model": "llama-3.3-70b", "streamOptions": true }],
  "prompts": [{ "id": "builtin:chat-1", "name": "Chat 1", "suite": "Short chat", "user": "…", "maxTokens": 150 }],
  "results": [{ "endpointId": "…", "promptId": "builtin:chat-1", "rep": 0, "startedAt": 0, "ok": true, "status": 200,
    "ttftMs": 182.4, "totalMs": 301.9, "outputTokens": 141, "inputTokens": 38, "tokenSource": "usage", "chunks": [182.4, 190.1, …] }]
}`

export default function Docs() {
  return (
    <section className="page docs">
      <aside className="docs-nav" aria-label="On this page">
        <a href="#start">Quick start</a><a href="#providers">Providers</a><a href="#cors">CORS and the terminal script</a><a href="#prompts">Prompt files</a><a href="#results">Result files</a><a href="#metrics">Metric definitions</a><a href="#pricing">Pricing assumptions</a><a href="#privacy">Keys and privacy</a>
      </aside>
      <div className="docs-body">
        <p className="eyebrow">Docs</p>
        <h1>Using Token Bench</h1>
        <p className="muted">Last reviewed 10 November 2026.</p>

        <h2 id="start">Quick start</h2>
        <ol>
          <li>Open <Link href="/app">Benchmarks</Link> and create one per decision, for example "Agent backend, Q4".</li>
          <li>On <b>Endpoints</b>, add the providers you are choosing between from a preset, paste each API key, and press <b>Test connection</b>.</li>
          <li>On <b>Prompts</b>, tick built-in suites and import a sample of your real prompts.</li>
          <li>On <b>Run</b>, choose repetitions (3 or more gives usable confidence intervals) and parallelism, then start. Results land in <b>Results</b> and <b>History</b>.</li>
          <li>Rerun next month and use <b>History → Compare two runs</b> to see what changed.</li>
        </ol>

        <h2 id="providers">Providers and base URLs</h2>
        <p>Any endpoint that implements <code>POST /chat/completions</code> with <code>stream: true</code> works. Defaults below use Llama 3.3 70B everywhere so the first comparison is like for like; model ids change, so check each provider's model list.</p>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Preset</th><th>Base URL</th><th>Default model</th><th>Browser calls</th></tr></thead>
          <tbody>{PRESETS.map(p => <tr key={p.id}><td>{p.name}</td><td className="mono small">{p.baseUrl}</td><td className="mono small">{p.model}</td><td className="small">{p.cors === 'yes' ? 'Allowed' : p.cors === 'local' ? 'Needs local config' : 'Depends on provider policy; test it'}</td></tr>)}</tbody>
        </table></div>
        <p>Usage chunk: when <code>stream_options.include_usage</code> is on, the final chunk reports exact prompt and completion tokens. A few servers reject the option with HTTP 400; untick it on the endpoint and Token Bench falls back to its local token approximation (marked ≈).</p>

        <h2 id="cors">CORS and the terminal script</h2>
        <p>Browsers only show a cross-origin response if the server allows it. When a provider does not, the request fails before it is sent, with an opaque network error that looks the same as a DNS failure. Token Bench reports these as <b>blocked by the browser</b>. Your key is not the problem.</p>
        <p>The fix is the terminal script on the Run tab: a single <code>.mjs</code> file for Node 18 or newer, no dependencies, containing your endpoints, prompts and settings but no keys. It uses the same request body, the same SSE parsing and the same timing points as the browser.</p>
        <Code label="Shell" code={`export TB_KEY_CEREBRAS_1=...     # names are printed at the top of the script\nnode token-bench.mjs results.json\n# then: Benchmark → History → Import result file`} />
        <p>Running it from a server in the same region as your production app gives the most representative numbers.</p>
        <p><b>Ollama</b> rejects browser origins by default. Allow this site:</p>
        <Code label="Shell" code={OLLAMA} />
        <p><b>llama.cpp</b> <code>llama-server</code> allows browser requests by default. Use base URL <code>http://localhost:8080/v1</code>.</p>

        <h2 id="prompts">Prompt files</h2>
        <p>Import CSV, TSV, JSONL or a JSON array on the Prompts tab. Columns are detected by name and can be remapped; the validation report lists problems by line number and skips only the bad rows.</p>
        <h3>CSV</h3>
        <p>Required: a prompt column (<code>prompt</code>, <code>user</code>, <code>input</code>, <code>question</code>, <code>content</code> or <code>text</code>). Optional: <code>name</code>, <code>system</code>, <code>max_tokens</code> (target output length, 1 to 32768), <code>suite</code>, <code>json</code> (yes/true/1).</p>
        <Code label="prompts.csv" code={CSV} />
        <h3>JSONL in OpenAI format</h3>
        <p>One object per line. Either a <code>prompt</code> string or a <code>messages</code> array; system messages become the system prompt and multi-turn conversations are flattened into one user message (flagged as a warning). <code>response_format: json_object</code> turns on JSON mode.</p>
        <Code label="prompts.jsonl" code={JSONL} />
        <h3>Getting prompts out of your logs</h3>
        <p>If you log LLM requests to a database, sample real traffic. Keep the original output length as the target so decode time is realistic. Remove personal data before importing; prompts are stored in this browser and synced if you sign in.</p>
        <Code label="SQL" code={SQL} />
        <p>From LangSmith, Langfuse or Helicone: export traces as JSON or CSV and keep the input messages plus the completion token count; the JSONL format above is accepted directly.</p>

        <h2 id="results">Result files</h2>
        <p>Every run exports as JSON (and CSV for spreadsheets). The terminal script writes the same JSON. Share links carry the same data without per-chunk timings or generated text, compressed into the URL fragment, which is never sent to a server.</p>
        <Code label="results.json" code={RESULT} />

        <h2 id="metrics">Metric definitions</h2>
        <dl className="defs">
          <dt>TTFT</dt><dd>Milliseconds from sending the request to receiving the first SSE chunk containing content or reasoning text. Role-only chunks do not count.</dd>
          <dt>Output tokens/s (decode)</dt><dd>(output tokens − 1) ÷ (end-to-end − TTFT). Excludes queueing and prefill, so it isolates generation speed.</dd>
          <dt>End-to-end latency</dt><dd>Request sent to stream closed.</dd>
          <dt>Inter-token latency</dt><dd>Gap between consecutive content chunks divided by the average tokens per chunk for that request. Providers batch tokens differently, so per-chunk gaps alone are not comparable.</dd>
          <dt>Jitter</dt><dd>Median absolute change between consecutive inter-token gaps. Zero for a perfectly steady stream; robust to a single stall.</dd>
          <dt>Consistency</dt><dd>Coefficient of variation (standard deviation ÷ mean) of decode speed across requests.</dd>
          <dt>Percentiles and intervals</dt><dd>Linear interpolation (numpy default). Intervals are 95% percentile bootstrap on the median with 1,000 resamples and a fixed seed.</dd>
          <dt>Error and 429 rate</dt><dd>Failed requests over all completed requests; cancelled requests are excluded. Failed requests are not counted in cost.</dd>
          <dt>Token approximation</dt><dd>When no usage chunk arrives: the average of characters ÷ 4 and words × 0.75, typically within about 10% of BPE tokenizers for English and code.</dd>
          <dt>Agent loop estimate</dt><dd>2,000 Monte Carlo draws of measured (TTFT, decode speed) pairs per call. If the run includes prompts of very different lengths and TTFT rises with input, TTFT is modelled as a line in input tokens plus a resampled residual.</dd>
        </dl>

        <h2 id="pricing">Pricing assumptions</h2>
        <p>As of 10 November 2026, Token Bench ships no prices: provider prices change often and differ by model, tier and region. Enter input and output prices per 1M tokens on each endpoint from the provider's pricing page. Cost per 1M is blended at the actual input to output mix of the run, and failed requests are treated as free. Cached-input discounts, batch discounts and minimum charges are not modelled.</p>

        <h2 id="privacy">Keys and privacy</h2>
        <ul>
          <li>API keys are stored in this browser's IndexedDB, sent only to the endpoint they belong to, and never synced, exported or included in share links or terminal scripts.</li>
          <li>Requests go directly from your browser to the provider; there is no proxy.</li>
          <li>Signing in is optional. It syncs benchmark names, endpoints (without keys), prompts and runs. Runs over 1.5 MB sync without per-chunk timings, which stay on the device that recorded them.</li>
          <li>The account menu exports all your data as JSON and deletes cloud data or the whole account.</li>
        </ul>
      </div>
    </section>
  )
}
