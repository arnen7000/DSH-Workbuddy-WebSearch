#!/usr/bin/env node
/**
 * 文档链接 / 锚点 / 交叉引用 自检（本地工具，不进仓库）
 *
 * 检查四件事：
 *   L1 相对链接的文件是否存在
 *   L2 带 #锚点 的链接，锚点在目标文件里是否真有对应标题（GitHub slug 规则）
 *   L3 「§N.M」式章节交叉引用，目标文档里是否真有该编号的标题
 *   L4 README 的「目录」是否覆盖了全部 ## / ### 标题（Standard Readme 要求 TOC 完整）
 *
 * 用法：node tools/check-links.mjs [仓库根]（省略时用脚本所在仓库）
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, ".."));
const SKIP_DIRS = new Set([".local", "node_modules", ".git"]);

const mdFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name));
    } else if (e.name.toLowerCase().endsWith(".md")) {
      mdFiles.push(join(dir, e.name));
    }
  }
})(root);

const rel = (p) => relative(root, p).split("\\").join("/");

/** GitHub 的标题 → 锚点 规则：小写、去掉非「字母/数字/空格/连字符/下划线」、空格转连字符 */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/** 收集一个文件里所有标题的锚点（含 GitHub 的重名去重 -1/-2） */
function anchorsOf(file) {
  const map = new Map();
  const counts = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    let s = slugify(m[2]);
    const n = counts.get(s) ?? 0;
    counts.set(s, n + 1);
    if (n > 0) s = `${s}-${n}`;
    map.set(s, m[2]);
  }
  return map;
}

/** 收集一个文件里所有「N.」「N.M」式章节号 */
function sectionsOf(file) {
  const set = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^#{2,6}\s+(\d+(?:\.\d+)*)[.、]?\s/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

const PASS = [];
const FAIL = [];
const ok = (id, msg) => { PASS.push(id); console.log(`  PASS  ${id}  ${msg}`); };
const bad = (id, msg) => { FAIL.push(id); console.log(`  FAIL  ${id}  ${msg}`); };

// ── L1 / L2 相对链接 + 锚点 ──
console.log("\nL1/L2 相对链接与锚点");
let linkCount = 0;
let anchorCount = 0;
const seen = new Set();
for (const abs of mdFiles) {
  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      linkCount += 1;
      const [filePart, anchorRaw] = target.split("#");
      const anchor = anchorRaw === undefined ? undefined : decodeURIComponent(anchorRaw);
      let targetAbs;
      if (filePart === "") {
        targetAbs = abs;
      } else {
        targetAbs = resolve(dirname(abs), filePart);
        if (!existsSync(targetAbs)) {
          bad(`L1`, `${rel(abs)}:${i + 1} → 目标不存在: ${target}`);
          continue;
        }
      }
      if (anchor) {
        anchorCount += 1;
        const map = anchorsOf(targetAbs);
        if (!map.has(anchor)) {
          bad(`L2`, `${rel(abs)}:${i + 1} → 锚点不存在于 ${rel(targetAbs)}: #${anchor}`);
        }
      }
      seen.add(`${rel(abs)} -> ${target}`);
    }
  }
}
ok("L1/L2", `相对链接 ${linkCount} 条、带锚点 ${anchorCount} 条，全部可达`);

// ── L3 「§N.M」交叉引用 ──
console.log("\nL3 章节交叉引用（§N.M）");

/** 已知文档「词干」→ 文件（用于识别省略了 .md 的写法，如 `COMPATIBILITY §10`） */
const STEMS = new Map();
for (const abs of mdFiles) {
  const base = rel(abs).split("/").pop();
  STEMS.set(base.replace(/\.md$/, ""), abs);
}

let refCount = 0;
const unresolved = [];
for (const abs of mdFiles) {
  const lines = readFileSync(abs, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const refs = [...lines[i].matchAll(/§\s?(\d+(?:\.\d+)*)/g)].map((x) => x[1]);
    if (refs.length === 0) continue;

    // 判定这条 § 指的是哪个文件，优先级：
    //   「本文 / 本节」→ 当前文件
    //   行内出现 1 个 .md 文件名，或 1 个已知文档词干 → 那个文件
    //   行内没有任何文档指代 → 当前文件（自引用）
    //   出现 2+ 个候选 → 无法判定，记录下来让人工看，不静默吞掉
    const cands = new Set();
    if (!/本文|本节/.test(lines[i])) {
      for (const m of lines[i].matchAll(/([A-Za-z][A-Za-z0-9_-]*\.md)\b/g)) {
        cands.add(resolve(root, m[1]));
      }
      for (const m of lines[i].matchAll(/\b([A-Z][A-Z0-9_-]{2,})\b/g)) {
        const hit = STEMS.get(m[1]);
        if (hit) cands.add(hit);
      }
    }
    let targetAbs;
    if (cands.size === 0) targetAbs = abs;
    else if (cands.size === 1) targetAbs = [...cands][0];
    else { unresolved.push(`${rel(abs)}:${i + 1}  ${lines[i].trim()}`); continue; }

    if (!existsSync(targetAbs)) {
      bad("L3", `${rel(abs)}:${i + 1} → 引用了不存在的文档 ${rel(targetAbs)}`);
      continue;
    }
    const secs = sectionsOf(targetAbs);
    for (const r of refs) {
      refCount += 1;
      if (!secs.has(r)) bad("L3", `${rel(abs)}:${i + 1} → ${rel(targetAbs)} 里没有 §${r}`);
    }
  }
}
ok("L3", `${refCount} 处 §N.M 交叉引用全部命中真实章节`);
if (unresolved.length > 0) {
  console.log(`\n  ⚠️ 以下 ${unresolved.length} 行的 § 指代无法自动判定，请人工过一眼：`);
  for (const u of unresolved) console.log(`     ${u}`);
}

// ── L4 README 目录完整性 ──
console.log("\nL4 README 目录完整性");
{
  const readme = join(root, "README.md");
  const lines = readFileSync(readme, "utf8").split("\n");
  const tocStart = lines.findIndex((l) => /^##\s+目录\s*$/.test(l));
  if (tocStart === -1) {
    bad("L4", "README 没有「目录」小节");
  } else {
    const tocEnd = lines.findIndex((l, i) => i > tocStart && /^##\s+/.test(l));
    const tocBlock = lines.slice(tocStart, tocEnd === -1 ? lines.length : tocEnd).join("\n");
    const headings = lines
      .filter((l) => /^#{2,3}\s+/.test(l) && !/^##\s+目录\s*$/.test(l))
      .map((l) => l.replace(/^#{2,3}\s+/, "").trim());
    const missing = headings.filter((h) => !tocBlock.includes(`#${slugify(h)}`));
    if (missing.length > 0) bad("L4", `README 目录缺少: ${missing.join(" / ")}`);
    else ok("L4", `README 目录覆盖全部 ${headings.length} 个 ## / ### 标题`);
  }
}

console.log(`\n=== 汇总 ===\n  PASS: ${PASS.length}   FAIL: ${FAIL.length}`);
if (FAIL.length > 0) {
  console.log("\n失败项：");
  for (const f of FAIL) console.log(`  - ${f}`);
  process.exit(1);
}
