#!/usr/bin/env bash
# Overnight debate runner. Schedule with cron, e.g.:
#   0 23 * * * /path/to/Mole-Intel-Debate/debate/cron.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Make sure vLLM is up.
if ! curl -sf "http://localhost:8000/v1/models" > /dev/null; then
  echo "vLLM not reachable at localhost:8000"
  exit 1
fi

export LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:8000/v1}"
export LLM_MODEL="${LLM_MODEL:-qwen3.5-9b}"
export MOLE_DATA="${MOLE_DATA:-$ROOT/data}"
export SEARXNG_URL="${SEARXNG_URL:-http://192.168.86.35:8099}"
# Optional: export FINNHUB_API_KEY=... before running for analyst ratings/targets.

# Full universe: S&P 500 + Nasdaq 100 + Russell 2000 (~2000 names).
# At ~150 tok/s this takes roughly 20-24h — run it across two nights or
# use --limit to cap. A 23:00-09:00 window fits ~500-600 names.
node debate/engine.mjs --batch "$@"
