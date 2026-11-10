# Token Bench

A browser-based benchmark for OpenAI-compatible inference APIs. Run real streamed requests against any provider with your own key, on your own prompts, and compare time to first token, output tokens per second, end-to-end latency and consistency.

Live: https://token-bench.vercel.app

## The pain it solves

Choosing a fast inference provider today means trusting someone else's leaderboard, measured on someone else's prompts, in someone else's region. Speed is inconsistent, rate limits bite at the worst time, and a few hundred milliseconds of TTFT multiply across every call of an agent loop. Token Bench measures what you will actually get.

## Features

- Endpoints with presets for Cerebras, Groq, Together, Fireworks, OpenRouter, Ollama and llama.cpp, or any custom base URL. Keys stay in IndexedDB on your device and are never synced or exported.
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

Built by Aryan Kansagara. Independent project, not affiliated with Cerebras.
