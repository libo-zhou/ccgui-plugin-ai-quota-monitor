/** 可见服务偏好与只读配额接口。发布时与 UI 合成单文件。 */

const DEFAULT_QUOTA_SERVICES = ["gemini", "codex", "codebuddy"];
const MAX_VISIBLE_QUOTA_SERVICES = 3;
const OPEN_CODE_ORIGIN = "http://127.0.0.1:4096";
const XAI_BILLING_ORIGIN = "https://management-api.x.ai/v1/billing/teams";

export function normalizeVisibleServices(value, knownIds) {
  const selection = Array.isArray(value) ? value : DEFAULT_QUOTA_SERVICES;
  return [...new Set(selection)].filter((id) => knownIds.includes(id)).slice(0, MAX_VISIBLE_QUOTA_SERVICES);
}

export function resolveService(visibleIds, ...preferred) {
  return preferred.find((id) => visibleIds.includes(id)) ?? visibleIds[0] ?? null;
}

export function validGrokTeam(team) {
  return typeof team === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(team);
}

export function validQuotaSecret(secret) {
  return typeof secret === "string" && /^[\x21-\x7e]{1,2048}$/.test(secret);
}

async function readQuotaJson(request, url, headers, messages) {
  let response;
  try {
    response = await request({ method: "GET", url, ...(headers ? { headers } : {}) });
  } catch {
    return { error: messages.unavailable };
  }
  if (response.status !== 200) {
    return { error: messages[response.status] ?? ("查询失败（HTTP " + response.status + "）") };
  }
  try {
    return { value: JSON.parse(response.body) };
  } catch {
    return { error: "返回的额度数据格式不受支持" };
  }
}

const OPEN_CODE_PERIODS = [
  ["rolling", "5 小时滚动配额", "5H"],
  ["weekly", "每周配额", "7D"],
  ["monthly", "每月配额", "月"],
];

function openCodeWindows(go) {
  return OPEN_CODE_PERIODS.flatMap(([id, label, shortLabel]) => {
    const meter = go?.[id];
    if (!Number.isFinite(meter?.percent) || meter.percent < 0) return [];
    const used = meter.limited ? 100 : Math.min(100, meter.percent);
    return [{ id, label, shortLabel, used, remaining: 100 - used, resetsAt: quotaResetTime(meter.resetsAt) }];
  });
}

function quotaResetTime(value) {
  return Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : null;
}

function openCodeBudgets(budgets) {
  if (!Array.isArray(budgets)) return [];
  return budgets.filter((budget) => (
    typeof budget?.id === "string" && Number.isFinite(budget.spent) && Number.isFinite(budget.limit)
    && budget.spent >= 0 && budget.limit >= 0
  )).map((budget) => ({
    id: budget.id,
    limit: budget.limit,
    spent: budget.spent,
    modelScoped: budget.per === "model",
    resetsAt: quotaResetTime(budget.resetsAt),
  }));
}

export async function fetchOpenCodeLimits(request, { secret } = {}) {
  if (secret != null && (typeof secret !== "string" || secret.length > 2048)) {
    return { error: "请输入有效的 OpenCode 服务密码。" };
  }
  const auth = secret
    ? { Authorization: "Basic " + btoa(String.fromCharCode(...new TextEncoder().encode("opencode:" + secret))) }
    : undefined;
  const { value, error } = await readQuotaJson(request, OPEN_CODE_ORIGIN + "/api/experimental/usage/limits", auth, {
    unavailable: "无法连接 OpenCode 本地服务，请确认它正在 127.0.0.1:4096 运行。",
    401: "OpenCode 本地服务需要有效密码，请重新连接。",
    403: "OpenCode 本地服务拒绝了查询，请检查服务密码。",
    404: "OpenCode 本地服务未提供限额接口，请升级至支持该接口的 OpenCode 2。",
  });
  if (error) return { error };
  if (value?.data === null) return { error: "请先在 OpenCode 中连接 OpenCode Console 工作区。" };
  const windows = openCodeWindows(value?.data?.go);
  const budgets = openCodeBudgets(value?.data?.budgets);
  if (windows.length === 0 && budgets.length === 0) {
    return { error: "没有可展示的 OpenCode Go 配额或 Console 预算。" };
  }
  return { windows, budgets, fetchedAt: Date.now() };
}

function usdCents(entry) {
  if (typeof entry?.val !== "string" || !/^-?\d+$/.test(entry.val)) return null;
  const amount = Number(entry.val);
  return Number.isSafeInteger(amount) ? amount : null;
}

