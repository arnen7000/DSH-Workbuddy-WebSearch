#!/usr/bin/env node
/**
 * GitHub 元数据自检（tools/check-github-meta.mjs）
 * ---------------------------------------------------------------------------
 * 校验 GitHub 侧的"社区档案（Community Standards）"与仓库配置是否齐备且格式合法。
 * 这些文件不影响插件运行时，但**一旦缺失或格式错误，GitHub 会掉勾、甚至整份 Issue 表单被拒收**。
 *
 * 覆盖：
 *   G1 社区健康文件（README / LICENSE / SECURITY / CONTRIBUTING / CODE_OF_CONDUCT）
 *   G2 Issue 模板与 PR 模板存在
 *   G3 Issue Forms 结构合法（GitHub 要求 name / description / body，body 项必须有 type）
 *   G4 Dependabot 配置合法（version: 2 + updates 数组 + 每项有 package-ecosystem/directory/schedule）
 *   G5 CI 工作流最小权限（permissions 存在）与关键步骤接线；发布工作流的
 *      可信发布（OIDC）契约：id-token、触发方式、registry、不得注入长期 token
 *   G6 仓库占位符检查（<your-gh-user> / OWNER/REPO 尚未替换时给出提示，不判 FAIL）
 *   G7 发布面精简（长文留本地 .local/，对外只留简短版）
 *   G8 **本机信息泄露检查**（对外仓库任何文件都不得出现本机路径 / 用户名 / 本机目录名 /
 *      本机专属的 dsh 数据目录命名 / 本机专属包名）
 *      确属合成数据的行可加 `g8-ignore: <理由>` 豁免。
 *   G9 **时间信息分级检查**（对外仓库只留"基本时间信息"：文档版本头到月、客观事实日期到日）
 *      日级 ISO 日期仅白名单允许；确属必要的行可加 `g9-allow: <理由>` 豁免。
 *
 * 刻意**零依赖**（不引入 YAML 解析库），用结构化正则做"抓大错"检查。
 *
 * 用法：
 *   node tools/check-github-meta.mjs "<仓库根目录>"
 * 无参数时默认用本脚本所在仓库根。
 *
 * 退出码：仅 FAIL 非零。占位符属于 WARN。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, ".."));

let pass = 0;
let fail = 0;
let warn = 0;
const failures = [];
const warnings = [];

function check(id, label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${id}  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${id}  ${label}${detail ? `  → ${detail}` : ""}`);
    fail += 1;
    failures.push(`${id} ${label}${detail ? ` (${detail})` : ""}`);
  }
}
function soft(id, label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${id}  ${label}`);
    pass += 1;
  } else {
    console.log(`  WARN  ${id}  ${label}${detail ? `  → ${detail}` : ""}`);
    warn += 1;
    warnings.push(`${id} ${label}${detail ? ` (${detail})` : ""}`);
  }
}
const read = (rel) => {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
};

// ───────────────────────── G1 社区健康文件 ─────────────────────────
console.log(`\nG1  社区健康文件（GitHub Community Standards 清单）`);
for (const [id, file, label] of [
  ["G1.1", "README.md", "README（必需）"],
  ["G1.2", "LICENSE", "LICENSE（必需）"],
  ["G1.3", "CONTRIBUTING.md", "CONTRIBUTING（推荐）"],
  ["G1.4", "CODE_OF_CONDUCT.md", "CODE_OF_CONDUCT（推荐）"],
  ["G1.5", "SECURITY.md", "SECURITY（推荐；本插件碰凭据，强烈建议有）"],
]) {
  check(id, file + " 存在", read(file) !== undefined, `缺少 ${label}`);
}

// ───────────────────────── G2 模板文件 ─────────────────────────
console.log(`\nG2  模板文件`);
check("G2.1", ".github/pull_request_template.md 存在", read(".github/pull_request_template.md") !== undefined);
check("G2.2", ".github/ISSUE_TEMPLATE/bug_report.yml 存在", read(".github/ISSUE_TEMPLATE/bug_report.yml") !== undefined);
check("G2.3", ".github/ISSUE_TEMPLATE/feature_request.yml 存在", read(".github/ISSUE_TEMPLATE/feature_request.yml") !== undefined);

// ───────────────────────── G3 Issue Forms 结构 ─────────────────────────
console.log(`\nG3  Issue Forms 结构（格式错误会导致 GitHub 整份表单拒收）`);
for (const [id, file] of [
  ["G3.1", ".github/ISSUE_TEMPLATE/bug_report.yml"],
  ["G3.2", ".github/ISSUE_TEMPLATE/feature_request.yml"],
]) {
  const src = read(file);
  if (src === undefined) {
    check(id, `${file} 结构合法`, false, "文件不存在");
    continue;
  }
  const errs = [];
  if (!/^name:\s*\S/m.test(src)) errs.push("缺少 name");
  if (!/^description:\s*\S/m.test(src)) errs.push("缺少 description");
  if (!/^body:\s*$/m.test(src)) errs.push("缺少 body");
  const typeCount = (src.match(/^\s*-\s*type:\s*\S+/gm) ?? []).length;
  if (typeCount === 0) errs.push("body 项缺少 type");
  check(id, `${file} 结构合法（body 项 ${typeCount}）`, errs.length === 0, errs.join("; "));
}
// config.yml 的 blank_issues_enabled
{
  const cfg = read(".github/ISSUE_TEMPLATE/config.yml");
  check("G3.3", "config.yml 声明 blank_issues_enabled", cfg !== undefined && /blank_issues_enabled:/.test(cfg));
}

// ───────────────────────── G4 Dependabot ─────────────────────────
console.log(`\nG4  Dependabot 配置`);
{
  const dep = read(".github/dependabot.yml");
  if (dep === undefined) {
    check("G4.1", "dependabot.yml 存在", false, "缺少 .github/dependabot.yml");
  } else {
    const errs = [];
    if (!/^version:\s*2\s*$/m.test(dep)) errs.push("version 必须为 2");
    if (!/^updates:\s*$/m.test(dep)) errs.push("缺少 updates");
    if (!/package-ecosystem:/.test(dep)) errs.push("缺少 package-ecosystem");
    if (!/directory:/.test(dep)) errs.push("缺少 directory");
    if (!/schedule:/.test(dep)) errs.push("缺少 schedule");
    check("G4.1", "dependabot.yml 结构合法", errs.length === 0, errs.join("; "));
    soft(
      "G4.2",
      "dependabot 只盯 github-actions（本插件零运行时依赖，符合项目定位）",
      /package-ecosystem:\s*github-actions/.test(dep) && !/package-ecosystem:\s*npm/.test(dep),
      "建议只保留 github-actions，避免给零依赖项目制造噪声",
    );
  }
}

// ───────────────────────── G5 CI 工作流 ─────────────────────────
console.log(`\nG5  CI 工作流（安全加固 + 接线）`);
{
  const ci = read(".github/workflows/ci.yml");
  if (ci === undefined) {
    check("G5.1", "ci.yml 存在", false);
  } else {
    check("G5.1", "ci.yml 声明最小权限 permissions", /^permissions:\s*$/m.test(ci) || /permissions:\s*contents:\s*read/.test(ci));
    check("G5.2", "CI 已接线 regression 套件", ci.includes("regression.mjs"));
    check("G5.3", "CI 已接线 scenarios 套件", ci.includes("scenarios.mjs"));
    check("G5.4", "CI 已接线文档存在性检查（TESTING/NORM-COMPLIANCE）", ci.includes("Docs present"));
    check("G5.5", "CI 已接线本脚本（github-meta 自检）", ci.includes("check-github-meta.mjs"));
  }

  // 发布工作流：可信发布（OIDC）的关键契约。这几条任何一条悄悄失效，
  // 后果都是「发布时才炸」—— 所以必须在离线自检里钉住。
  //
  // ⚠️ 断言前必须先剥掉整行注释：本工作流的注释里就写着 `id-token: write`
  // 和 registry.npmjs.org，直接对原文做正则会让检查恒真（变异测试抓到过）。
  const uncomment = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const pub = read(".github/workflows/publish.yml");
  if (pub === undefined) {
    check("G5.6", "publish.yml 存在（可信发布工作流）", false);
  } else {
    const code = uncomment(pub);
    check("G5.6", "publish.yml 声明 id-token: write（可信发布硬要求，缺了会 ENEEDAUTH）", /^\s*id-token:\s*write\s*$/m.test(code));
    check("G5.7", "publish.yml 由 Release 发布触发", /^\s*release:\s*$[\s\S]{0,80}?^\s*types:\s*\[published\]\s*$/m.test(code));
    check("G5.8", "publish.yml 指向官方 registry", /^\s*registry-url:\s*https:\/\/registry\.npmjs\.org\s*$/m.test(code));
    // 反向断言：不得注入长期 token。注意代码里本来就出现了这两个变量名
    // （那段是「确认未注入」的守卫步骤），所以要匹配「赋值为 GitHub secret」
    // 而不是「出现」。
    check(
      "G5.9",
      "publish.yml 未注入长期 token（可信发布用 OIDC，不得回退成 token）",
      !/NODE_AUTH_TOKEN:\s*\$\{\{/.test(code) && !/secrets\.\s*(NPM_TOKEN|NODE_AUTH_TOKEN)/.test(code),
    );
    check("G5.10", "publish.yml 发布前接线三套检查（失败即不发布）",
      /regression\.mjs/.test(code) && /scenarios\.mjs/.test(code) && /check-github-meta\.mjs/.test(code));
  }
}

// ───────────────────────── G6 占位符（仅提示） ─────────────────────────
console.log(`\nG6  占位符检查（未替换不判失败，但会挡住推送/链接）`);
{
  const filesToScan = [
    "package.json",
    "README.md",
    "DEVELOPING.md",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
  ];
  const hits = [];
  for (const f of filesToScan) {
    const src = read(f);
    if (src === undefined) continue;
    if (src.includes("<your-gh-user>")) hits.push(`${f}: <your-gh-user>`);
    if (/\bOWNER\/REPO\b/.test(src)) hits.push(`${f}: OWNER/REPO`);
  }
  soft(
    "G6.1",
    "仓库 URL 占位符已全部替换为真实用户名",
    hits.length === 0,
    hits.length ? `待替换 ${hits.length} 处 → ${hits.join("; ")}` : "",
  );
  soft(
    "G6.2",
    "SECURITY.md / CODE_OF_CONDUCT.md 的联系邮箱已填写",
    !/<!--\s*TODO/i.test((read("SECURITY.md") ?? "") + (read("CODE_OF_CONDUCT.md") ?? "")),
    "仍存在 TODO 联系邮箱占位（HTML 注释形式）",
  );
}

// ───────────────────────── G7 发布面精简（GitHub 版不堆长文） ─────────────────────────
console.log(`\nG7  发布面精简（对外版保持简短，长文留本地）`);
{
  const credits = read("CREDITS.md");
  if (credits === undefined) {
    check("G7.1", "CREDITS.md 存在", false);
  } else {
    const bytes = Buffer.byteLength(credits, "utf8");
    check(
      "G7.1",
      `CREDITS.md 保持精简（${bytes} bytes ≤ 6000）`,
      bytes <= 6000,
      `已 ${bytes} bytes：借鉴报告对外只做简要声明，实现级细节放源码注释`,
    );
  }

  // .local/ 必须被忽略——它是"留给自己看"的长文存放处，不得进 GitHub / npm
  const gi = read(".gitignore");
  check("G7.2", ".gitignore 忽略 .local/（本地长文不进仓库）", gi !== undefined && /^\.local\/$/m.test(gi));

  // 完整版是否在本地（新克隆的仓库天然没有，故只提示）
  soft(
    "G7.3",
    "本地保留完整版借鉴报告（.local/CREDITS-full.md）",
    read(".local/CREDITS-full.md") !== undefined,
    "新克隆环境下不存在属正常；完整版只留在本地 .local/，不进 git 历史",
  );
}

// ───────── 共用：对外仓库的文本文件清单（G8 / G9 复用） ─────────
// 本脚本自身以正则字面量描述这些模式，必然"自我命中"，故自排除。
const SELF_REL = "tools/check-github-meta.mjs";
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".local", "dist", "build", "out", ".pnpm-store", "tmp", ".tmp",
]);
const TEXT_EXT = new Set([
  ".md", ".markdown", ".json", ".yml", ".yaml", ".js", ".mjs", ".cjs", ".ts", ".mts",
  ".bat", ".cmd", ".ps1", ".sh", ".bash", ".txt", ".toml", ".ini", ".cfg", ".xml", ".html",
]);
/** 遍历仓库收集全部文本文件（跳过构建产物与 .local/——本机信息的唯一允许存放处）。 */
function collectTextFiles(dir) {
  const out = [];
  (function walk(d) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name));
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        if (dot > 0 && TEXT_EXT.has(e.name.slice(dot).toLowerCase())) out.push(join(d, e.name));
      }
    }
  })(dir);
  return out;
}

