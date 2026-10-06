# Mole-Intel-Debate

Fork of Mole-Intel with a multi-agent bull/bear/valuation/macro/earnings/analyst debate desk, a vLLM backend, and overnight S&P 500 batch runs.

## What's in here

- `debate/engine.mjs` — the debate engine. Six agents (bull, bear, valuation, macro, earnings-call, analyst-ratings) each write one JSON note from a shared packet of real data, then a judge synthesizes and explicitly lists every unresolved disagreement instead of forcing agreement.
- `debate/cron.sh` — overnight batch runner for cron.
- `docker-compose.vllm.yml` — vLLM serving Qwen3.5-9B AWQ on a 10GB RTX 3080.

## Quick start

```bash
# 1. Start the model (10GB card, 8K context)
docker compose -f docker-compose.vllm.yml up -d

# 2. Run one ticker
node debate/engine.mjs NVDA

# 3. Overnight batch (all S&P 500 names)
./debate/cron.sh
# or: 0 23 * * * /path/to/Mole-Intel-Debate/debate/cron.sh
```

## Config

| Env | Default | Meaning |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:8000/v1` | OpenAI-compatible endpoint (vLLM or Ollama) |
| `LLM_MODEL` | `qwen3.5-9b` | Served model name |
| `MOLE_DATA` | `./data` | Archive directory (JSONL) |
| `FRED_API_KEY` | (empty) | Optional; macro agent uses public series otherwise |
| `SEARXNG_URL` | `http://192.168.86.35:8099` | Your SearXNG instance |
| `SEARXNG_TIMEOUT` | `15000` | Per-query timeout in ms |
| `FINNHUB_API_KEY` | (empty) | Optional; analyst ratings, price targets, insider transactions |
| `EARNINGS_CALLS` | `3` | How many past earnings-call transcripts to pull (most recent prioritized) |

## Data sources per ticker

- **yfinance** — financials, valuation multiples, 3-month price history (1m/3m returns, 52w range)
- **FRED** — macro backdrop (fed funds, CPI, unemployment, 10y yield)
- **SearXNG** — recent news headlines + earnings-call transcript snippets (best-effort, 24h cache)
- **Finnhub** (optional) — analyst rating changes by firm, consensus, average/high/low price targets, insider open-market buys/sells

## Design notes

- **Data and LLM are separated.** All numbers are computed in code and injected into each agent's prompt as facts. The model only interprets and argues.
- **Agents run in parallel** per ticker; they never see each other's output, so the judge's disagreements are real.
- **Fixed rounds.** One round of six agents plus one judge call per ticker.
- **Throughput.** vLLM ~150 tok/s. 503 names at 6 agent calls + 1 judge each ≈ 5–6 hours — inside a 23:00–09:00 window. If it doesn't fit, drop `EARNINGS_CALLS` to 1 or skip the earnings agent for the batch.
- **10GB fit.** Qwen3.5-9B AWQ ~6GB weights; 8K context stays under 10GB at 0.85 utilization.
- **Best-effort sources.** SearXNG and Finnhub failures never abort a debate; the packet just has fewer fields.

## Requirements

- Docker + NVIDIA Container Toolkit (for vLLM)
- Node 22+
- Python 3 with `yfinance` (`pip install yfinance`)
- Optional: FRED API key, Finnhub API key (free tier at https://finnhub.io)
- Optional: a running SearXNG instance (default http://192.168.86.35:8099)
