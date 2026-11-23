import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));

await mkdir(output, { recursive: true });
await copyFile(resolve(root, "src/main.js"), resolve(root, "main.js"));
await copyFile(resolve(root, "src/main.js"), resolve(output, "main.js"));
await copyFile(resolve(root, "manifest.json"), resolve(output, "manifest.json"));
await copyFile(resolve(root, "styles.css"), resolve(output, "styles.css"));
await copyFile(resolve(root, "scripts/usage-scanner.cjs"), resolve(output, "usage-scanner.cjs"));
await mkdir(resolve(output, "scripts"), { recursive: true });
await copyFile(resolve(root, "scripts/usage-scanner.cjs"), resolve(output, "scripts/usage-scanner.cjs"));

process.stdout.write("已从 src/main.js 生成本地安装入口及 dist 发布包（" + manifest.version + "）。\n");
