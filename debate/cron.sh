#!/usr/bin/env bash
# Overnight debate runner. Run now with:
#   ./debate/cron.sh --limit 20
# Schedule with cron only if you want it unattended, e.g.:
#   0 23 * * * /path/to/Mole-Intel-Debate/debate/cron.sh --limit 500
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# RTX 3080 10GB: set power limit to 250W for max overnight throughput.
# Persists across reboots on some drivers; re-applying is harmless.
if command -v nvidia-smi > /dev/null; then
  nvidia-smi -pl 250 || echo "warning: could not set GPU power limit (need sudo?)"
fi

# Make sure vLLM is up.
if ! curl -sf "http://localhost:8000/v1/models" > /dev/null; then
  echo "vLLM not reachable at localhost:8000"
  exit 1
fi

export LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:8000/v1}"
export LLM_MODEL="${LLM_MODEL:-qwen2.5-7b}"
export MOLE_DATA="${MOLE_DATA:-$ROOT/data}"
export SEARXNG_URL="${SEARXNG_URL:-http://192.168.86.35:8099}"
# Optional: export FINNHUB_API_KEY=... before running for analyst ratings/targets.

# Full universe: S&P 500 + Nasdaq 100 + Russell 2000 (~2000 names).
# At ~150 tok/s this takes roughly 40+ hours — run across multiple nights.
# A 23:00-09:00 window fits ~500 names; rotate with --limit.
node debate/engine.mjs --batch "$@"
