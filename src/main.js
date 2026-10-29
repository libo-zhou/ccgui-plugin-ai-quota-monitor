/**
 * AI Quota and Usage Monitor for CC GUI
 * Tier-1 JS Plugin
 */

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useCallback, useMemo } = ctx.react;

  // ── 内部状态与订阅 ──────────────────────────────────────────────────────────
  let cachedData = null;
  let isFetching = false;
  let isFetchingUsage = false;
  let fetchError = null;
  let autoTimer = null;
  let activeEngine = null;
  const subscribers = new Set();

  function notifySubscribers() {
    for (const sub of subscribers) {
      try {
        sub({
          data: cachedData,
          loading: isFetching,
          usageLoading: isFetchingUsage,
          error: fetchError,
          activeEngine,
        });
      } catch (err) {
        console.error("[gemini-quota] subscriber error:", err);
      }
    }
  }

  // ── 格式化工具函数 ──────────────────────────────────────────────────────────
  function formatResetTime(resetsAt) {
    if (!resetsAt) return "--";
    const diff = Number(resetsAt) - Date.now();
    if (diff <= 0) return "即将重置";
    const minutes = Math.floor(diff / (60 * 1000));
    const hours = Math.floor(diff / (3600 * 1000));
    const days = Math.floor(diff / (24 * 3600 * 1000));
    if (days > 0) {
      const remHours = Math.floor((diff % (24 * 3600 * 1000)) / (3600 * 1000));
      return `${days}天${remHours}小时`;
    }
    if (hours > 0) {
      const remMins = Math.floor((diff % (3600 * 1000)) / (60 * 1000));
      return `${hours}小时${remMins}分`;
    }
    return `${Math.max(1, minutes)}分钟`;
  }

  function formatExactDate(resetsAt) {
    if (!resetsAt) return "--";
    const date = new Date(Number(resetsAt));
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }
  function formatTimeAgo(ts) {
    if (!ts) return "未更新";
    const diff = Math.floor((Date.now() - Number(ts)) / 1000);
    if (diff < 5) return "刚刚";
    if (diff < 60) return `${diff}秒前`;
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    return `${Math.floor(diff / 3600)}小时前`;
  }

  function formatRefreshTime(ts) {
    if (!ts) return "未更新";
    const date = new Date(Number(ts));
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function getStatusTone(remaining, warningThreshold) {
    const threshold = typeof warningThreshold === "number" ? warningThreshold : 20;
    if (remaining <= threshold) return "danger";
    if (remaining <= 50) return "warn";
    return "safe";
  }

  function getToneColor(tone) {
    switch (tone) {
      case "danger":
        return "#dc2626";
      case "warn":
        return "#d97706";
      case "safe":
      default:
        return "#16a34a";
    }
  }

  // ── 官方品牌矢量图标 (OpenAI & Google Gemini) ───────────────────────────────
  const GEMINI_PATH =
    "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";

  function GeminiIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }, style),
      },
      h(
        "defs",
        null,
        h(
          "linearGradient",
          { id: "gqc-gemini-g0", x1: "7", y1: "15.5", x2: "11", y2: "12", gradientUnits: "userSpaceOnUse" },
          h("stop", { stopColor: "#08B962" }),
          h("stop", { offset: "1", stopColor: "#08B962", stopOpacity: "0" })
        ),
        h(
          "linearGradient",
          { id: "gqc-gemini-g1", x1: "8", y1: "5.5", x2: "11.5", y2: "11", gradientUnits: "userSpaceOnUse" },
          h("stop", { stopColor: "#F94543" }),
          h("stop", { offset: "1", stopColor: "#F94543", stopOpacity: "0" })
        ),
        h(
          "linearGradient",
          { id: "gqc-gemini-g2", x1: "3.5", y1: "13.5", x2: "17.5", y2: "12", gradientUnits: "userSpaceOnUse" },
          h("stop", { stopColor: "#FABC12" }),
          h("stop", { offset: "0.46", stopColor: "#FABC12", stopOpacity: "0" })
        )
      ),
      h("path", { d: GEMINI_PATH, fill: "#3186FF" }),
      h("path", { d: GEMINI_PATH, fill: "url(#gqc-gemini-g0)" }),
      h("path", { d: GEMINI_PATH, fill: "url(#gqc-gemini-g1)" }),
      h("path", { d: GEMINI_PATH, fill: "url(#gqc-gemini-g2)" })
    );
  }

  function OpenAiIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "currentColor",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }, style),
      },
      h("path", {
        fillRule: "evenodd",
        d: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
      })
    );
  }

  function CodeBuddyIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }, style),
      },
      h(
        "defs",
        null,
        h(
          "radialGradient",
          {
            id: "gqc-codebuddy-g0",
            cx: "0",
            cy: "0",
            r: "1",
            gradientUnits: "userSpaceOnUse",
            gradientTransform: "matrix(-9.00009 -16 16 -9.00009 21 24.5)",
          },
          h("stop", { stopColor: "#2EA99D" }),
          h("stop", { offset: "1", stopColor: "#6C4DFF" })
        )
      ),
      h("path", {
        d: "M18.821 0H5.18A5.179 5.179 0 000 5.179V18.82A5.179 5.179 0 005.179 24H18.82A5.179 5.179 0 0024 18.821V5.18A5.179 5.179 0 0018.821 0z",
        fill: "url(#gqc-codebuddy-g0)",
      }),
      h("path", {
        d: "M18.777 1.647c.28-.02.536.114.972.51 1.018.926 2.437 2.828 3.318 4.452l.34.631.482.24.11.06v3.638a5.206 5.206 0 00-5.32-1.23c-.491.166-1.021.471-2.08 1.082l-6.09 3.516c-1.057.61-1.586.916-1.975 1.259a5.208 5.208 0 00-1.493 5.572c.165.49.471 1.02 1.082 2.08l.315.543h-3.26c-.685 0-1.34-.135-1.939-.377-.169-.956-.009-1.789.469-2.335.158-.18.164-.189.13-.493a11.846 11.846 0 01-.057-1.711l.02-.444-.667-1.18C2.1 15.622 1.445 14.078 1.192 12.9c-.133-.647-.125-.934.04-1.146.1-.128.427-.261.822-.334.994-.175 3.162-.017 5.575.41l.25.043.551-.487c.915-.81 1.522-1.264 2.641-1.962 1.167-.73 2.484-1.331 3.967-1.807l.476-.152.261-.688c.937-2.471 1.896-4.293 2.58-4.9.235-.21.25-.22.422-.23z",
        fill: "#fff",
      }),
      h("path", {
        d: "M12.139 18.2a1.203 1.203 0 011.642.44l1.296 2.243a1.204 1.204 0 01-2.083 1.203l-1.296-2.243a1.203 1.203 0 01.44-1.644zM18.629 14.452a1.203 1.203 0 011.642.44l1.295 2.244a1.203 1.203 0 11-2.083 1.203l-1.295-2.243a1.203 1.203 0 01.44-1.644z",
        fill: "#fff",
      })
    );
  }

  function RefreshIcon({ spinning, size = 13 }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className: spinning ? "gqc-spin" : undefined,
        style: { flexShrink: 0 },
      },
      h("path", { d: "M21 2v6h-6" }),
      h("path", { d: "M3 12a9 9 0 0 1 15-6.7L21 8" }),
      h("path", { d: "M3 22v-6h6" }),
      h("path", { d: "M21 12a9 9 0 0 1-15 6.7L3 16" })
    );
  }

  function CloseIcon({ size = 13 }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        style: { flexShrink: 0 },
      },
      h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }),
      h("line", { x1: 6, y1: 6, x2: 18, y2: 18 })
    );
  }

  function OmpIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2.2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle", color: "#3b82f6" }, style),
      },
      h("polyline", { points: "4 17 10 11 4 5" }),
      h("line", { x1: 12, y1: 19, x2: 20, y2: 19 })
    );
  }

  function ClaudeIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "currentColor",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle", color: "#d97706" }, style),
      },
      h("path", {
        d: "M13.5 2h-3l-.7 4.8-4.2-2.5-1.5 2.6 4.3 2.5-4.3 2.5 1.5 2.6 4.2-2.5.7 4.8h3l.7-4.8 4.2 2.5 1.5-2.6-4.3-2.5 4.3-2.5-1.5-2.6-4.2 2.5-.7-4.8z",
      })
    );
  }

  function ChevronDownIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2.2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        style: Object.assign({ flexShrink: 0 }, style),
      },
      h("polyline", { points: "6 9 12 15 18 9" })
    );
  }

  function StatsIcon({ size = 13, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        style: Object.assign({ flexShrink: 0 }, style),
      },
      h("line", { x1: 18, y1: 20, x2: 18, y2: 10 }),
      h("line", { x1: 12, y1: 20, x2: 12, y2: 4 }),
      h("line", { x1: 6, y1: 20, x2: 6, y2: 14 })
    );
  }

  function QuotaIcon({ size = 13, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        style: Object.assign({ flexShrink: 0 }, style),
      },
      h("path", { d: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" })
    );
  }

  function formatTokensShort(num) {
    const n = Number(num || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }

  function formatCostDisplay(cost) {
    const c = Number(cost || 0);
    if (c >= 100) return "$" + c.toFixed(1);
    if (c >= 1) return "$" + c.toFixed(2);
    if (c > 0) return "$" + c.toFixed(3);
    return "$0.00";
  }

  function getProviderColor(name) {
    const n = String(name || "").toUpperCase();
    if (n === "CODEX" || n === "OPENAI") return "#3b82f6";
    if (n === "OMP" || n === "OH-MY-PI") return "#06b6d4";
    if (n === "CODEBUDDY") return "#8b5cf6";
    if (n === "WORKBUDDY") return "#ec4899";
    if (n === "CLAUDE" || n === "ANTHROPIC") return "#f59e0b";
    if (n === "GEMINI" || n === "AGY") return "#10b981";
    return "#6366f1";
  }

  function renderProviderIcon(name, size = 12) {
    const n = String(name || "").toUpperCase();
    if (n === "全部" || n === "ALL") {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, style: { flexShrink: 0, color: "#e4e4e7" } },
        h("polygon", { points: "12 2 2 7 12 12 22 7 12 2" }),
        h("polyline", { points: "2 17 12 22 22 17" }),
        h("polyline", { points: "2 12 12 17 22 12" })
      );
    }
    if (n === "CODEX" || n === "OPENAI") return h(OpenAiIcon, { size, style: { color: "#3b82f6" } });
    if (n === "OMP" || n === "OH-MY-PI") return h(OmpIcon, { size, style: { color: "#06b6d4" } });
    if (n === "CODEBUDDY") return h(CodeBuddyIcon, { size });
    if (n === "WORKBUDDY") return h(CodeBuddyIcon, { size, style: { filter: "hue-rotate(60deg)" } });
    if (n === "CLAUDE" || n === "ANTHROPIC") return h(ClaudeIcon, { size, style: { color: "#f59e0b" } });
    if (n === "GEMINI" || n === "AGY") return h(GeminiIcon, { size });
    return h("span", { style: { fontWeight: 700, fontSize: "11px", color: "#8b5cf6" } }, "●");
  }

  // ── Gemini (Antigravity) 抓取与解析 ──────────────────────────────────────────
  async function fetchGeminiQuota() {
    try {
      const res = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "omp",
        args: ["usage", "--provider", "google-antigravity", "--json"],
        timeoutMs: 25000,
      });

      if (res.code !== 0) {
        return { error: `omp 退出码 ${res.code}` };
      }

      const json = JSON.parse(res.stdout);
      const reports = json.reports || [];
      const agy = reports.find((r) => r.provider === "google-antigravity") || reports[0];
      if (!agy) return { error: "未找到 Antigravity 报告" };

      const limits = agy.limits || [];
      const meta = agy.metadata || {};

      const gWeekly = limits.find((l) => l.id && l.id.includes("gemini-weekly"));
      const g5h = limits.find((l) => l.id && l.id.includes("gemini-5h"));
      const p3Weekly = limits.find((l) => l.id && l.id.includes("3p-weekly"));
      const p35h = limits.find((l) => l.id && l.id.includes("3p-5h"));

      function parseItem(item) {
        if (!item) return null;
        const amount = item.amount || {};
        const window = item.window || {};
        const remaining = typeof amount.remaining === "number" ? amount.remaining : 100;
        const used = typeof amount.used === "number" ? amount.used : (100 - remaining);
        return {
          remaining: Math.round(remaining * 10) / 10,
          used: Math.round(used * 10) / 10,
          resetsAt: window.resetsAt || null,
        };
      }

      return {
        email: meta.email || "",
        projectId: meta.projectId || "",
        weekly: parseItem(gWeekly),
        h5: parseItem(g5h),
        p3Weekly: parseItem(p3Weekly),
        p35h: parseItem(p35h),
        fetchedAt: agy.fetchedAt || Date.now(),
      };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  // ── Codex (ChatGPT) 抓取与解析 ─────────────────────────────────────────────
  async function fetchCodexQuota() {
    const nodeInlineCode = 'const fs=require("fs"),path=require("path"),os=require("os");try{const p=path.join(os.homedir(),".codex","auth.json");if(!fs.existsSync(p)){console.log(JSON.stringify({error:"not_found"}));process.exit(0);}const auth=JSON.parse(fs.readFileSync(p,"utf8")),token=auth.tokens&&auth.tokens.access_token;if(!token){console.log(JSON.stringify({error:"no_token"}));process.exit(0);}console.log(JSON.stringify({token}));}catch(e){console.log(JSON.stringify({error:e.message}));}';

    try {
      const res = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: ["-e", nodeInlineCode],
        timeoutMs: 25000,
      });

      if (res.code !== 0) {
        return { error: `Node 退出码 ${res.code}` };
      }

      const credentials = JSON.parse(res.stdout);
      if (credentials.error) {
        return { error: credentials.error === "not_found" ? "未登录 Codex" : credentials.error };
      }

      if (typeof credentials.token !== "string" || !credentials.token) {
        return { error: "Codex 登录凭证中没有访问令牌" };
      }

      const response = await ctx.bridge.invoke("plugin_http_request", {
        method: "GET",
        url: "https://chatgpt.com/backend-api/wham/usage",
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "User-Agent": "Codex/1.0.0",
        },
      });
      if (response.status !== 200) {
        return { error: `http_${response.status}` };
      }

      const json = JSON.parse(response.body);

      const rateLimit = json.rate_limit || {};
      const primary = rateLimit.primary_window || {};
      const secondary = rateLimit.secondary_window || {};
      const resetCredits = json.rate_limit_reset_credits || {};

      const h5Used = typeof primary.used_percent === "number" ? primary.used_percent : 0;
      const h5Remaining = Math.max(0, 100 - h5Used);
      let h5ResetsAt = primary.reset_at;
      if (h5ResetsAt && h5ResetsAt < 1e12) h5ResetsAt *= 1000;

      const wUsed = typeof secondary.used_percent === "number" ? secondary.used_percent : 0;
      const wRemaining = Math.max(0, 100 - wUsed);
      let wResetsAt = secondary.reset_at;
      if (wResetsAt && wResetsAt < 1e12) wResetsAt *= 1000;

      return {
        email: json.email || "",
        planType: (json.plan_type || "Codex").toUpperCase(),
        resetCredits: resetCredits.available_count || 0,
        weekly: {
          used: wUsed,
          remaining: wRemaining,
          resetsAt: wResetsAt,
        },
        h5: {
          used: h5Used,
          remaining: h5Remaining,
          resetsAt: h5ResetsAt,
        },
        fetchedAt: Date.now(),
      };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  // ── CodeBuddy (Tencent Copilot) 抓取与解析 ──────────────────────────────────
  async function fetchCodeBuddyQuota() {
    const nodeInlineCode = 'const fs=require("fs"),path=require("path"),os=require("os"),https=require("https");(async function(){try{const dirs=[];if(process.platform==="win32"){const l=process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local");dirs.push(path.join(l,"CodeBuddyExtension","Data","Public","auth"));}else if(process.platform==="darwin"){dirs.push(path.join(os.homedir(),"Library","Application Support","CodeBuddyExtension","Data","Public","auth"));}else{const x=process.env.XDG_DATA_HOME||path.join(os.homedir(),".local","share");dirs.push(path.join(x,"CodeBuddyExtension","Data","Public","auth"));}dirs.push(path.join(os.homedir(),".codebuddy","auth"));const files=[];for(const d of dirs){if(fs.existsSync(d)){try{for(const f of fs.readdirSync(d)){if(f.endsWith(".info")){const fp=path.join(d,f);try{files.push({p:fp,m:fs.statSync(fp).mtimeMs});}catch(_){}}}}catch(_){}}}files.sort((a,b)=>b.m-a.m);let cred=null;for(const it of files){try{const d=JSON.parse(fs.readFileSync(it.p,"utf8"));const token=d.auth&&(typeof d.auth.accessToken==="string"?d.auth.accessToken:d.auth.accessToken&&d.auth.accessToken.token);if(token){const acc=d.account||{};cred={token,uid:acc.uid||"",enterpriseId:acc.enterpriseId||"",enterpriseName:acc.enterpriseName||"",userName:acc.enterpriseUserName||acc.displayName||acc.nickname||"",accountType:acc.type||"",domain:(d.auth&&d.auth.domain)||"www.codebuddy.cn"};break;}}catch(_){}}if(!cred){console.log(JSON.stringify({error:"未检测到 CodeBuddy 登录"}));return;}function requestPost(urlPath,body){return new Promise((resolve,reject)=>{const data=JSON.stringify(body||{});const req=https.request({hostname:"copilot.tencent.com",path:urlPath,method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+cred.token,"X-User-Id":cred.uid,"X-Enterprise-Id":cred.enterpriseId,"X-Tenant-Id":cred.enterpriseId,"X-Domain":cred.domain,"X-Product":"SaaS","X-IDE-Name":"CodeBuddyIDE","User-Agent":"CLI/2.177.0 CodeBuddy/2.177.0"},timeout:15000},res=>{let buf="";res.on("data",c=>buf+=c);res.on("end",()=>{try{resolve({status:res.statusCode,data:JSON.parse(buf)});}catch(e){resolve({status:res.statusCode,raw:buf});}});});req.on("error",reject);req.on("timeout",()=>{req.destroy();reject(new Error("网络请求超时"));});req.write(data);req.end();});}let res=null;if(cred.enterpriseId){try{res=await requestPost("/billing/meter/get-enterprise-user-usage",{});}catch(_){}}const rData=res&&res.data&&res.data.data;if(rData&&typeof rData.credit==="number"){const limit=typeof rData.limitNum==="number"?rData.limitNum:0;const used=Math.round(rData.credit*10)/10;const left=limit===-1?null:Math.max(0,Math.round((limit-used)*10)/10);const remainingPercent=limit>0?Math.max(0,Math.min(100,Math.round((left/limit)*1000)/10)):limit===-1?100:0;const usedPercent=limit>0?Math.max(0,Math.min(100,Math.round((used/limit)*1000)/10)):0;let resetsAt=null;if(rData.cycleResetTime||rData.cycleEndTime){const parsed=Date.parse((rData.cycleResetTime||rData.cycleEndTime).replace(/-/g,"/"));if(!isNaN(parsed)) resetsAt=parsed;}console.log(JSON.stringify({ok:true,enterpriseName:cred.enterpriseName,userName:cred.userName,accountType:cred.accountType,uid:cred.uid,limitNum:limit,used,left,remainingPercent,usedPercent,cycleStartTime:rData.cycleStartTime,cycleEndTime:rData.cycleEndTime,resetsAt,fetchedAt:Date.now()}));return;}const sumRes=await requestPost("/billing/meter/get-user-resource-summary",{});const sData=sumRes&&sumRes.data&&sumRes.data.data;if(sData){console.log(JSON.stringify({ok:true,enterpriseName:cred.enterpriseName,userName:cred.userName,accountType:cred.accountType,uid:cred.uid,limitNum:null,used:0,left:null,remainingPercent:100,usedPercent:0,packages:sData.Packages||[],fetchedAt:Date.now()}));return;}console.log(JSON.stringify({error:res?.data?.msg||"查询 CodeBuddy 额度失败"}));}catch(err){console.log(JSON.stringify({error:err.message||String(err)}));}})();';

    try {
      const res = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: ["-e", nodeInlineCode],
        timeoutMs: 25000,
      });

      if (res.code !== 0) {
        return { error: `Node 退出码 ${res.code}` };
      }

      const parsed = JSON.parse(res.stdout);
      if (parsed.error) {
        return { error: parsed.error };
      }
      return parsed;
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  // ── 本地多源 Token 与消耗统计扫描器 ──────────────────────────────────────────
  async function fetchLocalUsageStats() {
    const runnerCode =
      'const fs=require("fs"),path=require("path"),os=require("os");' +
      'const h=os.homedir();' +
      'const p=[path.join(h,".ccgui-next","plugins","ai-quota-monitor","usage-scanner.cjs"),' +
      'path.join(h,".ccgui-next","plugins","ai-quota-monitor","scripts","usage-scanner.cjs"),' +
      'path.join(h,"ccgui-plugins","ai-quota-monitor","scripts","usage-scanner.cjs")];' +
      'const t=p.find(x=>fs.existsSync(x));' +
      'if(t){const mod=require(t);if(typeof mod.runScan==="function"){Promise.resolve(mod.runScan()).then(res=>process.stdout.write(JSON.stringify(res))).catch(err=>process.stdout.write(JSON.stringify({error:err.message})));}}' +
      'else{process.stdout.write(JSON.stringify({error:"Scanner not found"}));}';

    try {
      const res = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: ["-e", runnerCode],
        timeoutMs: 30000,
      });
      if (res.code !== 0) {
        console.warn("[ai-quota-monitor] usage scan error:", res.stderr);
        return null;
      }
      const parsed = JSON.parse(res.stdout);
      if (parsed && !parsed.error) {
        return parsed;
      }
      return null;
    } catch (e) {
      console.warn("[ai-quota-monitor] usage scan failed:", e);
      return null;
    }
  }

  function preserveQuotaAfterFailure(result, previous) {
    if (result && !result.error) return result;
    if (previous && !previous.error) {
      return {
        ...previous,
        refreshError: result && result.error ? result.error : "查询失败",
      };
    }
    return result || { error: "查询失败" };
  }

  // ── 并行抓取模型配额与用量 ──────────────────────────────────────────────────
  async function fetchQuota(force = false) {
    if (isFetching) return;
    isFetching = true;
    fetchError = null;
    notifySubscribers();

    try {
      const [geminiResult, codexResult, codebuddyResult, usageStatsResult] = await Promise.all([
        fetchGeminiQuota(),
        fetchCodexQuota(),
        fetchCodeBuddyQuota(),
        fetchLocalUsageStats(),
      ]);

      const hasFreshResult =
        (geminiResult && !geminiResult.error) ||
        (codexResult && !codexResult.error) ||
        (codebuddyResult && !codebuddyResult.error) ||
        Boolean(usageStatsResult);
      const merged = {
        fetchedAt: hasFreshResult ? Date.now() : cachedData ? cachedData.fetchedAt : null,
        gemini: preserveQuotaAfterFailure(geminiResult, cachedData && cachedData.gemini),
        codex: preserveQuotaAfterFailure(codexResult, cachedData && cachedData.codex),
        codebuddy: preserveQuotaAfterFailure(codebuddyResult, cachedData && cachedData.codebuddy),
        usageStats: usageStatsResult || (cachedData && cachedData.usageStats) || null,
      };
      cachedData = merged;
      fetchError = null;
      await ctx.storage.set("cached_quota", merged);

      try {
        ctx.events.emit(`plugin:${ctx.pluginId}:updated`, merged);
      } catch (e) {
        console.warn("[gemini-quota] events.emit error:", e);
      }
    } catch (err) {
      console.error("[gemini-quota] 获取配额失败:", err);
      fetchError = err.message || String(err);
    } finally {
      isFetching = false;
      notifySubscribers();
    }
  }

  // ── 单独刷新用量统计 (不调用任何配额接口) ────────────────────────────────────
  async function fetchUsageOnly() {
    if (isFetchingUsage) return;
    isFetchingUsage = true;
    notifySubscribers();

    try {
      const usageStatsResult = await fetchLocalUsageStats();
      if (usageStatsResult && !usageStatsResult.error) {
        cachedData = {
          ...(cachedData || {}),
          usageStats: usageStatsResult,
        };
        await ctx.storage.set("cached_quota", cachedData);
      }
    } catch (err) {
      console.warn("[ai-quota-monitor] fetchUsageOnly failed:", err);
    } finally {
      isFetchingUsage = false;
      notifySubscribers();
    }
  }

  // ── 自定义 Hook 订阅状态 ────────────────────────────────────────────────────
  function useQuotaState() {
    const [state, setState] = useState(() => ({
      data: cachedData,
      loading: isFetching,
      usageLoading: isFetchingUsage,
      error: fetchError,
      activeEngine,
    }));

    useEffect(() => {
      subscribers.add(setState);
      return () => {
        subscribers.delete(setState);
      };
    }, []);

    return state;
  }

  // ── 单模型指标卡片渲染辅助 ──────────────────────────────────────────────────
  function renderModelCards(title, BrandIcon, modelData, config) {
    if (!modelData || modelData.error) {
      return h(
        "div",
        {
          className: "gqc-popover-card",
          style: {
            minHeight: "220px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            textAlign: "center",
            gap: "8px",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 } },
          h(BrandIcon, { size: 16 }),
          h("span", null, title)
        ),
        h(
          "div",
          { style: { color: "var(--color-text-tertiary, #a1a1aa)", fontSize: "11px", maxWidth: "260px" } },
          modelData && modelData.error ? modelData.error : "暂无配额数据"
        )
      );
    }

    const weekly = modelData.weekly;
    const h5 = modelData.h5;

    const weeklyTone = weekly ? getStatusTone(weekly.remaining, config && config.warningThreshold) : "safe";
    const weeklyColor = getToneColor(weeklyTone);

    const h5Tone = h5 ? getStatusTone(h5.remaining, config && config.warningThreshold) : "safe";
    const h5Color = getToneColor(h5Tone);

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "8px" } },
      // 头部账号
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "11px",
            color: "var(--color-text-secondary, #71717a)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "5px" } },
          h(BrandIcon, { size: 14 }),
          h("span", { style: { fontWeight: 600, color: "var(--color-text-primary, #18181b)" } }, title),
          modelData.planType
            ? h(
                "span",
                {
                  style: {
                    padding: "1px 4px",
                    borderRadius: "3px",
                    fontSize: "9.5px",
                    fontWeight: 600,
                    background: "rgba(16, 185, 129, 0.12)",
                    color: "#059669",
                  },
                },
                modelData.planType
              )
            : title.includes("Gemini")
              ? h(
                  "span",
                  {
                    style: {
                      padding: "1px 4px",
                      borderRadius: "3px",
                      fontSize: "9.5px",
                      fontWeight: 600,
                      background: "rgba(2, 132, 199, 0.12)",
                      color: "#0284c7",
                    },
                  },
                  "Antigravity"
                )
              : null
        ),
        h(
          "span",
          {
            style: {
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "160px",
            },
          },
          modelData.email || ""
        )
      ),
      modelData.refreshError
        ? h(
            "div",
            {
              title: modelData.refreshError,
              style: {
                color: "#b45309",
                fontSize: "10px",
                lineHeight: "1.3",
                marginTop: "-4px",
              },
            },
            "刷新失败，当前显示上次成功的额度"
          )
        : null,
      // 7D 周限卡片
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "每周总限额 (7D)"
          ),
          h(
            "span",
            { style: { fontSize: "17px", fontWeight: 700, color: weeklyColor } },
            weekly ? `${weekly.remaining}%` : "--"
          )
        ),
        h(
          "div",
          { className: "gqc-progress-track" },
          h("div", {
            className: "gqc-progress-bar",
            style: {
              width: `${weekly ? Math.max(0, Math.min(100, weekly.remaining)) : 0}%`,
              backgroundColor: weeklyColor,
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "4px 8px",
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
            },
          },
          h("div", null, "已用: ", h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, weekly ? `${weekly.used}%` : "--")),
          h("div", null, "周期: 7 天"),
          h(
            "div",
            { style: { gridColumn: "1 / -1" } },
            "重置倒计时: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, weekly ? formatResetTime(weekly.resetsAt) : "--"),
            weekly && weekly.resetsAt ? ` (${formatExactDate(weekly.resetsAt)})` : ""
          )
        )
      ),

      // 5H 短周期限额卡片
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "5 小时短周期 (5H)"
          ),
          h(
            "span",
            { style: { fontSize: "16px", fontWeight: 700, color: h5Color } },
            h5 ? `${h5.remaining}%` : "--"
          )
        ),
        h(
          "div",
          { className: "gqc-progress-track" },
          h("div", {
            className: "gqc-progress-bar",
            style: {
              width: `${h5 ? Math.max(0, Math.min(100, h5.remaining)) : 0}%`,
              backgroundColor: h5Color,
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "space-between",
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
            },
          },
          h("span", null, "已用: ", h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, h5 ? `${h5.used}%` : "--")),
          h(
            "span",
            null,
            "重置倒计时: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, h5 ? formatResetTime(h5.resetsAt) : "--")
          )
        )
      ),

      // 额度券或扩展能力辅助提示条 (统一各看板高度与结构节奏)
      modelData.resetCredits !== undefined
        ? h(
            "div",
            { className: "gqc-aux-strip is-codex" },
            h("span", { className: "gqc-aux-label" }, "🎟️ 月度额度重置券:"),
            h("b", null, `${modelData.resetCredits} 次可用`)
          )
        : modelData.p3Weekly
          ? h(
              "div",
              { className: "gqc-aux-strip is-gemini" },
              h("span", { className: "gqc-aux-label" }, "🤖 第三方模型周限 (Claude/GPT):"),
              h("b", null, `${modelData.p3Weekly.remaining}% 可用`)
            )
          : modelData.projectId
            ? h(
                "div",
                { className: "gqc-aux-strip is-gemini" },
                h("span", { className: "gqc-aux-label" }, "🏢 关联云项目 (Project):"),
                h("b", null, modelData.projectId)
              )
            : h(
                "div",
                { className: "gqc-aux-strip is-default" },
                h("span", { className: "gqc-aux-label" }, "⚡ 配额调度机制:"),
                h("b", null, "5H 平滑突发 · 7D 周限保护")
              )
    );
  }

  // ── CodeBuddy 账号积分指标卡片渲染辅助 ─────────────────────────────────────
  function renderCodeBuddyCards(title, BrandIcon, modelData, config) {
    if (!modelData || modelData.error) {
      return h(
        "div",
        {
          className: "gqc-popover-card",
          style: {
            minHeight: "220px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            textAlign: "center",
            gap: "8px",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 } },
          h(BrandIcon, { size: 16 }),
          h("span", null, title)
        ),
        h(
          "div",
          { style: { color: "var(--color-text-tertiary, #a1a1aa)", fontSize: "11px", maxWidth: "260px" } },
          modelData && modelData.error ? modelData.error : "暂无 CodeBuddy 积分数据"
        )
      );
    }

    const isUnlimited = modelData.limitNum === -1;
    const tone = isUnlimited ? "safe" : getStatusTone(modelData.remainingPercent, config && config.warningThreshold);
    const color = getToneColor(tone);

    function formatNumber(num) {
      if (typeof num !== "number") return "--";
      return num.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
    }

    let typeLabel = "CodeBuddy";
    if (modelData.accountType) {
      const t = String(modelData.accountType).toLowerCase();
      if (t === "ultimate") typeLabel = "旗舰版";
      else if (t === "pro") typeLabel = "专业版";
      else if (t === "personal") typeLabel = "个人版";
      else typeLabel = modelData.accountType;
    }

    const accountSubtitle = [
      modelData.userName,
      modelData.enterpriseName,
    ].filter(Boolean).join(" · ");

    let cycleProgressPct = 0;
    if (modelData.cycleStartTime && modelData.cycleEndTime) {
      try {
        const s = new Date(modelData.cycleStartTime.replace(/-/g, "/")).getTime();
        const e = new Date(modelData.cycleEndTime.replace(/-/g, "/")).getTime();
        const n = Date.now();
        if (e > s) {
          cycleProgressPct = Math.max(0, Math.min(100, Math.round(((n - s) / (e - s)) * 100)));
        }
      } catch (_) {}
    }

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "8px" } },
      // 头部账号
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "11px",
            color: "var(--color-text-secondary, #71717a)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "5px" } },
          h(BrandIcon, { size: 14 }),
          h("span", { style: { fontWeight: 600, color: "var(--color-text-primary, #18181b)" } }, title),
          h(
            "span",
            {
              style: {
                padding: "1px 5px",
                borderRadius: "3px",
                fontSize: "9.5px",
                fontWeight: 600,
                background: "rgba(46, 169, 157, 0.12)",
                color: "#2ea99d",
              },
            },
            typeLabel
          )
        ),
        h(
          "span",
          {
            style: {
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "180px",
            },
          },
          accountSubtitle || modelData.uid || ""
        )
      ),
      modelData.refreshError
        ? h(
            "div",
            {
              title: modelData.refreshError,
              style: {
                color: "#b45309",
                fontSize: "10px",
                lineHeight: "1.3",
                marginTop: "-4px",
              },
            },
            "刷新失败，当前显示上次成功的额度"
          )
        : null,

      // 1. 月度可用积分卡片 (结构与每周总限额卡片严格对齐)
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "本月可用积分 (Monthly)"
          ),
          h(
            "span",
            { style: { fontSize: "17px", fontWeight: 700, color } },
            isUnlimited ? "不限额" : `${modelData.remainingPercent}%`
          )
        ),
        h(
          "div",
          { className: "gqc-progress-track" },
          h("div", {
            className: "gqc-progress-bar",
            style: {
              width: `${isUnlimited ? 100 : Math.max(0, Math.min(100, modelData.remainingPercent))}%`,
              backgroundColor: color,
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "4px 8px",
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
            },
          },
          h(
            "div",
            null,
            "剩余: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, isUnlimited ? "无限制" : `${formatNumber(modelData.left)} 积分`)
          ),
          h(
            "div",
            null,
            "已用: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, `${formatNumber(modelData.used)} 积分`)
          ),
          h(
            "div",
            null,
            "总额: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, isUnlimited ? "无限制" : `${formatNumber(modelData.limitNum)} 积分`)
          ),
          h(
            "div",
            null,
            "已用占比: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, `${modelData.usedPercent}%`)
          )
        )
      ),

      // 2. 结算周期与重置卡片 (结构与 5H 短周期卡片严格对齐)
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "结算周期与重置 (Cycle)"
          ),
          h(
            "span",
            { style: { fontSize: "13px", fontWeight: 700, color: "#2ea99d" } },
            modelData.resetsAt ? formatResetTime(modelData.resetsAt) : "月度结算"
          )
        ),
        h(
          "div",
          { className: "gqc-progress-track" },
          h("div", {
            className: "gqc-progress-bar",
            style: {
              width: `${cycleProgressPct || 100}%`,
              backgroundColor: "#2ea99d",
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "space-between",
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
            },
          },
          h(
            "span",
            null,
            "周期: ",
            h(
              "b",
              { style: { color: "var(--color-text-primary, #18181b)" } },
              modelData.cycleStartTime && modelData.cycleEndTime
                ? `${modelData.cycleStartTime.slice(5, 10)} ~ ${modelData.cycleEndTime.slice(5, 10)}`
                : "自然月"
            )
          ),
          h(
            "span",
            null,
            "重置时间: ",
            h(
              "b",
              { style: { color: "var(--color-text-primary, #18181b)" } },
              modelData.resetsAt ? formatExactDate(modelData.resetsAt) : "--"
            )
          )
        )
      ),

      // 3. 账号权益状态条 (结构与月度重置券条严格对齐)
      h(
        "div",
        { className: "gqc-aux-strip is-codebuddy" },
        h("span", { className: "gqc-aux-label" }, "🎫 账号权益:"),
        h("b", null, `${typeLabel} · 专享高并发与优先通道`)
      )
    );
  }

  // ── GitHub 风格日历用量热力图组件 ──────────────────────────────────────────
  function renderCalendarHeatmap(heatmapData) {
    const rawData = heatmapData || {};
    const now = new Date();
    const numWeeks = 24; // 近 6 个月 (24 周)
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - (numWeeks * 7) - now.getDay());

    const weeks = [];
    let currWeek = [];
    let activeDaysCount = 0;
    let maxTokens = 0;

    for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) {
      const dayOfWeek = d.getDay();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const dateStr = `${y}-${m}-${day}`;
      const entry = rawData[dateStr];
      const tok = entry ? Number(entry.tokens || 0) : 0;
      const cost = entry ? Number(entry.cost || 0) : 0;
      if (tok > 0) activeDaysCount++;
      if (tok > maxTokens) maxTokens = tok;
      currWeek.push({
        dateStr,
        dayOfWeek,
        month: d.getMonth() + 1,
        dayNum: d.getDate(),
        tok,
        cost,
      });
      if (dayOfWeek === 6 || d.getTime() >= now.getTime()) {
        weeks.push(currWeek);
        currWeek = [];
      }
    }
    if (currWeek.length > 0) weeks.push(currWeek);

    function getLevel(tok) {
      if (!tok || tok === 0) return 0;
      if (tok < 10e6) return 1;
      if (tok < 50e6) return 2;
      if (tok < 150e6) return 3;
      return 4;
    }

    // 构建月份标尺
    const monthLabels = [];
    let lastMonth = null;
    for (let w = 0; w < weeks.length; w++) {
      const firstDay = weeks[w][0];
      if (firstDay && firstDay.month !== lastMonth && firstDay.dayNum <= 7) {
        monthLabels.push(
          h(
            "span",
            {
              key: `m-${w}`,
              style: { position: "absolute", left: `${w * 11.5 + 18}px` },
            },
            `${firstDay.month}月`
          )
        );
        lastMonth = firstDay.month;
      }
    }

    // 构建 24 周列
    const columns = weeks.map((week, wIdx) => {
      const cells = [];
      for (let r = 0; r < 7; r++) {
        const day = week.find((d) => d.dayOfWeek === r);
        if (!day) {
          cells.push(h("div", { key: `empty-${r}`, style: { width: "9.5px", height: "9.5px" } }));
        } else {
          const lvl = getLevel(day.tok);
          const tooltip = day.tok > 0
            ? `${day.dateStr}: ${formatTokensShort(day.tok)} Token (${formatCostDisplay(day.cost)})`
            : `${day.dateStr}: 无记录`;
          cells.push(
            h("div", {
              key: day.dateStr,
              className: `gqc-heat-cell lvl-${lvl}`,
              title: tooltip,
            })
          );
        }
      }
      return h("div", { key: `col-${wIdx}`, className: "gqc-heat-col" }, cells);
    });

    return h(
      "div",
      { className: "gqc-heat-wrap" },
      h(
        "div",
        { className: "gqc-heat-header" },
        h(
          "div",
          { className: "gqc-heat-title" },
          h("span", { style: { fontSize: "11px" } }, "📅"),
          h("span", null, "用量热力图")
        ),
        h("div", { className: "gqc-heat-sub" }, `近半年活跃 ${activeDaysCount} 天`)
      ),
      h(
        "div",
        { className: "gqc-heat-scroll" },
        h(
          "div",
          { className: "gqc-heat-grid-container" },
          h("div", { className: "gqc-heat-months-row" }, monthLabels),
          h(
            "div",
            { className: "gqc-heat-body-row" },
            h(
              "div",
              { className: "gqc-heat-day-labels" },
              h("span", null, "日"),
              h("span", null, "一"),
              h("span", null, "二"),
              h("span", null, "三"),
              h("span", null, "四"),
              h("span", null, "五"),
              h("span", null, "六")
            ),
            h("div", { className: "gqc-heat-weeks-flow" }, columns)
          )
        )
      ),
      h(
        "div",
        { className: "gqc-heat-legend-row" },
        h("span", null, "少"),
        h("div", { className: "gqc-heat-legend-cell lvl-0" }),
        h("div", { className: "gqc-heat-legend-cell lvl-1" }),
        h("div", { className: "gqc-heat-legend-cell lvl-2" }),
        h("div", { className: "gqc-heat-legend-cell lvl-3" }),
        h("div", { className: "gqc-heat-legend-cell lvl-4" }),
        h("span", null, "多")
      )
    );
  }

  // ── 本地全场景 Token 与成本使用统计视图 ───────────────────────────────────
  // ── 本地全场景 Token 与成本使用统计视图 (与 Image 1 深度对齐) ──────────────────
  function renderUsageStatsView(
    usageStats,
    loading,
    usageLoading,
    config,
    usageRange,
    setUsageRange,
    onRefreshUsage,
    selectedProvider,
    setSelectedProvider
  ) {
    if (!usageStats) {
      return h(
        "div",
        {
          style: {
            padding: "36px 16px",
            textAlign: "center",
            color: "var(--color-text-secondary, #71717a)",
            fontSize: "12px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "10px",
          },
        },
        loading
          ? [h(RefreshIcon, { spinning: true, size: 18 }), "正在扫描 Token 消耗..."]
          : "暂未发现本地会话用量数据，点击右上角刷新"
      );
    }

    const currentRangeData = usageStats[usageRange] || usageStats.today || {
      totalTokens: 0,
      totalTokensFormatted: "0",
      totalCost: 0,
      totalCostFormatted: "$0.00",
      totalModels: 0,
      providers: [],
      allModels: [],
    };

    const activeProvider =
      (currentRangeData.providers && currentRangeData.providers.find((p) => p.name === selectedProvider)) ||
      (currentRangeData.providers && currentRangeData.providers[0]) || { name: "全部", isAll: true, models: currentRangeData.allModels };

    const isFiltered = activeProvider && !activeProvider.isAll;
    const displayModels = (activeProvider && activeProvider.models && activeProvider.models.length > 0)
      ? activeProvider.models
      : currentRangeData.allModels;

    const onCardClick = (pName) => {
      if (setSelectedProvider) {
        setSelectedProvider((prev) => (prev === pName && pName !== "全部" ? "全部" : pName));
      }
    };

    const rangeLabels = [
      { id: "today", label: "日" },
      { id: "week", label: "周" },
      { id: "month", label: "月" },
      { id: "all", label: "总计" },
    ];

    return h(
      "div",
      { className: "gqc-stat-container" },

      // 时间筛选胶囊 + 右侧独立刷新按钮
      h(
        "div",
        { className: "gqc-stat-filter-bar" },
        h(
          "div",
          { className: "gqc-stat-pills" },
          rangeLabels.map(({ id, label }) =>
            h(
              "button",
              {
                key: id,
                type: "button",
                className: `gqc-stat-pill-btn${usageRange === id ? " is-active" : ""}`,
                onClick: () => setUsageRange(id),
              },
              label
            )
          )
        ),
        h(
          "button",
          {
            type: "button",
            className: "gqc-stat-refresh-btn",
            title: "仅刷新用量统计 (不刷新配额)",
            disabled: usageLoading,
            onClick: onRefreshUsage,
          },
          h(RefreshIcon, { spinning: usageLoading, size: 12 })
        )
      ),

      // 居中大指标展示 (TOKEN 总数, 106.4M / 1.7B, $13.51 / $251.50)
      h(
        "div",
        { className: "gqc-stat-hero" },
        h("span", { className: "gqc-stat-hero-label" }, usageRange === "today" ? "TOKEN 总数 (今日)" : "TOKEN 消耗总数"),
        h("span", { className: "gqc-stat-hero-number" }, currentRangeData.totalTokensFormatted || "0"),
        h("span", { className: "gqc-stat-hero-cost" }, currentRangeData.totalCostFormatted || "$0.00"),
        currentRangeData.totalTokens === 0
          ? h("span", { style: { fontSize: "10.5px", color: "var(--color-text-secondary, #52525b)", marginTop: "4px" } }, "今日暂无消耗 · 点击「周」或「月」查看用量")
          : null
      ),

      // 多色分段进度条
      currentRangeData.providers && currentRangeData.providers.length > 1
        ? h(
            "div",
            { className: "gqc-stat-seg-bar" },
            currentRangeData.providers
              .filter((p) => !p.isAll)
              .map((p) =>
                h("div", {
                  key: p.name,
                  className: "gqc-stat-seg-part",
                  style: {
                    width: `${Math.max(1, p.percent)}%`,
                    backgroundColor: getProviderColor(p.name),
                  },
                  title: `${p.name}: ${p.percent}% (${p.tokensFormatted})`,
                })
              )
          )
        : null,

      // 供应商 2 列卡片网格 (支持点击筛选)
      h(
        "div",
        { className: "gqc-stat-grid" },
        currentRangeData.providers.map((p) => {
          const isSelected = selectedProvider === p.name || (p.isAll && (!selectedProvider || selectedProvider === "全部"));
          return h(
            "div",
            {
              key: p.name,
              className: `gqc-stat-provider-card${isSelected ? " is-selected" : ""}`,
              onClick: () => onCardClick(p.name),
              title: isSelected ? "点击取消筛选，展示全部模型" : `点击筛选查看 ${p.name} 模型用量`,
            },
            h(
              "div",
              { className: "gqc-stat-provider-head" },
              h(
                "div",
                { className: "gqc-stat-provider-title" },
                renderProviderIcon(p.name, 11),
                p.name
              ),
              h("div", { className: "gqc-stat-provider-models" }, `${p.modelCount} 模型`)
            ),
            h("div", { className: "gqc-stat-provider-pct" }, `${p.percent.toFixed(2)}%`),
            h("div", { className: "gqc-stat-provider-meta" }, p.tokens > 0 ? `${p.tokensFormatted} · ${p.costFormatted}` : "0 Token · $0.00")
          );
        })
      ),

      // 模型用量排行榜 (跟随卡片点击动态过滤)
      displayModels && displayModels.length > 0
        ? h(
            "div",
            { className: "gqc-stat-all-models-wrap" },
            h(
              "div",
              {
                className: "gqc-stat-all-models-title-row",
                style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
              },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "5px" } },
                renderProviderIcon(isFiltered ? activeProvider.name : "全部", 12),
                isFiltered
                  ? `${activeProvider.name} 模型用量 (${activeProvider.modelCount} 模型)`
                  : "全部模型"
              ),
              isFiltered
                ? h(
                    "button",
                    {
                      type: "button",
                      style: {
                        background: "transparent",
                        border: "none",
                        color: "#2563eb",
                        fontSize: "10.5px",
                        cursor: "pointer",
                        fontWeight: 600,
                        padding: "0 2px",
                      },
                      onClick: () => setSelectedProvider && setSelectedProvider("全部"),
                    },
                    "显示全部 ✕"
                  )
                : null
            ),
            h(
              "div",
              { className: "gqc-stat-all-models-sub" },
              isFiltered
                ? `仅展示 ${activeProvider.name} 产生的消耗 · 点击卡片取消筛选`
                : "同名模型会跨工具合并，并按总用量排序。"
            ),
            h(
              "div",
              { className: "gqc-stat-all-models-list" },
              displayModels.slice(0, 15).map((m) =>
                h(
                  "div",
                  { key: m.name, className: "gqc-stat-all-model-row" },
                  h(
                    "div",
                    { className: "gqc-stat-all-model-info" },
                    h("span", { className: "gqc-stat-all-model-name", title: m.name }, m.name),
                    h(
                      "div",
                      { className: "gqc-stat-all-model-bar-track" },
                      h("div", {
                        className: "gqc-stat-all-model-bar-fill",
                        style: { width: `${Math.min(100, Math.max(3, m.percent))}%` },
                      })
                    )
                  ),
                  h(
                    "div",
                    { className: "gqc-stat-all-model-nums" },
                    h("span", { className: "gqc-stat-all-model-tokens" }, m.tokensFormatted),
                    h("span", { className: "gqc-stat-all-model-cost" }, m.costFormatted),
                    h("span", { className: "gqc-stat-all-model-pct" }, `${m.percent}%`)
                  )
                )
              )
            )
          )
        : null,

      // 日历活跃热力图 (GitHub 风格，在全部模型列表下方)
      renderCalendarHeatmap(usageStats.heatmap)
    );
  }
  // ── 弹出详情弹框组件 (单模型看板 Popover Modal) ───────────────────────────
  function QuotaPopover({ data, loading, usageLoading, error, activeEngine, onClose }) {
    function resolveInitialTab(engine) {
      if (engine === "codebuddy") return "codebuddy";
      if (engine === "codex") return "codex";
      if (engine === "omp" || engine === "agy" || engine === "gemini") return "gemini";
      if (data && data.codebuddy && !data.codebuddy.error) return "codebuddy";
      if (data && data.gemini && !data.gemini.error) return "gemini";
      if (data && data.codex && !data.codex.error) return "codex";
      return "gemini";
    }

    const [viewMode, setViewMode] = useState("quota"); // "quota" | "usage"
    const [activeTab, setActiveTab] = useState(() => resolveInitialTab(activeEngine));
    const [usageRange, setUsageRange] = useState("today"); // 默认展示日的
    const [selectedProvider, setSelectedProvider] = useState("全部");
    const [config, setConfig] = useState({});
    useEffect(() => {
      setActiveTab(resolveInitialTab(activeEngine));
    }, [activeEngine]);

    useEffect(() => {
      ctx.storage.get("config").then((c) => setConfig(c || {}));
    }, []);

    useEffect(() => {
      const handleKey = (e) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", handleKey);
      return () => window.removeEventListener("keydown", handleKey);
    }, [onClose]);

    const gemini = data && data.gemini;
    const codex = data && data.codex;
    const codebuddy = data && data.codebuddy;

    return h(
      "div",
      null,
      // 透明遮罩
      h("div", {
        className: "gqc-popover-backdrop",
        onClick: (e) => {
          e.stopPropagation();
          onClose();
        },
      }),
      // 弹框卡片
      h(
        "div",
        {
          className: `gqc-popover ${viewMode === "quota" ? "is-quota" : "is-usage"}`,
          onClick: (e) => e.stopPropagation(),
        },
        // 顶部操作栏
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottom: "1px solid var(--color-separator-border, rgba(128, 128, 128, 0.15))",
              paddingBottom: "8px",
            },
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px" } },
            viewMode === "usage"
              ? h(StatsIcon, { size: 14, style: { color: "#16a34a" } })
              : activeTab === "codebuddy"
                ? h(CodeBuddyIcon, { size: 14 })
                : activeTab === "codex"
                  ? h(OpenAiIcon, { size: 14, style: { color: "var(--color-text-primary, #18181b)" } })
                  : h(GeminiIcon, { size: 14 }),
            h(
              "span",
              { style: { fontWeight: 600, fontSize: "13px", color: "var(--color-text-primary, #18181b)" } },
              viewMode === "usage"
                ? "AI 使用与成本统计"
                : activeTab === "codebuddy"
                  ? "CodeBuddy 积分看板"
                  : activeTab === "codex"
                    ? "Codex 配额看板"
                    : "Gemini 配额看板"
            )
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px" } },
            h(
              "div",
              { className: "gqc-header-switcher" },
              h(
                "button",
                {
                  type: "button",
                  className: `gqc-header-switch-btn${viewMode === "quota" ? " is-active" : ""}`,
                  onClick: () => setViewMode("quota"),
                },
                "配额"
              ),
              h(
                "button",
                {
                  type: "button",
                  className: `gqc-header-switch-btn${viewMode === "usage" ? " is-active" : ""}`,
                  onClick: () => setViewMode("usage"),
                },
                "用量"
              )
            ),
            h(
              "button",
              {
                type: "button",
                className: "gqc-icon-button",
                title: viewMode === "usage" ? "仅刷新用量统计 (不刷新配额)" : "立即刷新全部配额与Token用量",
                disabled: viewMode === "usage" ? usageLoading : loading,
                onClick: () => {
                  if (viewMode === "usage") {
                    void fetchUsageOnly();
                  } else {
                    void fetchQuota(true);
                  }
                },
              },
              h(RefreshIcon, { spinning: viewMode === "usage" ? usageLoading : loading, size: 13 })
            ),
            h(
              "button",
              {
                type: "button",
                className: "gqc-icon-button",
                title: "关闭",
                onClick: onClose,
              },
              h(CloseIcon, { size: 13 })
            )
          )
        ),

        // 模型筛选切换 Tab（仅保留单模型看板）
        viewMode === "usage"
          ? renderUsageStatsView(
              data && data.usageStats,
              loading,
              usageLoading,
              config,
              usageRange,
              setUsageRange,
              () => void fetchUsageOnly(),
              selectedProvider,
              setSelectedProvider
            )
          : h(
              "div",
              { key: "quota-view", style: { display: "flex", flexDirection: "column", gap: "10px" } },
              // 模型筛选切换 Tab（仅保留单模型看板）
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    gap: "4px",
                    background: "var(--color-background-secondary-default, rgba(128, 128, 128, 0.06))",
                    padding: "2px",
                    borderRadius: "6px",
                  },
                },
                h(
                  "button",
                  {
                    type: "button",
                    className: `gqc-tab-btn${activeTab === "gemini" ? " is-active" : ""}`,
                    style: { flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "4px" },
                    onClick: () => setActiveTab("gemini"),
                  },
                  h(GeminiIcon, { size: 12 }),
                  "Gemini"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: `gqc-tab-btn${activeTab === "codex" ? " is-active" : ""}`,
                    style: { flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "4px" },
                    onClick: () => setActiveTab("codex"),
                  },
                  h(OpenAiIcon, { size: 12, style: { color: "currentColor" } }),
                  "Codex"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: `gqc-tab-btn${activeTab === "codebuddy" ? " is-active" : ""}`,
                    style: { flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "4px" },
                    onClick: () => setActiveTab("codebuddy"),
                  },
                  h(CodeBuddyIcon, { size: 12 }),
                  "CodeBuddy"
                )
              ),

              // 全局错误提示（如有）
              error
                ? h(
                    "div",
                    {
                      style: {
                        padding: "8px 10px",
                        borderRadius: "6px",
                        background: "rgba(220, 38, 38, 0.08)",
                        border: "1px solid rgba(220, 38, 38, 0.2)",
                        color: "#dc2626",
                        fontSize: "11px",
                        lineHeight: "1.4",
                      },
                    },
                    error
                  )
                : null,

              // 额度刷新时间提示条
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "11px",
                    color: "var(--color-text-secondary, #71717a)",
                    padding: "4px 8px",
                    borderRadius: "6px",
                    background: "var(--color-background-secondary-default, rgba(128, 128, 128, 0.05))",
                    border: "1px solid var(--color-separator-border, rgba(128, 128, 128, 0.12))",
                  },
                },
                h(
                  "span",
                  { style: { display: "inline-flex", alignItems: "center", gap: "4px" } },
                  h("span", { style: { color: "var(--color-text-tertiary, #9ca3af)" } }, "🕒 刷新时间:"),
                  h("b", { style: { color: "var(--color-text-primary, #18181b)", fontWeight: 600 } }, formatRefreshTime(data ? data.fetchedAt : null))
                ),
                loading
                  ? h(
                      "span",
                      { style: { color: "#0284c7", display: "inline-flex", alignItems: "center", gap: "3px", fontWeight: 500 } },
                      h(RefreshIcon, { spinning: true, size: 11 }),
                      "刷新中…"
                    )
                  : h("span", { style: { color: "var(--color-text-tertiary, #a1a1aa)", fontSize: "10px" } }, `每 ${config.autoRefreshMinutes || 30}m 自动刷新`)
              ),

              // 单个看板视图（独立展示，不再叠放全部）
              activeTab === "gemini"
                ? renderModelCards("Gemini (Antigravity)", GeminiIcon, gemini, config)
                : null,
              activeTab === "codex"
                ? renderModelCards("Codex (ChatGPT)", OpenAiIcon, codex, config)
                : null,
              activeTab === "codebuddy"
                ? renderCodeBuddyCards("CodeBuddy", CodeBuddyIcon, codebuddy, config)
                : null,

              // 底部机制小贴士
              h(
                "div",
                {
                  style: {
                    fontSize: "10px",
                    lineHeight: "1.4",
                    color: "var(--color-text-tertiary, #a1a1aa)",
                    borderTop: "1px solid var(--color-separator-border, rgba(128, 128, 128, 0.15))",
                    paddingTop: "6px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                },
                activeTab === "codebuddy"
                  ? "💡 积分按月周期结算，各模型消耗由任务与上下文决定。"
                  : activeTab === "codex"
                    ? "💡 包含 5 小时短周期与周限，高级套餐支持月度额度券重置。"
                    : "💡 采用 5H 短周期平滑突发，7D 周限控制总额度。"
              )
            )
      )
    );
  }

  // ── 1. 状态栏小部件 (带品牌图标，智能感知当前会话) ─────────────────────────
  function StatusBarChip() {
    const { data, loading, usageLoading, error, activeEngine } = useQuotaState();
    const [config, setConfig] = useState(null);
    const [showPopover, setShowPopover] = useState(false);

    useEffect(() => {
      ctx.storage.get("config").then((cfg) => setConfig(cfg || {}));
    }, []);

    if (config && config.showStatusBarChip === false) {
      return null;
    }

    const gemini = data && data.gemini;
    const codex = data && data.codex;

    const gW = gemini && gemini.weekly;
    const g5 = gemini && gemini.h5;
    const cW = codex && codex.weekly;
    const c5 = codex && codex.h5;

    const mode = (config && config.statusBarDisplay) || "auto";

    // 智能决策当前应该聚焦哪个模型
    let target = mode;
    if (mode === "auto") {
      if (activeEngine === "codebuddy") {
        target = "codebuddy";
      } else if (activeEngine === "codex") {
        target = "codex";
      } else if (activeEngine === "omp" || activeEngine === "agy" || activeEngine === "gemini") {
        target = "gemini";
      } else {
        target = "overview";
      }
    }

    const codebuddy = data && data.codebuddy;
    const cb = codebuddy;

    // 计算当前显示目标的警示色
    const refreshedModel = target === "gemini" ? gemini : target === "codex" ? codex : target === "codebuddy" ? codebuddy : null;
    const refreshTimestamp = refreshedModel ? refreshedModel.fetchedAt : data && data.fetchedAt;
    const refreshTip = refreshTimestamp ? `\n刷新时间: ${formatRefreshTime(refreshTimestamp)}` : "";
    let tone = "safe";
    let titleTip = `点击展开详细配额与积分看板${refreshTip}`;
    if (target === "codebuddy" && cb && !cb.error) {
      tone = cb.limitNum === -1 ? "safe" : getStatusTone(cb.remainingPercent, config && config.warningThreshold);
      const limitText = cb.limitNum === -1 ? "不限额" : `${cb.limitNum} 积分`;
      titleTip = `CodeBuddy (当前会话) · 剩余: ${cb.left !== null ? cb.left : "不限"} / ${limitText} (${cb.remainingPercent}%)${refreshTip} · 点击展开看板`;
    } else if (target === "gemini" && gW) {
      const minRem = g5 ? Math.min(gW.remaining, g5.remaining) : gW.remaining;
      tone = getStatusTone(minRem, config && config.warningThreshold);
      titleTip = `Gemini (当前会话) · 7D: ${gW.remaining}% | 5H: ${g5 ? g5.remaining : "--"}%${refreshTip} · 点击展开看板`;
    } else if (target === "codex" && cW) {
      const minRem = c5 ? Math.min(cW.remaining, c5.remaining) : cW.remaining;
      tone = getStatusTone(minRem, config && config.warningThreshold);
      titleTip = `Codex (当前会话) · 7D: ${cW.remaining}% | 5H: ${c5 ? c5.remaining : "--"}%${refreshTip} · 点击展开看板`;
    } else {
      const validRems = [
        gW && gW.remaining,
        g5 && g5.remaining,
        cW && cW.remaining,
        c5 && c5.remaining,
        cb && !cb.error && typeof cb.remainingPercent === "number" ? cb.remainingPercent : null,
      ].filter((v) => typeof v === "number");
      const minRem = validRems.length > 0 ? Math.min(...validRems) : 100;
      tone = getStatusTone(minRem, config && config.warningThreshold);
    }

    if (error && !data) tone = "danger";
    const showingStaleData =
      target === "gemini"
        ? Boolean(gemini && gemini.refreshError)
        : target === "codex"
          ? Boolean(codex && codex.refreshError)
          : target === "codebuddy"
            ? Boolean(codebuddy && codebuddy.refreshError)
            : Boolean((gemini && gemini.refreshError) || (codex && codex.refreshError) || (codebuddy && codebuddy.refreshError));
    if (showingStaleData) titleTip += " · 查询失败，显示上次成功数据";

    const children = [];

    if (loading && !data) {
      children.push(h("span", { key: "loading", style: { color: "var(--color-text-tertiary, #a1a1aa)" } }, "加载中…"));
    } else if (target === "codebuddy" && cb && !cb.error) {
      children.push(
        h(
          "span",
          { key: "cb-grp", className: "gqc-chip-group" },
          h(CodeBuddyIcon, { size: 12, style: { marginRight: "2px" } }),
          h("span", { className: "gqc-chip-label" }, "积分"),
          h("span", { className: "gqc-chip-val" }, cb.limitNum === -1 ? "不限" : `${cb.remainingPercent}%`)
        )
      );
    } else if (target === "gemini" && gW) {
      // 智能聚焦 Gemini：官方 Gemini 彩色星标 + 7D + 5H
      children.push(
        h(
          "span",
          { key: "g-grp", className: "gqc-chip-group" },
          h(GeminiIcon, { size: 12, style: { marginRight: "2px" } }),
          h("span", { className: "gqc-chip-label" }, "7D"),
          h("span", { className: "gqc-chip-val" }, `${gW.remaining}%`),
          g5 ? h("span", { className: "gqc-chip-sep" }) : null,
          g5 ? h("span", { className: "gqc-chip-label" }, "5H") : null,
          g5 ? h("span", { className: "gqc-chip-val" }, `${g5.remaining}%`) : null
        )
      );
    } else if (target === "codex" && cW) {
      // 智能聚焦 Codex：官方 OpenAI 漩涡图标 + 7D + 5H
      children.push(
        h(
          "span",
          { key: "c-grp", className: "gqc-chip-group" },
          h(OpenAiIcon, { size: 12, style: { marginRight: "2px", color: "var(--color-text-primary, #18181b)" } }),
          h("span", { className: "gqc-chip-label" }, "7D"),
          h("span", { className: "gqc-chip-val" }, `${cW.remaining}%`),
          c5 ? h("span", { className: "gqc-chip-sep" }) : null,
          c5 ? h("span", { className: "gqc-chip-label" }, "5H") : null,
          c5 ? h("span", { className: "gqc-chip-val" }, `${c5.remaining}%`) : null
        )
      );
    } else {
      // 多模型概览展示
      let hasPrior = false;
      if (gW) {
        const gItems = [
          h(GeminiIcon, { key: "g-ico", size: 11, style: { marginRight: "1.5px" } }),
          h("span", { key: "g-7d-l", className: "gqc-chip-label" }, "7D"),
          h("span", { key: "g-7d-v", className: "gqc-chip-val" }, `${gW.remaining}%`),
        ];
        children.push(h("span", { key: "g-grp", className: "gqc-chip-group" }, ...gItems));
        hasPrior = true;
      }
      if (cW) {
        if (hasPrior) children.push(h("span", { key: "sep-c", className: "gqc-chip-sep" }));
        const cItems = [
          h(OpenAiIcon, { key: "c-ico", size: 11, style: { marginRight: "1.5px", color: "var(--color-text-primary, #18181b)" } }),
          h("span", { key: "c-7d-l", className: "gqc-chip-label" }, "7D"),
          h("span", { key: "c-7d-v", className: "gqc-chip-val" }, `${cW.remaining}%`),
        ];
        children.push(h("span", { key: "c-grp", className: "gqc-chip-group" }, ...cItems));
        hasPrior = true;
      }
      if (cb && !cb.error) {
        if (hasPrior) children.push(h("span", { key: "sep-cb", className: "gqc-chip-sep" }));
        const cbItems = [
          h(CodeBuddyIcon, { key: "cb-ico", size: 11, style: { marginRight: "1.5px" } }),
          h("span", { key: "cb-l", className: "gqc-chip-label" }, "积分"),
          h("span", { key: "cb-v", className: "gqc-chip-val" }, cb.limitNum === -1 ? "不限" : `${cb.remainingPercent}%`),
        ];
        children.push(h("span", { key: "cb-grp", className: "gqc-chip-group" }, ...cbItems));
      }
    }
    if (loading) {
      children.push(h(RefreshIcon, { key: "spin", spinning: true, size: 11 }));
    }

    return h(
      "div",
      { style: { display: "inline-flex", alignItems: "center", position: "relative" } },
      h(
        "button",
        {
          type: "button",
          className: `gqc-status-chip${showPopover ? " is-active" : ""}`,
          title: titleTip,
          onClick: (e) => {
            e.stopPropagation();
            setShowPopover((prev) => !prev);
          },
        },
        ...children
      ),
      showPopover
        ? h(QuotaPopover, {
            data,
            loading,
            usageLoading,
            error,
            activeEngine,
            onClose: () => setShowPopover(false),
          })
        : null
    );
  }

  // ── 注册扩展点 ──────────────────────────────────────────────────────────────
  ctx.ui.registerStatusBarItem({
    component: StatusBarChip,
    zone: "end",
  });

  ctx.ui.registerCommand({
    key: "ai-quota:refresh",
    title: () => "AI 配额: 刷新用量与积分",
    keywords: () => ["gemini", "codex", "codebuddy", "chatgpt", "quota", "credits", "积分", "周限", "额度", "用量"],
    run: () => {
      void fetchQuota(true);
    },
  });

  // ── 监听活动会话引擎切换（智能感知） ──────────────────────────────────────────
  const unsubSession = ctx.events.on("session://activated", (payload) => {
    if (payload && typeof payload === "object") {
      activeEngine = payload.engine || null;
      notifySubscribers();
    }
  });

  // ── 初始化与定时刷新 ────────────────────────────────────────────────────────
  async function init() {
    try {
      const cached = await ctx.storage.get("cached_quota");
      if (cached) {
        cachedData = cached;
        notifySubscribers();
      }
    } catch (_) {}

    void fetchQuota(false);

    try {
      const cfg = (await ctx.storage.get("config")) || {};
      let minutes = typeof cfg.autoRefreshMinutes === "number" ? cfg.autoRefreshMinutes : 30;
      if (minutes === 10) {
        minutes = 30;
        cfg.autoRefreshMinutes = 30;
        void ctx.storage.set("config", cfg);
      }
      if (minutes > 0) {
        autoTimer = setInterval(() => {
          void fetchQuota(false);
        }, minutes * 60 * 1000);
      }
    } catch (e) {
      console.warn("[gemini-quota] init timer error:", e);
    }
  }

  void init();

  // ── 清理函数 ────────────────────────────────────────────────────────────────
  return () => {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    if (typeof unsubSession === "function") {
      unsubSession();
    }
    subscribers.clear();
  };
}
