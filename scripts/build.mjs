import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));

await mkdir(output, { recursive: true });
const sources = await Promise.all(["src/quota-services.js", "src/main.js"].map((path) => readFile(resolve(root, path), "utf8")));
const entry = sources.join("\n");
await writeFile(resolve(root, "main.js"), entry);
await writeFile(resolve(output, "main.js"), entry);
await copyFile(resolve(root, "manifest.json"), resolve(output, "manifest.json"));
await copyFile(resolve(root, "styles.css"), resolve(output, "styles.css"));
for (const screenshot of manifest.screenshots ?? []) {
  const target = resolve(output, screenshot);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, screenshot), target);
}
await copyFile(resolve(root, "scripts/usage-scanner.cjs"), resolve(root, "usage-scanner.cjs"));
await copyFile(resolve(root, "scripts/usage-scanner.cjs"), resolve(output, "usage-scanner.cjs"));
await mkdir(resolve(output, "scripts"), { recursive: true });
await copyFile(resolve(root, "scripts/usage-scanner.cjs"), resolve(output, "scripts/usage-scanner.cjs"));

process.stdout.write("已从 src 生成本地安装入口及 dist 发布包（" + manifest.version + "）。\n");
