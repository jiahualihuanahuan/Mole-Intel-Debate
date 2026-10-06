/**
 * Mole-Intel-Debate engine.
 *
 * Four agents (bull, bear, valuation, macro) each produce one JSON note from a
 * shared packet, then a judge synthesizes them and lists unresolved disagreements.
 * The LLM backend is any OpenAI-compatible endpoint — vLLM on this machine
 * (localhost:8000) or Ollama (localhost:11434). Switch with LLM_BASE_URL.
 *
 * Usage:
 *   node debate/engine.mjs <ticker>            # one ticker, print JSON
 *   node debate/engine.mjs --batch             # all S&P 500 names, overnight
 *   node debate/engine.mjs --batch --limit 20  # first 20 only
 *
 * Env:
 *   LLM_BASE_URL   default http://localhost:8000/v1
 *   LLM_MODEL      default qwen3.5-9b
 *   MOLE_DATA      default ./data  (SQLite archive of runs)
 *   FRED_API_KEY   optional; macro agent falls back to public series
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.LLM_BASE_URL || "http://localhost:8000/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || "qwen3.5-9b";
const DATA_DIR = process.env.MOLE_DATA || path.join(__dirname, "..", "data");
const FRED_KEY = process.env.FRED_API_KEY || "";

const AGENTS = {
  bull: {
    role: "Bull analyst",
    system:
      "You are the bull analyst on a four-person investment desk. Argue the case FOR owning this stock. Use only facts in the packet; never invent numbers. Reply with one JSON object and nothing else: {thesis, evidence[<=4 short bullets], catalysts[<=3], confidence 0-1}.",
  },
  bear: {
    role: "Bear analyst",
    system:
      "You are the bear analyst on a four-person investment desk. Argue the case AGAINST owning this stock. Use only facts in the packet; never invent numbers. Reply with one JSON object and nothing else: {thesis, evidence[<=4 short bullets], risks[<=3], confidence 0-1}.",
  },
  valuation: {
    role: "Valuation analyst",
    system:
      "You are the valuation analyst. Compute and interpret the multiples in the packet (P/E, P/B, EV/EBITDA, FCF yield, ROE, margins). Flag anything stretched or cheap versus the sector. Reply with one JSON object and nothing else: {summary, metrics{pe,pb,ev_ebitda,fcf_yield,roe,gross_margin}, verdict, confidence 0-1}. Treat missing fields as unknown, not zero.",
  },
  macro: {
    role: "Macro analyst",
    system:
      "You are the macro analyst. Assess whether the current rate, inflation, and growth backdrop is a tailwind or headwind for this sector. Reply with one JSON object and nothing else: {summary, backdrop{fed_funds,cpi_yoy,unemployment,ten_year}, verdict, confidence 0-1}. Treat missing fields as unknown.",
  },
  judge: {
    role: "Judge",
    system:
      "You are the judge on a four-person investment desk. Read the four agent notes and produce a final call. Do NOT force agreement: list every unresolved disagreement explicitly. Reply with one JSON object and nothing else: {call(bullish|bearish|neutral|mixed), conviction 0-1, summary, bull_points[<=3], bear_points[<=3], disagreements[{topic,bull_view,bear_view}], open_questions[<=3]}.",
  },
};

// ---------- LLM call (OpenAI-compatible: vLLM or Ollama) ----------

async function chat(system, user, { temperature = 0.2, maxTokens = 1800 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${raw.replace(/\s+/g, " ").slice(0, 240)}`)
  const payload = JSON.parse(raw);
  return payload?.choices?.[0]?.message?.content || "";
}

function stripThink(raw) {
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .trim();
}

function extractJson(raw) {
  const text = stripThink(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function ask(agentKey, packet) {
  const { system } = AGENTS[agentKey];
  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(system, JSON.stringify(packet), {
      temperature: 0.2,
      maxTokens: agentKey === "judge" ? 2200 : 1400,
    });
    parsed = extractJson(raw);
    if (parsed) break;
  }
  if (!parsed) {
    return { agent: agentKey, ok: false, error: "model did not return valid JSON" };
  }
  return { agent: agentKey, ok: true, note: parsed };
}

// ---------- Data layer ----------

async function yf(ticker) {
  // yfinance is Python; call it as a one-liner via python3.
  const code = `
import json, yfinance as yf
t = yf.Ticker(${JSON.stringify(ticker)})
info = t.info or {}
keys = ["trailingPE","forwardPE","priceToBook","enterpriseToEbitda","profitMargins","grossMargins","returnOnEquity","freeCashflow","totalRevenue","sector","industry","marketCap","currentPrice","fiftyTwoWeekHigh","fiftyTwoWeekLow"]
out = {k: info.get(k) for k in keys}
try:
    cf = t.cashflow
    if cf is not None and not cf.empty:
        row = cf.iloc[:,0]
        out["operatingCashFlow"] = float(row.get("Operating Cash Flow", float("nan")))
        out["capex"] = float(row.get("Capital Expenditure", float("nan")))
except Exception:
    pass
print(json.dumps(out))
`;
  return await runPython(code);
}

async function runPython(code) {
  return await new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`python failed: ${stderr.slice(0, 300)}`));
      else resolve(stdout.trim());
    });
  });
}

async function fred(seriesId) {
  if (!FRED_KEY) return null;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const j = await res.json();
    const v = j?.observations?.[0]?.value;
    return v && v !== "." ? Number(v) : null;
  } catch {
    return null;
  }
}

async function buildPacket(ticker) {
  const [yfRaw, fed, cpi, unemp, teny] = await Promise.all([
    yf(ticker).catch((e) => JSON.stringify({ error: e.message })),
    fred("FEDFUNDS"),
    fred("CPIAUCSL"),
    fred("UNRATE"),
    fred("GS10"),
  ]);
  let financials = {};
  try {
    financials = JSON.parse(yfRaw);
  } catch {
    financials = { error: "yfinance parse failed", raw: String(yfRaw).slice(0, 200) };
  }
  // FCF yield: freeCashflow / marketCap
  if (financials.freeCashflow && financials.marketCap) {
    financials.fcf_yield = financials.freeCashflow / financials.marketCap;
  }
  return {
    ticker,
    as_of: new Date().toISOString(),
    financials,
    macro: {
      fed_funds: fed,
      cpi_index: cpi,
      unemployment: unemp,
      ten_year_yield: teny,
    },
  };
}

// ---------- Debate ----------

async function debateOne(ticker) {
  const packet = await buildPacket(ticker);
  // Agents run in parallel — they don't see each other.
  const [bull, bear, valuation, macro] = await Promise.all([
    ask("bull", packet),
    ask("bear", packet),
    ask("valuation", packet),
    ask("macro", packet),
  ]);
  const judge = await ask("judge", {
    ticker,
    packet_summary: {
      ticker: packet.ticker,
      financials: packet.financials,
      macro: packet.macro,
    },
    agents: { bull, bear, valuation, macro },
  });
  return {
    ticker,
    as_of: packet.as_of,
    agents: { bull, bear, valuation, macro },
    judge,
  };
}

// ---------- Archive (SQLite via better-sqlite3 if present, else JSONL) ----------

function archive(result) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify(result) + "\n";
  fs.appendFileSync(path.join(DATA_DIR, "debates.jsonl"), line);
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { batch: false, limit: 0, ticker: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--batch") out.batch = true;
    else if (argv[i] === "--limit" && argv[i + 1]) out.limit = Number(argv[i + 1]) || 0;
    else if (!argv[i].startsWith("-")) out.ticker = argv[i];
  }
  return out;
}

async function loadUniverse() {
  // Reuse the S&P 500 list from the parent Mole-Intel repo if present.
  const candidates = [
    path.join(__dirname, "..", "..", "Mole-Intel", "src", "data", "universe.ts"),
    path.join(__dirname, "universe.json"),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const txt = fs.readFileSync(c, "utf8");
    const tickers = [...txt.matchAll(/ticker:\s*"([A-Z.]+)"/g)].map((m) => m[1]);
    if (tickers.length) return [...new Set(tickers)];
  }
  // Fallback: a small built-in list.
  return ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "JPM", "V"];
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.ticker) {
    const result = await debateOne(args.ticker.toUpperCase());
    archive(result);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (args.batch) {
    let universe = await loadUniverse();
    if (args.limit > 0) universe = universe.slice(0, args.limit);
    console.error(`Debate batch: ${universe.length} tickers via ${BASE_URL} model ${MODEL}`);
    let ok = 0;
    let fail = 0;
    for (const t of universe) {
      const started = Date.now();
      try {
        const result = await debateOne(t);
        archive(result);
        ok++;
        console.error(`OK  ${t} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      } catch (e) {
        fail++;
        console.error(`ERR ${t}: ${e.message}`);
      }
    }
    console.error(`Done. ok=${ok} fail=${fail}`);
    return;
  }
  console.error("Usage: node debate/engine.mjs <ticker> | --batch [--limit N]");
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
