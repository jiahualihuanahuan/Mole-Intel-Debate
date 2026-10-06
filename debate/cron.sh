#!/usr/bin/env bash
# Overnight debate runner. Schedule with cron, e.g.:
#   0 23 * * * /path/to/Mole-Intel-Debate/debate/cron.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Make sure vLLM is up (compose file lives one level up in the parent repo layout,
# or alongside this repo). Adjust the path to your docker-compose.vllm.yml.
if ! curl -sf "http://localhost:8000/v1/models" > /dev/null; then
  echo "vLLM not reachable at localhost:8000"
  exit 1
fi

export LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:8000/v1}"
export LLM_MODEL="${LLM_MODEL:-qwen3.5-9b}"
export MOLE_DATA="${MOLE_DATA:-$ROOT/data}"

# Full S&P 500. At ~150 tok/s this finishes in ~5h, well inside an 23:00-09:00 window.
node debate/engine.mjs --batch