// ───────────────── G8 本机信息泄露（对外仓库不得含机器相关信息） ─────────────────
console.log(`\nG8  本机信息泄露检查（本仓库对外发布，任何文件都不得出现本机路径 / 用户名）`);
{
  const RULES = [
    {
      id: "G8.1",
      re: /(?<![A-Za-z])[A-Za-z]:[\\/]Users[\\/]/g,
      label: "无 Windows 用户目录绝对路径（…\\Users\\<用户名>）",
    },
    {
      id: "G8.2",
      re: /dsh-versions/g,
      label: "无本机 dsh 版本目录命名（dsh-versions）",
    },
    {
      id: "G8.3",
      re: /\bdshV\d+\b/g,
      label: "无本机环境目录名（dshV1、dshV2…）",
    },
    {
      id: "G8.4",
      re: /AIforworkbuddyIntel/g,
      label: "无本机工作区目录名",
    },
    {
      id: "G8.5",
      re: /\barnen\b(?!@)/g,
      label: "无本机用户名（只允许 arnen7000 / arnen@126.com）",
    },
    {
      id: "G8.6",
      re: /(?<![A-Za-z])[A-Za-z]:[\\/](?!(Users|Program Files|Windows))/g,
      label: "无盘符绝对路径（改用 <占位符> 或 %变量%）",
    },
    {
      // 本机 dsh 副本的私有数据目录命名。dsh 官方默认是 ~/.dsh；
      // 文档里出现私有命名会让「照抄命令」的读者装进不存在的路径。
      id: "G8.7",
      re: /\.dsh-home/g,
      label: "无本机专属的 dsh 数据目录命名（一律写 <你的 DSH_HOME> 或官方默认 ~/.dsh）",
    },
    {
      // 本机/本组织专属的包名，不得进入对外仓库：它既会让读者找不到，
      // 也会把内部项目结构暴露出去。涉及冲突时一律写通用表述。
      id: "G8.8",
      re: /dsh-workbuddy-(?!websearch\b|connect\b)[a-z0-9-]+/g,
      label: "无本机专属包名（只允许本仓库自身的 dsh-workbuddy-websearch 与可选增强 dsh-workbuddy-connect）",
    },
  ];

  const files = collectTextFiles(root);

  for (const { id, re, label } of RULES) {
    const hits = [];
    for (const abs of files) {
      const rel = abs.slice(root.length + 1).split("\\").join("/");
      if (rel === SELF_REL) continue;
      const lines = readFileSync(abs, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        // 显式豁免：合成测试路径等确非本机信息时，在该行加 `g8-ignore: <理由>`
        if (lines[i].includes("g8-ignore")) continue;
        re.lastIndex = 0;
        if (re.test(lines[i])) hits.push(`${rel}:${i + 1}`);
      }
    }
    check(
      id,
      label,
      hits.length === 0,
      hits.length ? `${hits.length} 处 → ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? " …" : ""}` : "",
    );
  }
}

