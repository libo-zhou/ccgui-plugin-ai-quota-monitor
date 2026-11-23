import assert from "node:assert/strict";
import test from "node:test";
import { fetchOpenCodeLimits, fetchGrokBilling, fetchOpenCodeGo, fetchGlmQuota, fetchKimiQuota, fetchHostQuota, normalizeVisibleServices, resolveService } from "../src/quota-services.js";

const respond = (status, value) => ({ status, body: JSON.stringify(value) });

test("旧设置保留三家，允许全部隐藏，过滤重复和已移除的服务", () => {
  const ids = ["gemini", "codex", "codebuddy", "opencode", "grok"];
  assert.deepEqual(normalizeVisibleServices(undefined, ids), ids.slice(0, 3));
  assert.deepEqual(normalizeVisibleServices([], ids), []);
  assert.deepEqual(normalizeVisibleServices(["opencode", "unknown", "opencode", "codex"], ids), ["opencode", "codex"]);
  assert.equal(resolveService(["codex", "grok"], "opencode", "grok"), "grok");
  assert.equal(resolveService([], "opencode", "grok"), null);
});

test("旧偏好选了四家以上时，按原顺序保留前三个有效服务", () => {
  const ids = ["gemini", "codex", "codebuddy", "opencode", "grok", "claude"];
  const legacy = ["grok", "unknown", "opencode", "grok", "claude", "gemini", "codex"];
  assert.deepEqual(normalizeVisibleServices(legacy, ids), ["grok", "opencode", "claude"]);
});

test("OpenCode 本地查询使用官方返回的周期百分比和 UTC 重置时间", async () => {
  const resetsAt = 1795058400000;
  const result = await fetchOpenCodeLimits(async (request) => {
    assert.equal(request.url, "http://127.0.0.1:4096/api/experimental/usage/limits");
    assert.equal(request.method, "GET");
    assert.deepEqual(request.headers, { Authorization: "Basic b3BlbmNvZGU6dGVzdA==" });
    return respond(200, { location: {}, data: {
      workspace: { name: "Personal" },
      go: {
        rolling: { percent: 0, limited: false, resetsAt },
        weekly: { percent: 34, limited: false, resetsAt },
        monthly: { percent: 100, limited: true, resetsAt },
      },
      budgets: [],
    } });
  }, { secret: "test" });
  assert.deepEqual(result.windows.map(({ id, remaining, resetsAt }) => [id, remaining, resetsAt]), [
    ["rolling", 100, resetsAt], ["weekly", 66, resetsAt], ["monthly", 0, resetsAt],
  ]);
});

test("OpenCode 未连接、旧版本或损坏响应不显示虚假的满额", async () => {
  for (const response of [respond(200, { data: null }), respond(404, {}), respond(200, { data: { go: {}, budgets: [] } })]) {
    const result = await fetchOpenCodeLimits(async () => response, {});
    assert.ok(result.error);
    assert.equal(result.windows, undefined);
  }
});

test("Grok 查询 API 团队余额和后付费月度上限，金额按美分换算", async () => {
  const urls = [];
  const result = await fetchGrokBilling(async ({ method, url, headers }) => {
    assert.equal(method, "GET");
    assert.deepEqual(headers, { Authorization: "Bearer mock-management-key" });
    urls.push(url);
    if (url.endsWith("/prepaid/balance")) return respond(200, { total: { val: "-1234" } });
    return respond(200, { spendingLimits: { effectiveSl: { val: "0" } } });
  }, { team: "team-123", secret: "mock-management-key" });
  assert.deepEqual(urls, [
    "https://management-api.x.ai/v1/billing/teams/team-123/prepaid/balance",
    "https://management-api.x.ai/v1/billing/teams/team-123/postpaid/spending-limits",
  ]);
  assert.equal(result.balance, 12.34);
  assert.equal(result.postpaidLimit, 0);
  assert.equal(JSON.stringify(result).includes("mock-management-key"), false);
});

