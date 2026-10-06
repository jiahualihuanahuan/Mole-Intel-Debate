# Mole-Intel-Debate

Fork of Mole-Intel with a multi-agent bull/bear/valuation/macro debate desk, a vLLM backend, and overnight S&P 500 batch runs.

## What's in here

- `debate/engine.mjs` — the debate engine. Four agents (bull, bear, valuation, macro) each write one JSON note from a shared packet of real data (yfinance financials + FRED macro + SearXNG news), then a judge synthesizes and explicitly lists every unresolved disagreement instead of forcing agreement.
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
| `SEARXNG_URL` | `http://192.168.86.35:8099` | Your SearXNG instance (JSON API at /search?q=...&format=json) |
| `SEARXNG_TIMEOUT` | `15000` | Per-query timeout in ms |

## Design notes

- **Data and LLM are separated.** yfinance + FRED + SearXNG numbers are computed in code and injected into each agent's prompt as facts. The model only interprets and argues — it cannot invent the multiples.
- **Agents run in parallel** per ticker; they never see each other's output, so the judge's disagreements are real, not rehearsed.
- **Fixed rounds.** One round of four agents plus one judge call per ticker. Research on multi-agent debate shows most of the value comes from the first exchange; extra rounds add bias faster than signal.
- **Throughput.** vLLM on this card does roughly 150 tokens/sec. 503 S&P 500 names at ~4 agent calls + 1 judge each finishes in about 5 hours — inside a 23:00–09:00 window with room to spare. Ollama's default serial mode would not fit; that is why vLLM is the backend.
- **10GB fit.** Qwen3.5-9B AWQ is ~6GB of weights; 8K context KV cache plus overhead stays under 10GB at 0.85 GPU memory utilization. If the container OOMs, drop `--max-model-len` to 4096.
- **SearXNG is best-effort.** If it's down or slow, the debate still runs on financials + macro alone; news is cached per ticker for 24h so the overnight batch doesn't hammer it.

## Requirements

- Docker + NVIDIA Container Toolkit (for vLLM)
- Node 22+
- Python 3 with `yfinance` (`pip install yfinance`)
- Optional: a FRED API key from https://fred.stlouisfed.org
- Optional: a running SearXNG instance (default http://192.168.86.35:8099)
