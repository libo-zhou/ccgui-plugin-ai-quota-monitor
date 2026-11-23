import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const body = source.split("async function fetchCodeBuddyQuota() {")[1].split("\n    try {")[0];
const runner = vm.runInNewContext(body + "\nnodeInlineCode;");

async function query(platform, payload, exists = true) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const home = platform === "win32" ? "C:\\Users\\fixture" : "/home/fixture";
  const root = platform === "win32" ? "C:\\AppData\\Local" : platform === "darwin"
    ? paths.join(home, "Library", "Application Support") : "/fixture/xdg";
  const expected = paths.join(root, "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info");
  const reads = [];
  const requests = [];
  const output = new Promise((resolve, reject) => {
    const fs = {
      existsSync: (file) => { assert.equal(file, expected); return exists; },
      readFileSync: (file, encoding) => {
        assert.equal(file, expected);
        assert.equal(encoding, "utf8");
        reads.push(file);
        return payload;
      },
      readdirSync: () => { throw new Error("不得遍历认证目录"); },
      statSync: () => { throw new Error("不得比较认证文件修改时间"); },
    };
    const https = { request: (options, callback) => {
      requests.push(options);
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        res.emit("data", JSON.stringify({ data: { Packages: [] } }));
        res.emit("end");
      };
      return req;
    } };
    const modules = { fs, path: paths, os: { homedir: () => home }, https };
    vm.runInNewContext(runner, {
      require: (name) => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; },
      process: { platform, env: { LOCALAPPDATA: "C:\\AppData\\Local", XDG_DATA_HOME: "/fixture/xdg" } },
      console: { log: (value) => { try { resolve(JSON.parse(value)); } catch (error) { reject(error); } } },
    });
  });
  return { result: await output, reads, requests };
}

for (const platform of ["win32", "darwin", "linux"]) {
  test("CodeBuddy 在 " + platform + " 只读取指定登录文件，保留积分查询", async () => {
    for (const accessToken of ["fixture-token", { token: "fixture-token" }]) {
      const { result, reads, requests } = await query(platform, JSON.stringify({ auth: { accessToken }, account: {} }));
      assert.equal(result.ok, true);
      assert.equal(reads.length, 1);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].hostname, "copilot.tencent.com");
      assert.equal(requests[0].headers.Authorization, "Bearer fixture-token");
      assert.ok(!JSON.stringify(result).includes("fixture-token"));
    }
  });
}

test("指定文件缺失、损坏或无令牌时直接报错，不回退到其他账号", async () => {
  for (const [payload, exists] of [["", false], ['{"auth": "private-invalid-json', true], ["{}", true]]) {
    const { result, reads, requests } = await query("win32", payload, exists);
    assert.equal(typeof result.error, "string");
    assert.ok(!JSON.stringify(result).includes("private-invalid-json"));
    assert.equal(reads.length, exists ? 1 : 0);
    assert.equal(requests.length, 0);
  }
});