test("Grok 部分权限不会把缺失指标显示为零，非法团队 ID 不发送请求", async () => {
  const invalid = await fetchGrokBilling(() => assert.fail("不应发送请求"), { team: "../billing", secret: "mock-key" });
  assert.ok(invalid.error);
  const partial = await fetchGrokBilling(async ({ url }) => url.endsWith("/prepaid/balance")
    ? respond(200, { total: { val: "0" } }) : respond(403, { message: "mock-key" }), { team: "team-123", secret: "mock-key" });
  assert.equal(partial.balance, 0);
  assert.equal(partial.postpaidLimit, null);
  assert.match(partial.notice, /403/);
  assert.doesNotMatch(partial.notice, /mock-key/);
});


test("OpenCode Go API Key 走官方云端额度接口，保留 ISO 重置时间", async () => {
  const reset = "2026-11-24T06:00:00Z";
  const result = await fetchOpenCodeGo(async (request) => {
    assert.equal(request.url, "https://opencode.ai/inference/go/v1/usage");
    assert.equal(request.headers.Authorization, "Bearer mock-go-key");
    return respond(200, { usage: { weekly: { percent: 29, status: "ok", resetsAt: reset } } });
  }, { secret: "mock-go-key" });
  assert.deepEqual(result.windows.map(w => [w.id, w.remaining, w.resetsAt]), [["weekly", 71, Date.parse(reset)]]);
});

test("GLM 国区和国际版密钥只发到所选区域，解析 token 与积分窗口", async () => {
  const urls = [];
  const result = await fetchGlmQuota(async ({ url, headers }) => {
    urls.push(url);
    assert.equal(headers.Authorization, "Bearer mock-glm-key");
    if (url.endsWith("/quota/limit")) return respond(200, { code: 401 });
    return respond(200, { code: 200, data: { limits: [
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 45, nextResetTime: 1795058400000 },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
      { type: "TIME_LIMIT", unit: 3, number: 5, percentage: 99 },
    ] } });
  }, { region: "global", secret: "mock-glm-key" });
  assert.deepEqual(urls, ["https://api.z.ai/api/monitor/usage/quota/limit", "https://api.z.ai/api/monitor/usage"]);
  assert.deepEqual(result.windows.map(w => [w.id, w.remaining]), [["rolling", 100], ["weekly", 55]]);
  await fetchGlmQuota(async ({ url }) => {
    assert.equal(new URL(url).hostname, "open.bigmodel.cn");
    return respond(403, {});
  }, { region: "cn", secret: "mock-glm-key" });
});

test("Kimi 优先使用旧版真实计数，再补充新版比率与月份额度", async () => {
  const result = await fetchKimiQuota(async ({ url }) => {
    assert.equal(url, "https://api.kimi.com/coding/v1/usages");
    return respond(200, {
      usage: { limit: "100", used: "85" },
      limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "12" } }],
      usages: { limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0 }, limit_month_total: { used_ratio: 0.2 } },
    });
  }, { secret: "mock-kimi-code-key" });
  assert.deepEqual(result.windows.map(w => [w.id, w.remaining]), [["rolling", 12], ["weekly", 15], ["monthly", 80]]);
});

test("宿主授权撤销和登出应清除旧配额，避免继续显示上一个账号的数据", async () => {
  const result = await fetchHostQuota(async () => { throw new Error("CredentialConsentRequired: grok: denied"); }, "grok");
  assert.equal(result.clearPrevious, true);
  const expired = await fetchHostQuota(async () => ({ providers: [{id: "claude", status: "expired"}] }), "claude");
  assert.equal(expired.clearPrevious, true);
  const weekly = await fetchHostQuota(async () => ({ providers: [{ id: "grok", status: "ok", fetchedAt: 200,
    windows: [{id: "current", kind: "weekly", usedPercent: 30, windowSeconds: 604800, resetsAt: 1795058400000}] }] }), "grok");
  assert.deepEqual(weekly.windows.map(w => [w.id, w.label, w.remaining]), [["current", "每周配额", 70]]);
});
