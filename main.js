/**
 * AI Quota and Usage Monitor for CC GUI
 * Tier-1 JS Plugin
 */

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useCallback, useMemo } = ctx.react;

  // ── 内部状态与订阅 ──────────────────────────────────────────────────────────
  let cachedData = null;
  let isFetching = false;
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
      const [geminiResult, codexResult, codebuddyResult] = await Promise.all([
        fetchGeminiQuota(),
        fetchCodexQuota(),
        fetchCodeBuddyQuota(),
      ]);

      const hasFreshResult =
        (geminiResult && !geminiResult.error) ||
        (codexResult && !codexResult.error) ||
        (codebuddyResult && !codebuddyResult.error);
      const merged = {
        fetchedAt: hasFreshResult ? Date.now() : cachedData ? cachedData.fetchedAt : null,
        gemini: preserveQuotaAfterFailure(geminiResult, cachedData && cachedData.gemini),
        codex: preserveQuotaAfterFailure(codexResult, cachedData && cachedData.codex),
        codebuddy: preserveQuotaAfterFailure(codebuddyResult, cachedData && cachedData.codebuddy),
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

  // ── 自定义 Hook 订阅状态 ────────────────────────────────────────────────────
  function useQuotaState() {
    const [state, setState] = useState(() => ({
      data: cachedData,
      loading: isFetching,
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
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 } },
          h(BrandIcon, { size: 14 }),
          h("span", null, title)
        ),
        h(
          "div",
          { style: { color: "var(--color-text-tertiary, #a1a1aa)", fontSize: "11px", marginTop: "4px" } },
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

      // 额度券提示
      modelData.resetCredits !== undefined && modelData.resetCredits > 0
        ? h(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "6px 10px",
                borderRadius: "6px",
                background: "rgba(16, 185, 129, 0.08)",
                border: "1px solid rgba(16, 185, 129, 0.2)",
                fontSize: "11px",
                color: "#059669",
              },
            },
            h("span", null, "🎟️ 月度额度重置券:"),
            h("b", null, `${modelData.resetCredits} 次可用`)
          )
        : null
    );
  }

  // ── CodeBuddy 账号积分指标卡片渲染辅助 ─────────────────────────────────────
  function renderCodeBuddyCards(title, BrandIcon, modelData, config) {
    if (!modelData || modelData.error) {
      return h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 } },
          h(BrandIcon, { size: 14 }),
          h("span", null, title)
        ),
        h(
          "div",
          { style: { color: "var(--color-text-tertiary, #a1a1aa)", fontSize: "11px", marginTop: "4px" } },
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

      // 月度积分余额卡片
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "本月积分余额 (Monthly)"
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
          ),
          modelData.resetsAt
            ? h(
                "div",
                { style: { gridColumn: "1 / -1" } },
                "重置倒计时: ",
                h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, formatResetTime(modelData.resetsAt)),
                ` (${formatExactDate(modelData.resetsAt)})`
              )
            : null,
          modelData.cycleStartTime && modelData.cycleEndTime
            ? h(
                "div",
                { style: { gridColumn: "1 / -1", fontSize: "10px", color: "var(--color-text-tertiary, #a1a1aa)" } },
                `周期: ${modelData.cycleStartTime.slice(0, 10)} ~ ${modelData.cycleEndTime.slice(0, 10)}`
              )
            : null
        )
      )
    );
  }

  // ── 弹出详情弹框组件 (单模型看板 Popover Modal) ───────────────────────────
  function QuotaPopover({ data, loading, error, activeEngine, onClose }) {
    function resolveInitialTab(engine) {
      if (engine === "codebuddy") return "codebuddy";
      if (engine === "codex") return "codex";
      if (engine === "omp" || engine === "agy" || engine === "gemini") return "gemini";
      if (data && data.codebuddy && !data.codebuddy.error) return "codebuddy";
      if (data && data.gemini && !data.gemini.error) return "gemini";
      if (data && data.codex && !data.codex.error) return "codex";
      return "gemini";
    }

    const [activeTab, setActiveTab] = useState(() => resolveInitialTab(activeEngine));
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
          className: "gqc-popover",
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
            activeTab === "codebuddy"
              ? h(CodeBuddyIcon, { size: 14 })
              : activeTab === "codex"
                ? h(OpenAiIcon, { size: 14, style: { color: "var(--color-text-primary, #18181b)" } })
                : h(GeminiIcon, { size: 14 }),
            h(
              "span",
              { style: { fontWeight: 600, fontSize: "13px", color: "var(--color-text-primary, #18181b)" } },
              activeTab === "codebuddy"
                ? "CodeBuddy 积分看板"
                : activeTab === "codex"
                  ? "Codex 配额看板"
                  : "Gemini 配额看板"
            )
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "2px" } },
            h(
              "button",
              {
                type: "button",
                className: "gqc-icon-button",
                title: "立即刷新全部配额与积分",
                disabled: loading,
                onClick: () => fetchQuota(true),
              },
              h(RefreshIcon, { spinning: loading, size: 13 })
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
            },
          },
          activeTab === "codebuddy"
            ? "💡 CodeBuddy 积分按月周期结算，各模型消耗不同，由任务与上下文复杂度决定。"
            : activeTab === "codex"
              ? "💡 包含 5 小时短周期与周限，高级套餐支持月度额度券重置。"
              : "💡 采用 5H 短周期平滑突发，7D 周限控制总额度。"
        )
      )
    );
  }

  // ── 1. 状态栏小部件 (带品牌图标，智能感知当前会话) ─────────────────────────
  function StatusBarChip() {
    const { data, loading, error, activeEngine } = useQuotaState();
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
