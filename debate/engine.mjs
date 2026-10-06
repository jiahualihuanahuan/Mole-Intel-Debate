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
 *   LLM_BASE_URL      default http://localhost:8000/v1
 *   LLM_MODEL         default qwen3.5-9b
 *   MOLE_DATA         default ./data  (JSONL archive of runs)
 *   FRED_API_KEY      optional; macro agent falls back to public series
 *   SEARXNG_URL       default http://192.168.86.35:8099
 *   SEARXNG_TIMEOUT   default 15000 (ms)
 *   FINNHUB_API_KEY   optional; analyst ratings + price targets + insider txns
 *   EARNINGS_CALLS    default 3  (how many past earnings-call transcripts to pull)
 *
 * Data sources per ticker:
 *   yfinance  — financials, valuation multiples, 3-month price history
 *   FRED      — macro backdrop (fed funds, CPI, unemployment, 10y)
 *   SearXNG   — recent news headlines (best-effort, 24h cache)
 *   Finnhub   — analyst ratings, price targets, insider transactions (optional)
 *   EarningsWhispers / Motley Fool / Seeking Alpha via SearXNG
 *             — earnings-call transcript snippets (best-effort)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.LLM_BASE_URL || "http://localhost:8000/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || "qwen3.5-9b";
const DATA_DIR = process.env.MOLE_DATA || path.join(__dirname, "..", "data");
const FRED_KEY = process.env.FRED_API_KEY || "";
const SEARXNG_URL = (process.env.SEARXNG_URL || "http://192.168.86.35:8099").replace(/\/$/, "");
const SEARXNG_TIMEOUT = Number(process.env.SEARXNG_TIMEOUT || 15000);
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const EARNINGS_CALLS = Math.max(1, Math.min(6, Number(process.env.EARNINGS_CALLS || 3)));

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
      "You are the valuation analyst. Compute and interpret the multiples in the packet (P/E, P/B, EV/EBITDA, FCF yield, ROE, margins) and the analyst price targets (average, high, low vs current price). Flag anything stretched or cheap. Reply with one JSON object and nothing else: {summary, metrics{pe,pb,ev_ebitda,fcf_yield,roe,gross_margin,avg_price_target,target_vs_price_pct}, verdict, confidence 0-1}. Treat missing fields as unknown, not zero.",
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
  earnings: {
    role: "Earnings-call analyst",
    system:
      "You are the earnings-call analyst. Read the most recent earnings-call transcript (and up to two older ones for trend) in the packet. Focus on: guidance (raised/lowered/maintained), management tone, key Q&A themes, and what changed versus the prior call. The MOST RECENT call is the priority — older calls are context only. Reply with one JSON object and nothing else: {most_recent{date,guidance,tone,key_quotes[<=3],qa_themes[<=3]}, trend_vs_prior, risks_flagged[<=3], confidence 0-1}. If no transcript is available, reply {most_recent:null,trend_vs_prior:null,risks_flagged:[],confidence:0,note:'no transcript found'}.",
  },
  analyst: {
    role: "Analyst-ratings analyst",
    system:
      "You are the analyst-ratings analyst. Read the Finnhub ratings and price-target data in the packet (recent rating changes with firm/action/grade, consensus, average/high/low targets, number of analysts, insider transactions). Assess whether Wall Street is upgrading or downgrading, whether the average target implies upside or downside from the current price, and whether insiders are buying or selling. Reply with one JSON object and nothing else: {summary, consensus, target_implied_upside_pct, recent_changes[<=4], insider_signal, verdict, confidence 0-1}. Treat missing fields as unknown, not zero.",
  },
}

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
  const code = `
import json, yfinance as yf
t = yf.Ticker(${JSON.stringify(ticker)})
info = t.info or {}
keys = ["trailingPE","forwardPE","priceToBook","enterpriseToEbitda","profitMargins","grossMargins","returnOnEquity","freeCashflow","totalRevenue","sector","industry","marketCap","currentPrice","fiftyTwoWeekHigh","fiftyTwoWeekLow","earningsTimestamp","earningsDate","recommendationKey","numberOfAnalystOpinions","targetMeanPrice","targetHighPrice","targetLowPrice"]
out = {k: info.get(k) for k in keys}
try:
    cf = t.cashflow
    if cf is not None and not cf.empty:
        row = cf.iloc[:,0]
        out["operatingCashFlow"] = float(row.get("Operating Cash Flow", float("nan")))
        out["capex"] = float(row.get("Capital Expenditure", float("nan")))
except Exception:
    pass
try:
    hist = t.history(period="3mo")
    if hist is not None and not hist.empty:
        last = hist.iloc[-1]
        prev = hist.iloc[-2] if len(hist) > 1 else last
        out["price_last"] = float(last["Close"])
        out["price_prev_close"] = float(prev["Close"])
        out["price_change_pct_1d"] = float((last["Close"]/prev["Close"]-1)*100)
        if len(hist) >= 22:
            out["return_1m_pct"] = float((last["Close"]/hist.iloc[-22]["Close"]-1)*100)
        if len(hist) >= 63:
            out["return_3m_pct"] = float((last["Close"]/hist.iloc[-63]["Close"]-1)*100)
        out["hist_52w_high"] = float(hist["High"].max())
        out["hist_52w_low"] = float(hist["Low"].min())
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

// ---------- Finnhub: analyst ratings, price targets, insider transactions ----------

async function finnhub(path) {
  if (!FINNHUB_KEY) return null;
  const url = `https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${FINNHUB_KEY}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function finnhubData(ticker) {
  if (!FINNHUB_KEY) return { ratings: null, targets: null, insider: null };
  const [ratings, targets, insider] = await Promise.all([
    finnhub(`/stock/recommendation?symbol=${ticker}`),
    finnhub(`/stock/price-target?symbol=${ticker}`),
    finnhub(`/stock/insider-transactions?symbol=${ticker}`),
  ]);
  // Ratings: list of {buy, hold, sell, strongBuy, strongSell, period, symbol}
  let ratingsSummary = null;
  if (Array.isArray(ratings) && ratings.length) {
    const latest = ratings[0];
    const prev = ratings[1] || null;
    ratingsSummary = {
      latest_period: latest.period,
      strong_buy: latest.strongBuy,
      buy: latest.buy,
      hold: latest.hold,
      sell: latest.sell,
      strong_sell: latest.strongSell,
      trend: prev
        ? {
            strong_buy_delta: latest.strongBuy - prev.strongBuy,
            buy_delta: latest.buy - prev.buy,
            sell_delta: latest.sell - prev.sell,
            strong_sell_delta: latest.strongSell - prev.strongSell,
          }
        : null,
    };
  }
  // Price targets: {targetHigh, targetLow, targetMean, targetMedian, lastUpdated}
  let targetsSummary = null;
  if (targets && typeof targets === "object") {
    targetsSummary = {
      high: targets.targetHigh,
      low: targets.targetLow,
      mean: targets.targetMean,
      median: targets.targetMedian,
      last_updated: targets.lastUpdated,
    };
  }
  // Insider transactions: list of {name, share, change, transactionDate, transactionCode}
  let insiderSummary = null;
  if (Array.isArray(insider) && insider.length) {
    const recent = insider.slice(0, 10);
    let buys = 0;
    let sells = 0;
    for (const tx of recent) {
      const code = String(tx.transactionCode || "");
      // P = open market purchase, S = open market sale
      if (code === "P") buys += 1;
      else if (code === "S") sells += 1;
    }
    insiderSummary = {
      recent_count: recent.length,
      open_market_buys: buys,
      open_market_sells: sells,
      latest: recent.slice(0, 3).map((tx) => ({
        name: tx.name,
        code: tx.transactionCode,
        shares: tx.share,
        date: tx.transactionDate,
      })),
    };
  }
  return { ratings: ratingsSummary, targets: targetsSummary, insider: insiderSummary };
}

