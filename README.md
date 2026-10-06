# Mole-Intel-Debate

Fork of Mole-Intel with multi-agent bull/bear/valuation/macro debate desk, vLLM backend, overnight S&P 500 batch runs.

## vLLM backend (RTX 3080 10GB)

```bash
docker compose -f docker-compose.vllm.yml up -d
```

- Model: QuantTrio/Qwen3.5-9B-AWQ (AWQ 4-bit, ~6GB weights)
- Context: 8K (fits 10GB with KV cache)
- OpenAI-compatible endpoint: http://localhost:8000/v1
- Served model name: `qwen3.5-9b`

Point the app's LLM base URL at `http://localhost:8000/v1` and set the model to `qwen3.5-9b`.

If the image errors on the qwen3_5 architecture, switch the image tag to `vllm/vllm-openai:nightly`.

## Overnight batch

Schedule the debate runner for 23:00 to 09:00. At ~150 tok/s, 503 S&P 500 names with 4 agents + judge finish in roughly 5 hours.