export async function fetchGrokBilling(request, { team, secret } = {}) {
  if (!validGrokTeam(team) || !validQuotaSecret(secret)) {
    return { error: "请输入有效的 xAI Team ID 和 Management API Key。" };
  }
  const base = XAI_BILLING_ORIGIN + "/" + team;
  const auth = { Authorization: "Bearer " + secret };
  const messages = {
    unavailable: "无法连接 xAI Management API。",
    401: "xAI 管理密钥无效（HTTP 401）。",
    403: "xAI 管理密钥缺少该团队的账单读取权限（HTTP 403）。",
    404: "找不到 xAI 团队，请检查 Team ID（HTTP 404）。",
  };
  const [prepaid, postpaid] = await Promise.all([
    readQuotaJson(request, base + "/prepaid/balance", auth, messages),
    readQuotaJson(request, base + "/postpaid/spending-limits", auth, messages),
  ]);
  const prepaidCents = usdCents(prepaid.value?.total);
  const postpaidCents = usdCents(postpaid.value?.spendingLimits?.effectiveSl);
  // xAI 以负数记入购入的预付积分，正数记入消耗。
  const balance = prepaidCents === null ? null : (0 - prepaidCents) / 100;
  const postpaidLimit = postpaidCents === null || postpaidCents < 0 ? null : postpaidCents / 100;
  if (balance === null && postpaidLimit === null) {
    return { error: prepaid.error ?? postpaid.error ?? "xAI 未返回可用的账单额度。" };
  }
  const notice = balance === null
    ? prepaid.error ?? "xAI 未返回预付余额。"
    : postpaidLimit === null ? postpaid.error ?? "xAI 未返回后付费月度上限。" : null;
  return { balance, postpaidLimit, notice, fetchedAt: Date.now() };
}

const OPEN_CODE_GO_URL = "https://opencode.ai/inference/go/v1/usage";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const GLM_ORIGINS = { cn: "https://open.bigmodel.cn", global: "https://api.z.ai" };

const KEY_ERRORS = {
  unavailable: "无法连接额度服务，请检查网络后重试。",
  401: "API Key 无效或已过期（HTTP 401）。",
  403: "该 API Key 没有订阅额度查询权限（HTTP 403）。",
  429: "查询过于频繁，请稍后再试。",
};

function getWithKey(request, url, secret) {
  return readQuotaJson(request, url, { Authorization: "Bearer " + secret, Accept: "application/json" }, KEY_ERRORS);
}

function periodWindow(id, used, reset) {
  if (!Number.isFinite(used) || used < 0) return null;
  const [, label, shortLabel] = OPEN_CODE_PERIODS.find(([name]) => name === id);
  const percent = Math.min(100, used);
  return { id, label, shortLabel, used: percent, remaining: 100 - percent, resetsAt: resetTime(reset) };
}

function resetTime(value) {
  return quotaResetTime(typeof value === "string" ? Date.parse(value) : value);
}

function quotaWindows(meters) {
  const windows = OPEN_CODE_PERIODS.map(([id]) => meters.get(id)).filter(Boolean);
  return windows.length ? { windows, fetchedAt: Date.now() } : { error: "服务没有返回可用的订阅额度。" };
}

export async function fetchOpenCodeGo(request, { secret } = {}) {
  if (!validQuotaSecret(secret)) return { error: "请输入 OpenCode Go API Key。" };
  const { value, error } = await getWithKey(request, OPEN_CODE_GO_URL, secret);
  if (error) return { error };
  const meters = new Map(OPEN_CODE_PERIODS.map(([id]) => {
    const data = value?.usage?.[id];
    const used = data?.status === "rate-limited" ? 100 : data?.percent;
    return [id, periodWindow(id, used, data?.resetsAt)];
  }));
  return quotaWindows(meters);
}

function parseGlmQuota(value) {
  const meters = new Map();
  for (const item of Array.isArray(value?.data?.limits) ? value.data.limits : []) {
    if (item?.type !== "TOKENS_LIMIT" && item?.type !== "CREDIT_LIMIT") continue;
    const key = item.unit + ":" + item.number;
    const id = { "3:5": "rolling", "4:7": "weekly", "6:1": "weekly", "5:1": "monthly" }[key];
    if (!id) continue;
    const window = periodWindow(id, item.percentage, item.nextResetTime);
    if (window && (!meters.has(id) || item.type === "CREDIT_LIMIT")) meters.set(id, window);
  }
  return quotaWindows(meters);
}

export async function fetchGlmQuota(request, { region, secret } = {}) {
  if (!Object.hasOwn(GLM_ORIGINS, region) || !validQuotaSecret(secret)) return { error: "请选择正确区域并输入套餐 API Key。" };
  const base = GLM_ORIGINS[region] + "/api/monitor/usage";
  let result = await getWithKey(request, base + "/quota/limit", secret);
  if (result.value?.code === 401 || /HTTP (401|404)/.test(result.error ?? "")) {
    result = await getWithKey(request, base, secret);
  }
  if (result.error) return { error: result.error };
  if (result.value?.code === 401 || result.value?.code === 403) return { error: KEY_ERRORS[result.value.code] };
  return parseGlmQuota(result.value);
}