// ---------- Earnings-call transcripts via SearXNG ----------

async function earningsTranscripts(ticker) {
  const queries = [
    `${ticker} earnings call transcript Q`,
    `${ticker} earnings call highlights guidance`,
  ];
  const snippets = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json&categories=news`;
      const res = await fetch(url, { signal: AbortSignal.timeout(SEARXNG_TIMEOUT) });
      if (!res.ok) continue;
      const j = await res.json();
      for (const r of j?.results || []) {
        const title = String(r.title || "").trim();
        const content = String(r.content || "").trim();
        const key = title.slice(0, 80);
        if (!title || seen.has(key)) continue;
        seen.add(key);
        snippets.push({
          title: title.slice(0, 300),
          source: String(r.engine || "").slice(0, 120),
          published: r.publishedDate || null,
          excerpt: content.slice(0, 600),
        });
        if (snippets.length >= EARNINGS_CALLS * 2) break;
      }
    } catch {
      // best-effort
    }
    if (snippets.length >= EARNINGS_CALLS * 2) break;
  }
  // Most recent first; keep up to EARNINGS_CALLS.
  return snippets.slice(0, EARNINGS_CALLS);
}

// ---------- SearXNG news search ----------

const NEWS_CACHE = new Map(); // ticker -> { at, headlines }
const NEWS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function searxngNews(ticker) {
  const cached = NEWS_CACHE.get(ticker);
  if (cached && Date.now() - cached.at < NEWS_CACHE_TTL_MS) return cached.headlines;

  const queries = [ `${ticker} stock news`, `${ticker} earnings` ];
  const headlines = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json&categories=news`;
      const res = await fetch(url, { signal: AbortSignal.timeout(SEARXNG_TIMEOUT) });
      if (!res.ok) continue;
      const j = await res.json();
      for (const r of j?.results || []) {
        const title = String(r.title || "").trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        headlines.push({
          title: title.slice(0, 300),
          source: String(r.engine || r.url || "").slice(0, 120),
          published: r.publishedDate || null,
        });
        if (headlines.length >= 10) break;
      }
    } catch {
      // best-effort
    }
    if (headlines.length >= 10) break;
  }
  NEWS_CACHE.set(ticker, { at: Date.now(), headlines });
  return headlines;
}