// ─────────── G9 时间信息分级（对外仓库只留"基本时间信息"） ───────────
console.log(`\nG9  时间信息分级检查（日级 ISO 日期只允许出现在白名单里）`);
{
  // 白名单：与"开发过程"无关的客观事实日期。新增一条必须在此登记理由。
  const ALLOWED_DATES = new Map([
    ["2026-07-18", "WorkBuddy 鸿蒙版随 iOS/Android 上线的公开时间点（产品事实）"],
    ["2026-09-24", "搜索端点取证日期（技术事实，与开发环境无关）"],
  ]);
  // 只匹配"日级"日期；月级（2026-10）是允许的粒度，故不匹配。
  const DAY_LEVEL_DATE = /(?<!\d)(20\d\d)-(\d{2})-(\d{2})(?!\d)/g;

  const hits = [];
  const seen = new Map();
  for (const abs of collectTextFiles(root)) {
    const rel = abs.slice(root.length + 1).split("\\").join("/");
    if (rel === SELF_REL) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      // 显式豁免：确属必要的事实日期，在该行加 `g9-allow: <理由>`（可评审、可追溯）
      if (lines[i].includes("g9-allow")) continue;
      DAY_LEVEL_DATE.lastIndex = 0;
      for (const m of lines[i].matchAll(DAY_LEVEL_DATE)) {
        const iso = `${m[1]}-${m[2]}-${m[3]}`;
        if (ALLOWED_DATES.has(iso)) {
          seen.set(iso, (seen.get(iso) ?? 0) + 1);
          continue;
        }
        hits.push(`${rel}:${i + 1} (${iso})`);
      }
    }
  }
  check(
    "G9.1",
    `无开发/测试日志日期（日级 ISO 日期仅白名单 ${[...ALLOWED_DATES.keys()].join(" / ")} 允许）`,
    hits.length === 0,
    hits.length ? `${hits.length} 处 → ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? " …" : ""}` : "",
  );
  // 白名单里"登记了却没人用"的日期要提醒——防止白名单悄悄失效、长期无人维护。
  const unused = [...ALLOWED_DATES.keys()].filter((d) => !seen.has(d));
  soft(
    "G9.2",
    "白名单日期仍在使用（否则应删除登记）",
    unused.length === 0,
    unused.length ? `未被引用：${unused.join(", ")}` : "",
  );
}

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n=== 汇总 ===`);
console.log(`  PASS: ${pass}   FAIL: ${fail}   WARN: ${warn}`);
if (failures.length) {
  console.log(`\n失败项：`);
  for (const f of failures) console.log(`  - ${f}`);
}
if (warnings.length) {
  console.log(`\n提示项（不阻断）：`);
  for (const w of warnings) console.log(`  - ${w}`);
}
console.log("");
process.exit(fail === 0 ? 0 : 1);