function kimiNumber(value) {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
}

function kimiCounter(id, data) {
  const total = kimiNumber(data?.limit);
  if (!(total > 0)) return null;
  const remaining = kimiNumber(data.remaining);
  const used = Number.isFinite(remaining) ? Math.max(0, total - remaining) : kimiNumber(data.used);
  return periodWindow(id, used / total * 100, data.resetTime ?? data.reset_time);
}

function parseKimiQuota(value) {
  const data = value?.data?.quota ?? value;
  const rolling = Array.isArray(data?.limits) ? data.limits.find((item) => (
    Number(item?.window?.duration) === 300 && item.window.timeUnit === "TIME_UNIT_MINUTE"
  )) : null;
  const meters = new Map([
    ["rolling", kimiCounter("rolling", rolling?.detail ?? rolling)],
    ["weekly", kimiCounter("weekly", data?.usage)],
  ]);
  const aliases = { rolling: ["limit_5h", "limit5h"], weekly: ["limit_7d", "limit7d"], monthly: ["limit_month_total", "monthTotal"] };
  for (const [id, [snake, camel]] of Object.entries(aliases)) {
    if (meters.get(id)) continue;
    const ratios = data?.usages ?? data;
    const meter = ratios?.[snake] ?? ratios?.[camel];
    const used = kimiNumber(meter?.used_ratio ?? meter?.usedRatio);
    if (used >= 0 && used <= 1) meters.set(id, periodWindow(id, used * 100, meter.reset_time ?? meter.resetTime));
  }
  return quotaWindows(meters);
}

export async function fetchKimiQuota(request, { secret } = {}) {
  if (!validQuotaSecret(secret)) return { error: "请输入 Kimi Code 套餐 API Key。" };
  const { value, error } = await getWithKey(request, KIMI_USAGE_URL, secret);
  if (error) return { error };
  return parseKimiQuota(value);
}

function hostWindow(window, provider) {
  const used = window?.usedPercent;
  if (!Number.isFinite(used) || used < 0 || used > 100 || typeof window.id !== "string") return null;
  const [label, shortLabel] = window.kind === "session" ? ["5 小时滚动配额", "5H"]
    : window.kind === "weekly" ? ["每周配额", "7D"]
    : window.id === "monthly" ? ["每月配额", "月"]
    : provider === "grok" ? ["当前计费周期", "周期"]
    : ["订阅额度", "额度"];
  return {
    id: window.id, label: window.label ? window.label + " · " + label : label, shortLabel,
    used, remaining: 100 - used, resetsAt: resetTime(window.resetsAt), kind: window.kind,
  };
}

export async function fetchHostQuota(get, provider) {
  const cli = { claude: "Claude Code", grok: "Grok Build" }[provider];
  const channel = !cli;
  if (!get) return { error: "当前 CC GUI 版本没有提供订阅额度接口。", clearPrevious: true };
  let result;
  try {
    result = await get({ providers: [provider], refresh: true });
  } catch (error) {
    const message = typeof error === "string" ? error : error?.message ?? "";
    if (cli && message.includes("CredentialConsentRequired:")) {
      return { error: "可在插件详情页允许读取 " + cli + " 登录凭据，再刷新额度。", clearPrevious: true };
    }
    if (message.includes("providers must be a subset") || message.includes("unknown limits provider")) {
      return { error: "当前 CC GUI 版本尚不支持此订阅查询，请更新宿主。", clearPrevious: true };
    }
    return { error: "无法通过 CC GUI 查询订阅额度。", clearPrevious: channel };
  }
  const data = result?.providers?.find((item) => item.id === provider);
  if (!data || data.status !== "ok") {
    const messages = {
      signedOut: channel ? "CC GUI 没有启用对应的套餐渠道，可以手动填 Key。" : "请先登录 " + cli + " 的订阅账号。",
      expired: channel ? "已配置渠道的 Key 无法查询额度，请检查套餐或手动填 Key。" : cli + " 登录已过期，请在 CLI 中重新登录。",
      rateLimited: "查询过于频繁，请稍后再试。",
      offline: "暂时无法连接订阅额度服务。",
    };
    const reason = data?.error === "multiple active channels"
      ? "CC GUI 启用了多个不同的套餐账号，请手动输入要查询的 Key。" : messages[data?.status];
    return { error: reason ?? "订阅接口未返回可用数据。",
      clearPrevious: channel || data?.status === "expired" || data?.status === "signedOut" };
  }
  const windows = data.windows?.map((window) => hostWindow(window, provider)).filter(Boolean);
  return windows?.length ? { windows, fetchedAt: data.fetchedAt }
    : { error: "当前账号没有可展示的订阅额度。" };
}
