/**
 * Local AI Token Usage Scanner & Aggregator
 * Authoritative integration with TokenTracker's hourly buckets + real-time live session scanning.
 * Captures historical usage as well as live turns generated today in OMP, Codex, and Claude.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const home = os.homedir();

function formatTokens(tok) {
  const n = Number(tok || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

async function scanTokenTrackerBuckets() {
  const ttBase = path.join(home, ".tokentracker", "tracker", "cursor-store-v2", "generations");
  if (!fs.existsSync(ttBase)) return null;

  try {
    const dirs = fs.readdirSync(ttBase).filter(d => d.startsWith("gen-")).sort();
    if (!dirs.length) return null;
    const latest = path.join(ttBase, dirs[dirs.length - 1]);
    const corePath = path.join(latest, "core.json");
    if (!fs.existsSync(corePath)) return null;

    const mGen = dirs[dirs.length - 1].match(/gen-(\d+)/);
    const lastGenTime = mGen ? Number(mGen[1]) : 0;

    const core = JSON.parse(fs.readFileSync(corePath, "utf8"));
    const buckets = core.hourly?.buckets;
    if (!buckets || typeof buckets !== "object") return null;

    // Load TokenTracker official computeRowCost
    let computeRowCost = null;
    try {
      const pMod = require(path.join(home, ".tokentracker", "tracker", "app", "src", "lib", "pricing"));
      if (typeof pMod.computeRowCost === "function") {
        computeRowCost = pMod.computeRowCost;
        if (typeof pMod.ensurePricingLoaded === "function") {
          await pMod.ensurePricingLoaded();
        }
      }
    } catch (_) {}

    const pricingFile = path.join(home, ".tokentracker", "cache", "pricing.json");
    const pricing = fs.existsSync(pricingFile) ? JSON.parse(fs.readFileSync(pricingFile, "utf8")) : {};

    function fallbackCost(model, inp, out, cache) {
      const m = String(model || "").toLowerCase();
      let p = pricing[m];
      if (!p) {
        for (const [k, v] of Object.entries(pricing)) {
          if (k.toLowerCase() === m || k.toLowerCase().endsWith("/" + m)) { p = v; break; }
        }
      }
      p = p || { input_cost_per_token: 1.5e-6, output_cost_per_token: 5e-6, cache_read_input_token_cost: 0.3e-6 };
      return (inp * (p.input_cost_per_token || 1.5e-6)) +
             (out * (p.output_cost_per_token || 5e-6)) +
             (cache * (p.cache_read_input_token_cost || (p.input_cost_per_token ? p.input_cost_per_token * 0.1 : 0.3e-6)));
    }

    // Clone buckets and scan live sessions modified since lastGenTime or today
    const mergedBuckets = { ...buckets };
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const sinceTime = Math.min(lastGenTime || todayStart, todayStart);

    // Live scan OMP
    const ompDir = path.join(home, ".omp", "agent", "sessions");
    if (fs.existsSync(ompDir)) {
      const walkOmp = (dir) => {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const it of items) {
          const full = path.join(dir, it.name);
          if (it.isDirectory()) walkOmp(full);
          else if (it.name.endsWith(".jsonl")) {
            try {
              const st = fs.statSync(full);
              if (st.mtimeMs >= sinceTime) {
                const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean);
                let model = "google-antigravity/gemini-3.8-flash";
                for (const line of lines) {
                  if (line.includes("model_change")) {
                    try { const mc = JSON.parse(line); if (mc.model) model = mc.model; } catch (_) {}
                  }
                  if (line.includes("usage")) {
                    try {
                      const obj = JSON.parse(line);
                      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
                      if (ts > lastGenTime) {
                        const u = obj.message?.usage || obj.usage;
                        if (u) {
                          const inp = u.input || 0;
                          const out = u.output || 0;
                          const cache = u.cacheRead || 0;
                          const tok = u.totalTokens || (inp + out + cache);
                          const iso = new Date(ts).toISOString();
                          mergedBuckets[`omp|${model}|${iso}`] = {
                            totals: {
                              input_tokens: inp,
                              output_tokens: out,
                              cached_input_tokens: cache,
                              total_tokens: tok
                            }
                          };
                        }
                      }
                    } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }
        }
      };
      walkOmp(ompDir);
    }

    // Live scan Codex
    const codexDirs = [path.join(home, ".codex", "sessions"), path.join(home, ".codex", "archived_sessions")];
    for (const d of codexDirs) {
      if (!fs.existsSync(d)) continue;
      const walkCodex = (dir) => {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const it of items) {
          const full = path.join(dir, it.name);
          if (it.isDirectory()) walkCodex(full);
          else if (it.name.endsWith(".jsonl")) {
            try {
              const st = fs.statSync(full);
              if (st.mtimeMs >= sinceTime) {
                const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean);
                let model = "gpt-5.4";
                let prevCum = 0;
                for (const line of lines) {
                  if (line.includes("turn_context")) {
                    try { const tc = JSON.parse(line); if (tc.payload?.model) model = tc.payload.model; } catch (_) {}
                  }
                  if (line.includes("token_count")) {
                    try {
                      const tc = JSON.parse(line);
                      const ts = tc.timestamp ? new Date(tc.timestamp).getTime() : 0;
                      const u = tc.payload?.info?.total_token_usage;
                      if (u && ts > lastGenTime) {
                        const cum = u.total_tokens || 0;
                        const delta = Math.max(0, cum - prevCum);
                        prevCum = cum;
                        if (delta > 0) {
                          const iso = new Date(ts).toISOString();
                          mergedBuckets[`codex|${model}|${iso}`] = {
                            totals: {
                              input_tokens: u.input_tokens || 0,
                              output_tokens: u.output_tokens || 0,
                              cached_input_tokens: u.cached_input_tokens || 0,
                              total_tokens: delta
                            }
                          };
                        }
                      }
                    } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }
        }
      };
      walkCodex(d);
    }

    const todayStartIso = new Date(todayStart).toISOString();
    const weekStartIso = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).toISOString();
    const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    function aggregateBuckets(startIso) {
      let totalTok = 0, totalCost = 0, totalIn = 0, totalOut = 0, totalCache = 0;
      const pMap = {}, mMap = {};

      for (const [key, b] of Object.entries(mergedBuckets)) {
        const [provider, model, ts] = key.split("|");
        if (!startIso || ts >= startIso) {
          const t = b.totals || {};
          const tok = t.total_tokens || 0;
          const inp = t.input_tokens || 0;
          const out = t.output_tokens || 0;
          const cache = t.cached_input_tokens || 0;

          let cost = 0;
          if (computeRowCost) {
            cost = computeRowCost({ ...t, model, source: provider });
          } else {
            cost = fallbackCost(model, inp, out, cache);
          }

          totalTok += tok;
          totalCost += cost;
          totalIn += inp;
          totalOut += out;
          totalCache += cache;

          const pKey = String(provider || "OTHER").toUpperCase();
          if (!pMap[pKey]) pMap[pKey] = { name: pKey, tokens: 0, cost: 0, models: new Set(), modelsMap: {} };
          pMap[pKey].tokens += tok;
          pMap[pKey].cost += cost;
          pMap[pKey].models.add(model);
          if (!pMap[pKey].modelsMap[model]) pMap[pKey].modelsMap[model] = { tokens: 0, cost: 0 };
          pMap[pKey].modelsMap[model].tokens += tok;
          pMap[pKey].modelsMap[model].cost += cost;

          const mKey = String(model || "unknown");
          if (!mMap[mKey]) mMap[mKey] = { name: mKey, tokens: 0, cost: 0, providers: new Set() };
          mMap[mKey].tokens += tok;
          mMap[mKey].cost += cost;
          mMap[mKey].providers.add(pKey);
        }
      }

      const allModels = Object.values(mMap).map(m => ({
        name: m.name,
        tokens: m.tokens,
        tokensFormatted: formatTokens(m.tokens),
        cost: m.cost,
        costFormatted: "$" + m.cost.toFixed(2),
        percent: totalTok > 0 ? Number(((m.tokens / totalTok) * 100).toFixed(1)) : 0,
        providers: [...m.providers]
      })).sort((a, b) => b.tokens - a.tokens);

      const providers = Object.values(pMap).map(p => {
        const pModels = Object.entries(p.modelsMap).map(([mName, mData]) => ({
          name: mName,
          tokens: mData.tokens,
          tokensFormatted: formatTokens(mData.tokens),
          cost: mData.cost,
          costFormatted: "$" + mData.cost.toFixed(2),
          percent: p.tokens > 0 ? Number(((mData.tokens / p.tokens) * 100).toFixed(1)) : 0
        })).sort((a, b) => b.tokens - a.tokens);

        return {
          name: p.name,
          tokens: p.tokens,
          tokensFormatted: formatTokens(p.tokens),
          cost: p.cost,
          costFormatted: "$" + p.cost.toFixed(2),
          percent: totalTok > 0 ? Number(((p.tokens / totalTok) * 100).toFixed(2)) : 0,
          modelCount: p.models.size,
          models: pModels
        };
      }).sort((a, b) => b.tokens - a.tokens);

      // 全部汇总卡片
      providers.unshift({
        name: "全部",
        isAll: true,
        tokens: totalTok,
        tokensFormatted: formatTokens(totalTok),
        cost: totalCost,
        costFormatted: "$" + totalCost.toFixed(2),
        percent: 100.0,
        modelCount: Object.keys(mMap).length,
        models: allModels
      });

      return {
        totalTokens: totalTok,
        totalTokensFormatted: formatTokens(totalTok),
        totalCost: Number(totalCost.toFixed(2)),
        totalCostFormatted: "$" + totalCost.toFixed(2),
        totalInput: totalIn,
        totalOutput: totalOut,
        totalCache: totalCache,
        totalModels: Object.keys(mMap).length,
        cacheHitRate: (totalIn + totalCache) > 0 ? Number(((totalCache / (totalIn + totalCache)) * 100).toFixed(1)) : 0,
        providers,
        allModels
      };
    }

    const heatmap = {};
    for (const [key, b] of Object.entries(mergedBuckets)) {
      const [provider, model, ts] = key.split("|");
      const dayStr = ts.slice(0, 10);
      if (!heatmap[dayStr]) heatmap[dayStr] = { tokens: 0, cost: 0 };
      const tok = b.totals?.total_tokens || 0;
      const inp = b.totals?.input_tokens || 0;
      const out = b.totals?.output_tokens || 0;
      const cache = b.totals?.cached_input_tokens || 0;
      let cost = 0;
      if (computeRowCost) {
        cost = computeRowCost({ ...b.totals, model, source: provider });
      } else {
        cost = fallbackCost(model, inp, out, cache);
      }
      heatmap[dayStr].tokens += tok;
      heatmap[dayStr].cost += cost;
    }

    return {
      today: aggregateBuckets(todayStartIso),
      week: aggregateBuckets(weekStartIso),
      month: aggregateBuckets(monthStartIso),
      all: aggregateBuckets(null),
      heatmap,
      source: "tokentracker-plus-live",
      fetchedAt: Date.now()
    };
  } catch (err) {
    return null;
  }
}

// ── Fallback Scanner (app.db + native session files) ─────────────────────────
function scanFallback() {
  const PRICING = {
    "gpt-5.6-luna": { in: 1.25, out: 5.0, cache: 0.3 },
    "gpt-5.6-terra": { in: 2.5, out: 10.0, cache: 0.6 },
    "gpt-6-luna": { in: 1.5, out: 6.0, cache: 0.35 },
    "gpt-6-sol": { in: 2.0, out: 8.0, cache: 0.5 },
    "gpt-6.1-sol": { in: 2.0, out: 8.0, cache: 0.5 },
    "gpt-6.1-terra": { in: 3.0, out: 12.0, cache: 0.75 },
    "gpt-5.4": { in: 2.5, out: 10.0, cache: 0.6 },
    "gemini-3.8-flash": { in: 0.075, out: 0.3, cache: 0.02 },
    "google-antigravity/gemini-3.8-flash": { in: 0.075, out: 0.3, cache: 0.02 },
    "deepseek-v4.1-flash": { in: 0.14, out: 0.28, cache: 0.014 },
    "kimi-k3-2": { in: 0.4, out: 0.8, cache: 0.1 },
    "kimi-k3.1-pro": { in: 0.6, out: 1.2, cache: 0.15 },
    "default": { in: 1.0, out: 3.0, cache: 0.25 }
  };

  function calcCost(model, inp, out, cache) {
    const p = PRICING[model] || PRICING.default;
    return ((inp * p.in) + (out * p.out) + (cache * p.cache)) / 1000000;
  }

  const allEntries = [];
  const knownSessions = new Set();
  const appDbPath = path.join(home, ".ccgui-next", "app.db");

  if (fs.existsSync(appDbPath)) {
    try {
      const sqlite = require("node:sqlite");
      const db = new sqlite.DatabaseSync(appDbPath, { readOnly: true });
      const tblList = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('usage_ledger', 'usage_ledger_legacy')").all();
      const targetTable = tblList[0]?.name;
      if (targetTable) {
        const rows = db.prepare(`
          SELECT ts, engine, model, session_id, input_tokens, output_tokens, cache_read, cache_write
          FROM ${targetTable}
        `).all();
        for (const r of rows) {
          if (r.session_id) knownSessions.add(r.session_id);
          const inp = Number(r.input_tokens || 0);
          const out = Number(r.output_tokens || 0);
          const cache = Number(r.cache_read || 0);
          allEntries.push({
            ts: Number(r.ts),
            engine: (r.engine || "other").toLowerCase(),
            model: r.model || "unknown",
            input: inp,
            output: out,
            cache: cache,
            total: inp + out + cache,
            cost: calcCost(r.model, inp, out, cache)
          });
        }
      }
    } catch (_) {}
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - ((now.getDay() + 6) % 7) * 86400000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  function aggregate(entries, startTs = 0) {
    let filtered = startTs > 0 ? entries.filter(e => e.ts >= startTs) : entries;
    let totalTokens = 0, totalCost = 0, totalInput = 0, totalOutput = 0, totalCache = 0;
    const pMap = {}, mMap = {};

    for (const e of filtered) {
      totalTokens += e.total;
      totalCost += e.cost;
      totalInput += e.input;
      totalOutput += e.output;
      totalCache += e.cache;

      const eng = e.engine.toUpperCase();
      if (!pMap[eng]) pMap[eng] = { name: eng, tokens: 0, cost: 0, models: new Set(), modelsMap: {} };
      pMap[eng].tokens += e.total;
      pMap[eng].cost += e.cost;
      pMap[eng].models.add(e.model);
      if (!pMap[eng].modelsMap[e.model]) pMap[eng].modelsMap[e.model] = { tokens: 0, cost: 0 };
      pMap[eng].modelsMap[e.model].tokens += e.total;
      pMap[eng].modelsMap[e.model].cost += e.cost;

      const m = e.model || "unknown";
      if (!mMap[m]) mMap[m] = { name: m, tokens: 0, cost: 0 };
      mMap[m].tokens += e.total;
      mMap[m].cost += e.cost;
    }

    const allModels = Object.values(mMap).map(m => ({
      name: m.name,
      tokens: m.tokens,
      tokensFormatted: formatTokens(m.tokens),
      cost: m.cost,
      costFormatted: "$" + m.cost.toFixed(2),
      percent: totalTokens > 0 ? Number(((m.tokens / totalTokens) * 100).toFixed(1)) : 0
    })).sort((a, b) => b.tokens - a.tokens);

    const providers = Object.values(pMap).map(p => {
      const pModels = Object.entries(p.modelsMap).map(([mName, mData]) => ({
        name: mName,
        tokens: mData.tokens,
        tokensFormatted: formatTokens(mData.tokens),
        cost: mData.cost,
        costFormatted: "$" + mData.cost.toFixed(2),
        percent: p.tokens > 0 ? Number(((mData.tokens / p.tokens) * 100).toFixed(1)) : 0
      })).sort((a, b) => b.tokens - a.tokens);

      return {
        name: p.name,
        tokens: p.tokens,
        tokensFormatted: formatTokens(p.tokens),
        cost: p.cost,
        costFormatted: "$" + p.cost.toFixed(2),
        percent: totalTokens > 0 ? Number(((p.tokens / totalTokens) * 100).toFixed(2)) : 0,
        modelCount: p.models.size,
        models: pModels
      };
    }).sort((a, b) => b.tokens - a.tokens);

    providers.unshift({
      name: "全部",
      isAll: true,
      tokens: totalTokens,
      tokensFormatted: formatTokens(totalTokens),
      cost: totalCost,
      costFormatted: "$" + totalCost.toFixed(2),
      percent: 100.0,
      modelCount: Object.keys(mMap).length,
      models: allModels
    });

    return {
      totalTokens,
      totalTokensFormatted: formatTokens(totalTokens),
      totalCost: Number(totalCost.toFixed(2)),
      totalCostFormatted: "$" + totalCost.toFixed(2),
      totalInput,
      totalOutput,
      totalCache,
      totalModels: Object.keys(mMap).length,
      cacheHitRate: (totalInput + totalCache) > 0 ? Number(((totalCache / (totalInput + totalCache)) * 100).toFixed(1)) : 0,
      providers,
      allModels
    };
  }

  const heatmap = {};
  for (const e of allEntries) {
    const d = new Date(e.ts);
    const pad = (n) => String(n).padStart(2, "0");
    const dayStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (!heatmap[dayStr]) heatmap[dayStr] = { tokens: 0, cost: 0 };
    heatmap[dayStr].tokens += e.total;
    heatmap[dayStr].cost += e.cost;
  }

  return {
    today: aggregate(allEntries, todayStart),
    week: aggregate(allEntries, weekStart),
    month: aggregate(allEntries, monthStart),
    all: aggregate(allEntries, 0),
    heatmap,
    source: "local-appdb-scan",
    fetchedAt: Date.now()
  };
}

async function runScan() {
  const ttResult = await scanTokenTrackerBuckets();
  if (ttResult) return ttResult;
  return scanFallback();
}

if (require.main === module) {
  runScan().then((res) => {
    process.stdout.write(JSON.stringify(res));
  }).catch((err) => {
    process.stdout.write(JSON.stringify({ error: err.message }));
  });
} else {
  module.exports = { runScan };
}
