# Token Bench

A browser-based benchmark for OpenAI-compatible inference APIs. Run real streamed requests against any provider with your own key, on your own prompts, and compare time to first token, output tokens per second, end-to-end latency and consistency.

Live: https://token-bench.vercel.app

## The pain it solves

Choosing a fast inference provider today means trusting someone else's leaderboard, measured on someone else's prompts, in someone else's region. Speed is inconsistent, rate limits bite at the worst time, and a few hundred milliseconds of TTFT multiply across every call of an agent loop. Token Bench measures what you will actually get.

## Features

- Endpoints with presets for Cerebras, Groq, Together, Fireworks, OpenRouter, Ollama and llama.cpp, or any custom base URL. Hosted presets default to gpt-oss-120b with list prices, and Cerebras and OpenRouter cards can load their live public model list and prices. Model ids, prices and browser (CORS) behaviour were checked against each provider on 2026-11-13; see Docs. Keys stay in IndexedDB on your device and are never synced or exported.
- Built-in prompt suites (short chat, long-context summarisation, code, JSON mode) plus CSV / TSV / JSONL / JSON import with column mapping and a line-numbered validation report.
- Streaming engine: incremental SSE parser, TTFT, inter-token latency distribution and jitter, decode tokens/s from the usage chunk or a local token approximation, error and 429 classification.
- Concurrency runner with N parallel workers and a ramp, requests interleaved across providers.
- Percentiles with bootstrap confidence intervals, leaderboard on your prompts, per-prompt matrix, race chart, run timeline, cost per 1M tokens from your prices.
- Agent loop estimator: Monte Carlo over measured requests, with prefill growth modelled when your prompts span context sizes.
- History with compare view, CSV / JSON export, printable report, share links (compressed in the URL fragment).
- CORS fallback: a generated, dependency-free Node script runs the identical benchmark from a terminal and writes a result file to import.
- Labelled synthetic sample (fake providers A, B, C) replayed at real timing, so everything works without a key.
- Optional accounts (Supabase) to sync benchmarks across devices. Everything works signed out.

## Run locally

```
npm install
npm run dev      # http://localhost:4387
npm test         # engine tests
npm run build
```

Copy `.env.example` values (Supabase URL and publishable key) into `.env` to enable sync; without them the app runs local-only.

## Tests

```
npm test                                   # engine unit tests
npx playwright install chromium            # once; Linux CI also needs --with-deps
npm run test:e2e                           # builds, serves the production build, runs the browser suite
E2E_PORT=4500 npm run test:e2e             # pick another port (default 4399)
```

The end-to-end suite (`e2e/`, Playwright with Chromium) runs against the production build served by `vite preview`. It never contacts a real provider: streaming runs go to an in-process stub server on `127.0.0.1` (`e2e/stub.ts`) that can answer cleanly, rate limit, fail, stall or cut a stream off, provider hosts such as `api.groq.com` are answered by `page.route`, every other external request is blocked, API keys are made-up strings, and an uncaught page error fails the test. Tests marked `test.fail` document a known app bug and link its issue; when the bug is fixed they report "expected to fail but passed", and the marker should be removed.

GitHub Actions (`.github/workflows/ci.yml`, job `test`) runs install, build, unit tests and the end-to-end suite on every pull request and on pushes to `main`.

Vercel builds only `main` (`git.deploymentEnabled` in `vercel.json`), so pull requests are gated by the `test` check, not by preview deployments.

Built by Aryan Kansagara.
