/**
 * dsh-workbuddy-websearch 本地安装助手。
 *
 * 用法（装完 `dsh plugin --profile web add <本插件目录>` 后，若 dump-config
 * 核验不通过，跑这一步修复链接与登记）：
 *
 *   node "<本插件目录>/tools/ensure-installed.mjs" "<DSH_HOME>" web
 *
 * 其中 <DSH_HOME> 是 dsh 的数据根（profile 所在的 `.dsh-home` 目录）。
 * Windows 下用 cmd 时要加引号，或写成单行。
 *
 * 做三件事（全部幂等）：
 * 1. 若 profiles/<name>/node_modules/dsh-workbuddy-websearch 不是指向本源码
 *    目录的链接（pnpm 的 link: 在部分环境下会留下一个空目录），替换为 junction；
 * 2. 若 profiles/<name>/package.json 的 dsh.profile.bundles 缺本插件名，补上；
 * 3. 打印核验命令提示。
 */
import { lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_NAME = "dsh-workbuddy-websearch";
const PLUGIN_SOURCE = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const dshHome = process.argv[2];
const profileName = process.argv[3] ?? "web";
if (dshHome === undefined) {
  console.error("usage: node ensure-installed.mjs <dsh-home> [profile=web]");
  process.exit(1);
}
const profileDir = join(dshHome, "profiles", profileName);
const link = join(profileDir, "node_modules", PLUGIN_NAME);

// 1) junction 修复
let linkOk = false;
try {
  linkOk = lstatSync(link).isSymbolicLink() && readdirSync(link).includes("package.json");
} catch {}
if (!linkOk) {
  try {
    const st = lstatSync(link);
    if (st.isDirectory() && !st.isSymbolicLink()) rmSync(link, { recursive: false });
    else rmSync(link);
  } catch {}
  symlinkSync(PLUGIN_SOURCE, link, "junction");
  console.log(`[fix] junction -> ${PLUGIN_SOURCE}`);
} else {
  console.log("[ok] node_modules link present");
}

// 2) bundles 登记
const manifestPath = join(profileDir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bundles = manifest?.dsh?.profile?.bundles ?? [];
if (!bundles.includes(PLUGIN_NAME)) {
  if (manifest?.dsh?.profile === undefined) {
    console.error("[error] profile manifest has no dsh.profile section; aborting bundles edit");
    process.exit(1);
  }
  bundles.push(PLUGIN_NAME);
  manifest.dsh.profile.bundles = bundles;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("[fix] bundles += " + PLUGIN_NAME);
} else {
  console.log("[ok] bundles registered");
}

console.log(`
核验（应能看到 searchProvider: workbuddy-agentic 与 id: web-workbuddy-websearch）:
  set DSH_HOME=${dshHome.replaceAll("/", "\\")}
  node "<dsh安装根>/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile ${profileName} --dump-config | findstr /I "workbuddy-websearch searchProvider"`);
