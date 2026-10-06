# Mole-Intel-Debate

Fork of Mole-Intel with a multi-agent bull/bear/valuation/macro/earnings/analyst debate desk, a vLLM backend, and overnight S&P 500 batch runs.

## What's in here

- `debate/engine.mjs` — six agents (bull, bear, valuation, macro, earnings-call, analyst-ratings) each write one JSON note from a shared packet of real data, then a judge synthesizes and explicitly lists every unresolved disagreement.
- `debate/cron.sh` — overnight batch runner for cron.
- `docker-compose.vllm.yml` — vLLM serving Qwen3.5-9B AWQ on a 10GB RTX 3080.
- `universe.json` — ticker universe: S&P 500 + Nasdaq 100 + Russell 2000 (~2000 names).

## Quick start

```bash
# 1. Start the model (10GB card, 8K context)
docker compose -f docker-compose.vllm.yml up -d

# 2. Run one ticker
node debate/engine.mjs NVDA

# 3. Overnight batch
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
| `EARNINGS_CALLS` | `3` | How many past earnings-call transcripts to pull |

## Universe

The engine loads tickers from, in order:

1. `../Mole-Intel/src/data/universe.ts` (if the parent repo is checked out alongside)
2. `./universe.json` in this repo
3. A small built-in fallback list

`universe.json` ships with the S&P 500. To add Nasdaq 100 / Russell 2000 / other indices, merge their ticker lists into it (dedupe by ticker). The parent Mole-Intel repo's universe.ts already contains S&P 500 + Nasdaq 100 + Russell 2000 + international indices if you point the engine at it.

## Power limit (RTX 3080 10GB)

For this workload — long overnight inference, not gaming — set the power limit to **220–250W** (out of 320W max):

- 250W: max throughput, ~150 tok/s, but the card and PSU run hot all night. Fine if your case has good airflow.
- 220W: ~10–15% slower, noticeably cooler and quieter, still finishes 500 names in the window. This is the sweet spot for an unattended overnight run.
- Below 200W: throughput drops fast; not worth it.

Set it with `nvidia-smi -pl 220` (persists until reboot on some drivers; re-apply in cron.sh if needed). Watch `nvidia-smi` during the first run — if GPU temp stays under 80°C you're fine.

## Design notes

- **Data and LLM are separated.** All numbers are computed in code and injected as facts.
- **Agents run in parallel** per ticker.
- **Fixed rounds.** One round of six agents plus one judge call per ticker.
- **Best-effort sources.** SearXNG and Finnhub failures never abort a debate.

## Requirements

- Docker + NVIDIA Container Toolkit (for vLLM)
- Node 22+
- Python 3 with `yfinance` (`pip install yfinance`)
- Optional: FRED API key, Finnhub API key (free tier at https://finnhub.io)
- Optional: a running SearXNG instance (default http://192.168.86.35:8099)
