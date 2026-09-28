import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

async function read(relativePath) {
  try {
    return await readFile(resolve(root, relativePath));
  } catch {
    errors.push("缺少必需文件：" + relativePath);
    return null;
  }
}

const manifestBuffer = await read("manifest.json");
const source = await read("src/main.js");
const installedEntry = await read("main.js");
const styles = await read("styles.css");
const readme = await read("README.md");
const license = await read("LICENSE");
const releaseWorkflow = await read(".github/workflows/release.yml");
const screenshot = await read("docs/codex-quota.png");
let manifest;

try {
  manifest = JSON.parse(manifestBuffer?.toString("utf8") ?? "");
} catch {
  errors.push("manifest.json 不是有效 JSON");
}

if (manifest) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id ?? "")) errors.push("插件 id 格式无效");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) errors.push("插件 version 必须是三段式 semver");
  if ([...(manifest.name ?? "")].length > 30) errors.push("插件名称超过 30 个字符");
  if ([...(manifest.description ?? "")].length > 120) errors.push("插件描述超过 120 个字符");
  if (!manifest.repo || !manifest.author || !manifest.minAppVersion || !manifest.sdkVersion) errors.push("market manifest 缺少 repo、author 或兼容版本字段");
  if (!manifest.license) errors.push("manifest.json 缺少 license");
  if (!Array.isArray(manifest.permissions)) errors.push("manifest.permissions 必须是数组");
  if (manifest.screenshots?.some((item) => item.includes("\\") || item.split("/").includes(".."))) {
    errors.push("截图路径必须是仓库内相对路径");
  }
}

if (manifestBuffer && !manifestBuffer.equals(await read("dist/manifest.json"))) errors.push("dist/manifest.json 与根 manifest 不一致");
if (source && installedEntry && !source.equals(installedEntry)) errors.push("main.js 与 src/main.js 不一致，请运行 pnpm build");
if (source && !source.equals(await read("dist/main.js"))) errors.push("dist/main.js 与 src/main.js 不一致，请运行 pnpm build");
if (styles && !styles.equals(await read("dist/styles.css"))) errors.push("dist/styles.css 与根 styles.css 不一致，请运行 pnpm build");

if (source) {
  const text = source.toString("utf8");
  if (/\beval\s*\(/.test(text)) errors.push("main.js 命中禁止项 eval()");
  if (/new\s+Function\s*\(/.test(text)) errors.push("main.js 命中禁止项 new Function()");
  if (/__TAURI__|\blocalStorage\b/.test(text)) errors.push("main.js 命中禁止访问宿主 API / localStorage");
  if (/import\s*\(\s*["']https?:\/\//.test(text)) errors.push("main.js 命中远程动态 import");
  for (const [code, permission] of [
    ["plugin_http_request", "network:chatgpt.com"],
    ["plugin_exec_run", "exec:node"],
    ["google-antigravity", "exec:omp"],
    ["registerStatusBarItem", "ui:status-bar"],
    ["registerSettingsSection", "ui:settings-section"],
    ["registerCommand", "ui:command"],
  ]) {
    if (text.includes(code) && !manifest?.permissions?.includes(permission)) {
      errors.push("代码使用 " + code + "，但 manifest 未声明 " + permission);
    }
  }
}

if (styles && /@import\b|url\(\s*['"]?https?:\/\//i.test(styles.toString("utf8"))) {
  errors.push("styles.css 不得引用远程资源");
}

if (screenshot) {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!screenshot.subarray(0, 8).equals(pngSignature)) errors.push("docs/codex-quota.png 不是有效 PNG");
}
if (readme && !readme.toString("utf8").includes("![Codex 配额详情](docs/codex-quota.png)")) {
  errors.push("README.md 未引用用户指定的截图");
}
if (license && !(await stat(resolve(root, "LICENSE"))).isFile()) errors.push("LICENSE 必须是文件");
if (!releaseWorkflow?.toString("utf8").includes("softprops/action-gh-release")) errors.push("release.yml 未创建 GitHub Release");
if (manifest?.screenshots?.some((item) => item.startsWith("/") || resolve(root, item).split(sep).includes(".."))) {
  errors.push("manifest 截图路径逃逸仓库");
}

if (errors.length) {
  process.stderr.write(errors.map((item) => "- " + item).join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write("manifest、源码、权限、截图、README 与发布包检查通过。\n");
}