async function buildPacket(ticker) {
  const [yfRaw, fed, cpi, unemp, teny, news, finnhub, transcripts] = await Promise.all([
    yf(ticker).catch((e) => JSON.stringify({ error: e.message })),
    fred("FEDFUNDS"),
    fred("CPIAUCSL"),
    fred("UNRATE"),
    fred("GS10"),
    searxngNews(ticker).catch(() => []),
    finnhubData(ticker).catch(() => ({ ratings: null, targets: null, insider: null })),
    earningsTranscripts(ticker).catch(() => []),
  ]);
  let financials = {};
  try {
    financials = JSON.parse(yfRaw);
  } catch {
    financials = { error: "yfinance parse failed", raw: String(yfRaw).slice(0, 200) };
  }
  if (financials.freeCashflow && financials.marketCap) {
    financials.fcf_yield = financials.freeCashflow / financials.marketCap;
  }
  // Attach analyst targets relative to current price for the valuation agent.
  if (financials.currentPrice && finnhub.targets?.mean) {
    financials.avg_price_target = finnhub.targets.mean;
    financials.target_vs_price_pct = ((finnhub.targets.mean / financials.currentPrice) - 1) * 100;
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
    news,
    analyst: finnhub,
    earnings_calls: transcripts,
  };
}

// ---------- Debate ----------

async function debateOne(ticker) {
  const packet = await buildPacket(ticker);
  // Agents run in parallel — they don't see each other.
  const [bull, bear, valuation, macro, earnings, analyst] = await Promise.all([
    ask("bull", packet),
    ask("bear", packet),
    ask("valuation", packet),
    ask("macro", packet),
    ask("earnings", packet),
    ask("analyst", packet),
  ]);
  const judge = await ask("judge", {
    ticker,
    packet_summary: {
      ticker: packet.ticker,
      financials: packet.financials,
      macro: packet.macro,
      news_count: (packet.news || []).length,
      earnings_calls_found: (packet.earnings_calls || []).length,
      has_finnhub: !!(packet.analyst.ratings || packet.analyst.targets || packet.analyst.insider),
    },
    agents: { bull, bear, valuation, macro, earnings, analyst },
  });
  return {
    ticker,
    as_of: packet.as_of,
    agents: { bull, bear, valuation, macro, earnings, analyst },
    judge,
  };
}

// ---------- Archive ----------

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
    console.error(`Debate batch: ${universe.length} tickers via ${BASE_URL} model ${MODEL}; SearXNG ${SEARXNG_URL}; Finnhub ${FINNHUB_KEY ? "on" : "off"}; earnings calls ${EARNINGS_CALLS}`);
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
