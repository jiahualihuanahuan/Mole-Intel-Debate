#!/usr/bin/env bash
# Overnight debate runner. Schedule with cron, e.g.:
#   0 23 * * * /path/to/Mole-Intel-Debate/debate/cron.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Re-apply GPU power limit every run (some drivers reset it on reboot).
# RTX 3080 10GB: 250W is the sweet spot for overnight inference throughput.
if command -v nvidia-smi > /dev/null; then
  nvidia-smi -pl 250 || echo "warning: could not set power limit (need sudo?)"
fi

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
# At ~150 tok/s this takes roughly 40+ hours — run across multiple nights.
# A 23:00-09:00 window fits ~500 names; rotate with --limit if needed.
node debate/engine.mjs --batch "$@"
