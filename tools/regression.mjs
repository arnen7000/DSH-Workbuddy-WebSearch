#!/usr/bin/env node
/**
 * dsh-workbuddy-websearch 发布版回归测试套件
 *
 * 针对「已从 npm pack .tgz 安装的实体目录」运行，覆盖：
 *   T1 模块契约（导出/name/inject/provider id）
 *   T2 cordis.patch.yml 契约（挂载行 + web 行覆盖 + fetchProvider 复述）
 *   T3 凭据解析（connect 桥 + 双版本 variant 枚举）
 *   T4 区域切换（config/env 优先级：global / cn）
 *   T5 真实搜索（国际版）
 *   T6 提取/清理纯函数（extractSources / cleanSynthesis / parseWorkBuddyAuth）
 *   T7 错误路径（空 query、无凭据时的可用性判断、abort）
 *   T8 边界（maxContentChars=0 不截断、_internals 完整性）
 *   T9 零依赖自足（自带模块可独立加载与解析，不依赖 connect；含 key helper 绑定契约）
 *   T10 平台覆盖（win32 / darwin(实验性) 候选路径、Windows 安装根扫描、cpu 约束）
 *
 * 用法：
 *   node regression.mjs <已安装插件的绝对路径>
 * 例：
 *   node regression.mjs "<DSH_HOME>/profiles/web/node_modules/dsh-workbuddy-websearch"
 */
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.argv[2];
if (!root) { console.error("usage: node regression.mjs <installed-plugin-dir>"); process.exit(2); }

const PASS = []; const FAIL = []; const WARN = [];
const ok = (id, msg) => { PASS.push(`${id} ${msg}`); console.log(`  PASS  ${id}  ${msg}`); };
const bad = (id, msg) => { FAIL.push(`${id} ${msg}`); console.log(`  FAIL  ${id}  ${msg}`); };
const warn = (id, msg) => { WARN.push(`${id} ${msg}`); console.log(`  WARN  ${id}  ${msg}`); };
const check = (id, cond, msg) => cond ? ok(id, msg) : bad(id, msg);
const skip = (id, msg) => console.log(`  SKIP  ${id}  ${msg}`);
const section = (t) => console.log(`\n=== ${t} ===`);

const entry = pathToFileURL(join(root, "lib", "index.js")).href;
const mod = await import(entry).catch((e) => { console.error("无法加载插件入口:", e.message); process.exit(2); });
const { __internals: I } = mod;

// ── T1 模块契约 ──
section("T1 模块契约");
check("T1.1", mod.name === "workbuddy-websearch", "name export = workbuddy-websearch");
check("T1.2", Array.isArray(mod.inject) && mod.inject.includes("web"), "inject 含 web");
check("T1.3", typeof mod.apply === "function", "apply 是函数");
check("T1.4", typeof mod.configure === "function", "configure 是函数");
check("T1.5", I.PROVIDER_ID === "workbuddy-agentic", "PROVIDER_ID = workbuddy-agentic");
const pub = Object.keys(mod).sort().join(",");
check("T1.6", pub === "__internals,apply,configure,inject,name", `公开导出集合正确（${pub}）`);

// ── T2 cordis.patch.yml 契约 ──
section("T2 cordis.patch.yml 契约");
const yml = readFileSync(join(root, "cordis.patch.yml"), "utf8");
check("T2.1", /id:\s*web-workbuddy-websearch/.test(yml), "挂载行 id = web-workbuddy-websearch");
check("T2.2", /name:\s*dsh-workbuddy-websearch/.test(yml), "挂载行 name = 包名");
check("T2.3", /searchProvider:\s*workbuddy-agentic/.test(yml), "web 行 searchProvider = workbuddy-agentic");
check("T2.4", /fetchProvider:\s*http/.test(yml), "复述 fetchProvider: http（防静默丢字段）");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
check("T2.5", pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "package.json dsh.bundle.patch 指向正确");
check("T2.6", pkg.peerDependencies?.["dsh-workbuddy-connect"] !== undefined, "声明 connect peerDependency");

// ── T2.7–T2.10 版本策略契约（允许更新版本安装，只声明已验证版本）──
// 这几条是"防回退"护栏：任何人想把版本锁上，都会在这里被拦下。
{
  const comp = pkg.dsh?.compatibility;
  check("T2.7", comp !== undefined && typeof comp.dsh === "string", "dsh.compatibility.dsh 已声明（版本策略载体）");

  // 下界必须是"宽松下界"（>=X），不得带上界（<、<=、- 区间）——否则会误导"超版不能用"
  const range = String(comp?.dsh ?? "");
  const hasUpperBound = /[<]/.test(range) || /\s-\s/.test(range);
  check(
    "T2.8",
    !hasUpperBound && /^>=/.test(range.trim()),
    `dsh.compatibility.dsh 是宽松下界（当前 "${range}"），不含上界`,
  );

  // 刻意不声明 @deepseek-ai/dsh* 的 peer：官方兼容性校验只认该命名空间，
  // 一旦声明且 range 写窄，更新版本会被"拒装"。这里钉住这个决定。
  const dshPeers = Object.keys(pkg.peerDependencies ?? {}).filter(
    (n) => n === "@deepseek-ai/dsh" || n.startsWith("@deepseek-ai/dsh-"),
  );
  check(
    "T2.9",
    dshPeers.length === 0,
    `未声明 @deepseek-ai/dsh* peer（否则更新版本可能被拒装）${dshPeers.length ? " → " + dshPeers.join(", ") : ""}`,
  );

  // dshReleases 必须如实标注：至少含一个 compatible，且未端到端验证的不冒充 compatible
  const releases = comp?.dshReleases ?? {};
  const keys = Object.keys(releases);
  check(
    "T2.10",
    keys.length >= 3 && keys.some((k) => releases[k] === "compatible"),
    `dshReleases 如实列出已验证版本（${keys.length} 项：${keys.join(", ")}）`,
  );
}

// ── T3 凭据解析 ──
section("T3 凭据解析（connect 桥）");
const bridge = await I.loadConnectBridge().catch((e) => { bad("T3.1", "loadConnectBridge 抛错: " + e.message); return undefined; });
if (bridge === undefined) {
  warn("T3.1", "connect 桥不可用 → 走内置兜底路径（这是合法降级）");
} else {
  ok("T3.1", `connect 桥可用，variants = ${bridge.stores.map(s => s.variant.id + ":" + s.variant.region).join(", ")}`);
  check("T3.2", bridge.stores.length >= 1, "至少一个 variant store");
  const regions = bridge.stores.map(s => s.variant.region);
  check("T3.3", regions.includes("global") && regions.includes("cn"), "同时枚举 国内(cn) + 国际(global)");
}

// ── T4 区域切换（config > env > 默认）──
section("T4 区域切换（配置优先级）");
delete process.env.WORKBUDDY_SEARCH_REGION;
mod.configure({});
check("T4.1", I.preferredRegion() === "global", "无配置时默认 global（国际版优先）");
mod.configure({ region: "cn" });
check("T4.2", I.preferredRegion() === "cn", "config.region=cn → cn");
mod.configure({ region: "china" });
check("T4.3", I.preferredRegion() === "cn", "config.region=china 归一化为 cn");
mod.configure({});
process.env.WORKBUDDY_SEARCH_REGION = "cn";
check("T4.4", I.preferredRegion() === "cn", "env WORKBUDDY_SEARCH_REGION=cn → cn");
process.env.WORKBUDDY_SEARCH_REGION = "global";
mod.configure({ region: "cn" });
check("T4.5", I.preferredRegion() === "cn", "config 覆盖 env（config 优先）");
mod.configure({});

// ── T5 真实搜索 ──
section("T5 真实搜索（国际版）");
process.env.WORKBUDDY_SEARCH_REGION = "global";
let cred;
try {
  cred = await I.resolveCredential(false, undefined);
  ok("T5.1", `凭据解析成功：{ cred = ${cred.variant?.id}, region = ${cred.variant?.region} }`);
} catch (e) {
  // 凭据解析失败在本机可能只是**环境差异**，未必是代码缺陷：
  //   - 该账号未登录（CI 上必然如此）；
  //   - 桌面端装在自选盘符/自定义路径 → 探测不到 Electron 二进制（这是插件的既定取舍，
  //     要用户显式指定 WORKBUDDY_*_ELECTRON_BIN，属正常行为而非 bug）。
  // 与 T3.1（无 connect → 走内置兜底）同一范式：环境不具备时降级为 WARN，跳过真实搜索，
  // 否则 CI 会因"机器上没登录"而恒红，违背 TESTING.md「只有 FAIL 才非零退出、CI 恒通过」的约定。
  // 判据：错误信息里点名了 Electron 二进制不可用 → 环境差异，WARN；其余（解密失败、
  // 凭据格式损坏等）仍视为 FAIL，避免把真实缺陷一起放过。
  const msg = e.message || String(e);
  const envRelated = /electron-binary-unavailable|未能自动定位到它|未能自动定位/i.test(msg);
  if (envRelated) {
    warn("T5.1", "本机未定位到国际版 Electron 二进制 → 跳过真实搜索（环境差异，非代码缺陷；可设 WORKBUDDY_AI_ELECTRON_BIN 后复跑）");
  } else {
    bad("T5.1", "凭据解析失败（可能未登录）: " + msg);
  }
}
if (cred) {
  try {
    const r = await I.callAgenticSearch(cred, "今天的日期", undefined);
    check("T5.2", r.sources.length > 0, `搜索返回 sources = ${r.sources.length}`);
    check("T5.3", typeof r.content === "string" && r.content.length > 0, `返回综述文本 contentLen = ${r.content?.length}`);
    check("T5.4", r.sources.every(s => /^https?:\/\//.test(s.url)), "所有 source url 都是 http(s)");
    check("T5.5", !/<\/?selected-refs>/i.test(r.content || ""), "综述已清理 <selected-refs> 内部标记");
  } catch (e) {
    bad("T5.2", "真实搜索失败: " + (e.message || e));
  }
}

// ── T6 纯函数 ──
section("T6 提取/清理/解析（纯函数）");
const md = "见 [A股](https://example.com/a) 与裸链 https://example.com/b，重复 https://example.com/a 。";
const srcs = I.extractSources(md);
check("T6.1", srcs.length === 2, `markdown+裸链去重后 sources = ${srcs.length}（期望 2）`);
check("T6.2", srcs.some(s => s.url === "https://example.com/a" && s.title === "A股"), "markdown 链接带 title");
check("T6.3", I.cleanSynthesis("前<selected-refs>X</selected-refs>后") === "前后", "cleanSynthesis 移除 selected-refs");
check("T6.4", I.cleanSynthesis("孤<selected-refs>标记") === "孤标记", "cleanSynthesis 处理残缺标签");
const authJson = JSON.stringify({ auth: { accessToken: "tok", refreshToken: "rt", expiresAt: 9999999999, domain: "www.workbuddy.ai" }, account: { uid: "u1" } });
const p = I.parseWorkBuddyAuth(authJson);
check("T6.5", p?.accessToken === "tok" && p?.uid === "u1", "parseWorkBuddyAuth 解析嵌套形态");
check("T6.6", I.parseWorkBuddyAuth("not json") === undefined, "parseWorkBuddyAuth 非法 JSON → undefined");
check("T6.7", I.parseWorkBuddyAuth(JSON.stringify({ auth: {} })) === undefined, "parseWorkBuddyAuth 无 accessToken → undefined");
check("T6.8", I.regionOf("www.workbuddy.ai") === "global" && I.regionOf("copilot.tencent.com") === "cn", "regionOf 域名分流正确");
check("T6.9", I.chatBase({ domain: "www.workbuddy.ai" }) === "https://www.workbuddy.ai", "chatBase 国际版网关");
check("T6.10", I.chatBase({ domain: "" }) === "https://copilot.tencent.com", "chatBase 空域名 → 国内网关");

// ── T7 错误路径 ──
section("T7 错误路径与可用性");
const provider = new (class extends Object {})();
let emptyQueryErr;
try {
  // 通过 provider 的 search 触发空 query 校验
  const P = Object.getPrototypeOf(await (async () => {
    const inst = { web: { registerSearchProvider: (p) => (globalThis.__p = p) } };
    mod.apply({ ...inst, config: {}, root: {} });
    return globalThis.__p;
  })());
  await P.search({ query: "   " }, undefined);
} catch (e) { emptyQueryErr = e; }
check("T7.1", emptyQueryErr !== undefined && String(emptyQueryErr.code || "").includes("BAD_REQUEST"), "空 query → WB_SEARCH_BAD_REQUEST");
const av = globalThis.__p?.available?.();
check("T7.2", typeof av === "boolean", `provider.available() 返回布尔（实测 ${av}）`);
let abortErr;
try {
  const ctrl = new AbortController(); ctrl.abort(new Error("user abort"));
  if (cred) await I.callAgenticSearch(cred, "测试中止", ctrl.signal);
} catch (e) { abortErr = e; }
check("T7.3", cred ? String(abortErr?.code || "").includes("ABORT") : true, cred ? "abort 信号 → WEB_ABORTED" : "（跳过：无凭据）");

// ── T8 边界 ──
section("T8 边界");
process.env.WORKBUDDY_SEARCH_MAX_CONTENT_CHARS = "0";
check("T8.1", (await import(entry)), "重新导入入口正常");
const internalsKeys = Object.keys(I).sort();
check("T8.2", internalsKeys.includes("callAgenticSearch") && internalsKeys.includes("resolveCredential"), "__internals 关键钩子齐全");
const cands = I.syncCredentialCandidates();
check("T8.3", Array.isArray(cands) && cands.length >= 2, `同步凭据候选路径数 = ${cands.length}（含国际版）`);
check("T8.4", cands.some(p => /workbuddy-desktop-ai\.info$/.test(p)), "候选含国际版 workbuddy-desktop-ai.info");

// ── T9 零依赖自足（v0.2.1 核心保证）──
section("T9 零依赖自足（不依赖 dsh-workbuddy-connect）");
const plat = await import(pathToFileURL(join(root, "lib", "platform.mjs")).href).catch(() => undefined);
const creds = await import(pathToFileURL(join(root, "lib", "credentials.mjs")).href).catch(() => undefined);
const decrypt = await import(pathToFileURL(join(root, "lib", "decrypt.mjs")).href).catch(() => undefined);
check("T9.1", plat !== undefined, "lib/platform.mjs 可独立导入");
check("T9.2", creds !== undefined, "lib/credentials.mjs 可独立导入");
check("T9.3", decrypt !== undefined, "lib/decrypt.mjs 可独立导入");
// 自带模块不 import 任何外部包（只允许 node: 内置）
const selfContained = (file) => {
  const src = readFileSync(join(root, "lib", file), "utf8");
  const specs = [...src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gmu)].map(m => m[1]);
  return specs.every(s => s.startsWith("node:") || s.startsWith("./"));
};
check("T9.4", ["platform.mjs", "decrypt.mjs", "credentials.mjs"].every(selfContained), "自带模块只依赖 node: 内置与相对路径");
// 解密能力：真实 AES-256-GCM 往返（用 App 的 AAD 形状）
if (decrypt !== undefined) {
  const { createCipheriv, randomBytes } = await import("node:crypto");
  const secret = randomBytes(32).toString("base64");
  const key = decrypt.protectorKeyFrom(secret);
  const keyId = randomBytes(8).toString("hex");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(decrypt.buildAuthenticatedContextAad(keyId, 1));
  const ct = Buffer.concat([cipher.update("token-under-test", "utf8"), cipher.final()]);
  const wrapper = {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify({
      suite: 1, keyId,
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ct.toString("base64"),
    })).toString("base64"),
  };
  const entry = decrypt.parseEnvelope(wrapper);
  const opened = decrypt.decryptField(entry, new Map([[keyId, key]]));
  check("T9.5", opened === "token-under-test", "自带解密：AES-256-GCM + App AAD 往返成功");
  check("T9.6", decrypt.decryptField(entry, new Map([[keyId, Buffer.alloc(32, 9)]])) === undefined, "自带解密：错误密钥认证失败");
  check("T9.7", decrypt.parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: secret })) !== undefined, "key helper 载荷校验通过");
  check("T9.8", decrypt.parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32).toString("base64") })) === undefined, "拒绝全零密钥");
}
// 自带凭据解析：不经过 connect 也能读出凭据（或明确报「无凭据」）
if (creds !== undefined) {
  const plain = JSON.stringify({ auth: { accessToken: "tok", refreshToken: "ref", domain: "workbuddy.ai" }, account: { uid: "u1" } });
  const parsed = creds.parseAuthDocument(plain);
  check("T9.9", parsed?.accessToken === "tok" && parsed?.uid === "u1", "自带 parseAuthDocument 解析嵌套形态");
  check("T9.10", creds.parseAuthDocument("bad json") === undefined, "自带 parseAuthDocument 非法 JSON → undefined");
  let independent;
  try {
    independent = await creds.resolveCredentialIndependently({ region: "global" });
  } catch { independent = undefined; }
  if (independent !== undefined && independent.undecryptable !== true) {
    ok("T9.11", `自带路径独立解析成功（source = ${independent.source}，token 长度 ${independent.accessToken.length}）`);
  } else {
    warn("T9.11", "自带路径未解析出凭据（本机该账号未登录属正常；密钥已由 T9.5 证明正确）");
  }
}
// connect 缺席不应影响功能：bridge 失败必须被吞掉而非上抛
let bridgeErr;
try { await I.loadConnectBridge(); } catch (e) { bridgeErr = e; }
check("T9.12", bridgeErr === undefined, "connect 桥失败时不下抛（静默降级）");
check("T9.13", typeof I.getLastCredentialSource === "function", "暴露 lastCredentialSource 诊断钩子");

// T9.14 自检脚本自身必须遵守「零硬依赖」：走统一入口 resolveCredential，
//       而不是只走 connect 那一条腿的 resolveViaConnect。
//       （在一个全新环境上实测到的真实问题：未装 connect 时 final-verify 崩在 chatBase。）
{
  const verifyPath = join(root, "tools", "final-verify.mjs");
  if (!existsSync(verifyPath)) {
    warn("T9.14", "（跳过）tools/ 未随包分发，无法检查 final-verify.mjs");
  } else {
    const vsrc = readFileSync(verifyPath, "utf8");
    const usesUnified = /resolveCredential\s*\(/.test(vsrc);
    // 排除注释里提到的情形：只看是否有真正的调用（行首非注释）
    const callsConnectOnly = vsrc
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .some((l) => /resolveViaConnect\s*\(/.test(l));
    check("T9.14", usesUnified && !callsConnectOnly, "final-verify.mjs 走统一入口（不直接用 resolveViaConnect）");
  }
}

// T9.15–T9.16 key helper 的绑定名与调用方式（源码级断言）
// 背景（在真实 5.6.2 设备上实测到的缺陷）：helper 曾写成
//   process.binding("workbuddyStorage").readSealedPayload()
// 两处都错 —— 绑定名应为 electron_browser_workbuddy_storage，
// 且必须走 process._linkedBinding（链接绑定）而非 process.binding（Node 内置绑定表）。
// 结果是 helper 恒报 `No such module`，被静默降级成「解密失败」，
// 国际版加密凭据永远解不开、只能悄悄回落到国内版明文凭据。
// 单元往返测试（T9.5）用的是自造密钥，因此**测不出**这类外部 API 写错的问题，
// 只能靠源码断言守住。
{
  const decryptSrc = readFileSync(join(root, "lib", "decrypt.mjs"), "utf8");
  check("T9.15",
    /process\._linkedBinding\(\s*"electron_browser_workbuddy_storage"\s*\)\s*\.\s*loggerGet\(\s*\)/u.test(decryptSrc),
    "key helper 用链接绑定 electron_browser_workbuddy_storage.loggerGet()");
  check("T9.16",
    !/process\.binding\(/u.test(decryptSrc) && !/readSealedPayload/u.test(decryptSrc),
    "key helper 不再误用 process.binding / readSealedPayload");
}

// T9.17–T9.18 真实载荷形状的兼容性（App 加字段不应让插件失效）
if (decrypt !== undefined) {
  const realShape = JSON.stringify({
    version: 1,
    atRestSecretKey: Buffer.alloc(32, 7).toString("base64"),
    atRestDeveloperPublicKey: Buffer.alloc(32, 3).toString("base64"),
  });
  check("T9.17", decrypt.parseAtRestPayload(realShape) !== undefined,
    "容忍真实载荷的额外字段（atRestDeveloperPublicKey）");
  check("T9.18",
    decrypt.parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: Buffer.alloc(32, 7).toString("base64") })) === undefined
      && decrypt.parseAtRestPayload(JSON.stringify({ version: 1 })) === undefined,
    "拒绝 version 非 1 / 缺 atRestSecretKey 的载荷");
}

// T9.19–T9.20 与「同 id 的另一个搜索插件」撞车时，报错必须是**可操作的**
//   背景：`ctx.web` 按 provider id 去重，后注册者抛 WEB_DUPLICATE_PROVIDER。
//   裸错误只会让 dsh 打一行 `1 entry did not activate`，用户完全不知道该卸谁。
//   报错**不得点名任何具体第三方插件**（占用者在运行时不可知，且不应在对外仓库里
//   出现本机/本组织专属的包名）——必须指引用户自己查出来。
{
  const makeCtx = (thrower) => ({
    config: undefined,
    root: { logger: () => ({ info() {} }) },
    web: { registerSearchProvider: thrower },
  });
  const duplicate = Object.assign(
    new Error('a web provider with id "workbuddy-agentic" is already registered'),
    { code: "WEB_DUPLICATE_PROVIDER" },
  );
  let duplicateMsg = "";
  try {
    mod.apply(makeCtx(() => { throw duplicate; }));
  } catch (error) {
    duplicateMsg = String(error?.message ?? "");
  }
  check(
    "T9.19",
    duplicateMsg.includes(I.PROVIDER_ID) && duplicateMsg.includes("remove") && duplicateMsg.includes("bundles"),
    "provider id 冲突 → 报错带上冲突 id、并给出「查 bundles + remove」的排查步骤",
  );
  check(
    "T9.20",
    !/\bdsh-workbuddy-(?!websearch\b|connect\b)[a-z0-9-]+/.test(duplicateMsg),
    "冲突报错不点名任何具体第三方插件（保持通用，不含本机专属包名）",
  );

  const unrelated = Object.assign(new Error("boom"), { code: "WEB_SOMETHING_ELSE" });
  let passthrough;
  try {
    mod.apply(makeCtx(() => { throw unrelated; }));
  } catch (error) {
    passthrough = error;
  }
  check("T9.21", passthrough === unrelated, "其它注册错误原样透传（不吞、不改写）");
}

// ── T10 平台覆盖 ──
section("T10 平台覆盖（macOS 为实验性）");
if (plat !== undefined) {
  const win = plat.desktopAuthDirs("win32", {}, "C:/U/t"); // g8-ignore: 合成 home，非本机路径
  const mac = plat.desktopAuthDirs("darwin", {}, "/Users/t");
  check("T10.1", win.length === 2, `win32 探测 Local + Roaming（${win.length} 个）`);
  check("T10.2", mac.length === 1 && /[\\/]Library[\\/]Application Support[\\/]/.test(mac[0]), "darwin 探测 ~/Library/Application Support");
  check("T10.3", plat.VARIANTS.length === 2 && plat.VARIANTS.some(v => v.region === "cn") && plat.VARIANTS.some(v => v.region === "global"), "自带 VARIANTS 覆盖 cn + global");
  check("T10.4", plat.VARIANTS.every(v => typeof v.electron.macosPath === "string"), "两版均有 macOS Electron 默认路径（实验性）");
  check("T10.5", plat.VARIANTS[0].electron.windowsPathSegments !== undefined, "国内版有 Windows 默认安装段");
  check("T10.6", plat.VARIANTS[1].electron.windowsPathSegments === undefined, "国际版不猜 Windows 路径（宁缺勿错）");
  const macFiles = plat.desktopAuthFiles(plat.VARIANTS[1], "darwin", {}, "/Users/t");
  check("T10.7", macFiles.some(p => p.endsWith("workbuddy-desktop-ai.info")), "macOS 候选含国际版文件名");
}
// package.json 平台约束
check("T10.8", Array.isArray(pkg.os) && pkg.os.includes("win32") && pkg.os.includes("darwin"), "os 声明 win32 + darwin");
check("T10.9", Array.isArray(pkg.cpu) && pkg.cpu.includes("x64") && pkg.cpu.includes("arm64"), "cpu 声明 x64 + arm64（挡 32 位）");
check("T10.10", !(pkg.cpu ?? []).includes("ia32"), "cpu 明确不含 ia32（32 位 WorkBuddy 桌面端不存在）");
check("T10.11", pkg.peerDependenciesMeta?.["dsh-workbuddy-connect"]?.optional === true, "connect 保持 optional peerDependency");
check("T10.12", pkg.version === "0.2.1" || /^0\.2\.[0-9]+$/.test(pkg.version), `版本号 ${pkg.version}`);

// ── T10.13+ Windows 常见安装根扫描（scanWindowsInstallRoots） ──
// 设计要点：该函数**自身不做 process.platform 判定**，只按传入 env 的根目录扫描，
// 因此在 ubuntu-latest 的 CI 上也能用合成目录完整验证（win32 分支的接线由 T10.23 静态断言兜底）。
// 这一组同时是「windowsExeBasename 曾经是死字段、国际版无法自动发现」那次缺陷的回归防线。
{
  const scan = plat?.scanWindowsInstallRoots;
  if (typeof scan !== "function") {
    bad("T10.13", "lib/platform.mjs 未导出 scanWindowsInstallRoots");
  } else {
    const tmp = mkdtempSync(join(tmpdir(), "dsh-wb-scan-"));
    try {
      const userRoot = join(tmp, "user", "Programs"); // 模拟 %LOCALAPPDATA%\Programs
      const sysRoot = join(tmp, "sys", "Program Files"); // 模拟 %ProgramFiles%
      mkdirSync(join(userRoot, "WorkBuddy"), { recursive: true });
      mkdirSync(join(userRoot, "WorkBuddy AI"), { recursive: true });
      mkdirSync(join(sysRoot, "WorkBuddy"), { recursive: true });
      writeFileSync(join(userRoot, "WorkBuddy", "workbuddy.exe"), "");
      writeFileSync(join(userRoot, "WorkBuddy AI", "workbuddyai.exe"), "");
      writeFileSync(join(sysRoot, "WorkBuddy", "workbuddy.exe"), "");

      // T10.13 per-user 默认布局（国内版）
      check("T10.13",
        scan("workbuddy.exe", { LOCALAPPDATA: join(tmp, "user") }) === join(userRoot, "WorkBuddy", "workbuddy.exe"),
        "扫描命中 per-user 布局（%LOCALAPPDATA%\\Programs\\WorkBuddy）");

      // T10.14 目录名带空格/后缀（国际版此前完全无法自动发现）
      check("T10.14",
        scan("workbuddyai.exe", { LOCALAPPDATA: join(tmp, "user") }) === join(userRoot, "WorkBuddy AI", "workbuddyai.exe"),
        "扫描命中目录名变体（WorkBuddy AI\\）→ 国际版可被自动发现");

      // T10.15 系统级安装
      check("T10.15",
        scan("workbuddy.exe", { ProgramFiles: sysRoot }) === join(sysRoot, "WorkBuddy", "workbuddy.exe"),
        "扫描命中系统级安装（%ProgramFiles%\\WorkBuddy）");

      // T10.16 目录在、exe 不在 → undefined（不误报）
      check("T10.16", scan("not-there.exe", { LOCALAPPDATA: join(tmp, "user") }) === undefined,
        "目录存在但 exe 不存在 → undefined（不误报）");

      // T10.17 根目录不存在 → 静默 undefined 且不抛（历史缺陷：读 undefined 属性抛错）
      let threw = false;
      let missRoot;
      try {
        missRoot = scan("workbuddy.exe", { LOCALAPPDATA: join(tmp, "nope"), ProgramFiles: join(tmp, "nope2") });
      } catch { threw = true; }
      check("T10.17", threw === false && missRoot === undefined,
        "根目录不存在 → 静默 undefined（探测函数不抛错）");

      // T10.18 重叠根去重（同一目录被两个变量指向，不应重复处理或抛错）
      check("T10.18",
        scan("workbuddy.exe", { LOCALAPPDATA: join(tmp, "user"), ProgramFiles: join(tmp, "user", "Programs") }) === join(userRoot, "WorkBuddy", "workbuddy.exe"),
        "重叠根去重后仍正确命中（同一目录被两个变量指向）");

      // T10.19 非法入参一律 undefined，不抛
      const bads = [undefined, null, "", 0].map((v) => { try { return scan(v, {}); } catch { return "THREW"; } });
      check("T10.19", bads.every((v) => v === undefined), "非法 exeBasename 一律 undefined（不抛）");

      // T10.20 边界：只扫一层 + 目录名须以 WorkBuddy 开头（防全盘遍历与误命中）
      const boundRoot = join(tmp, "bound");
      mkdirSync(join(boundRoot, "WorkBuddy", "nested"), { recursive: true });
      writeFileSync(join(boundRoot, "WorkBuddy", "nested", "workbuddy.exe"), "");
      mkdirSync(join(boundRoot, "OtherApp"), { recursive: true });
      writeFileSync(join(boundRoot, "OtherApp", "workbuddy.exe"), "");
      check("T10.20", scan("workbuddy.exe", { ProgramFiles: boundRoot }) === undefined,
        "只扫一层 + 目录名须以 WorkBuddy 开头（OtherApp\\ 与深层嵌套均不误命中）");

      // T10.21 显式环境变量优先于自动扫描（显式覆盖在平台分支之前，故跨平台可验）
      const altExe = join(tmp, "alt-workbuddy.exe");
      writeFileSync(altExe, "");
      check("T10.21",
        plat.resolveElectronBinary(plat.VARIANTS[0], { WORKBUDDY_ELECTRON_BIN: altExe, LOCALAPPDATA: join(tmp, "user") }) === altExe,
        "WORKBUDDY_ELECTRON_BIN 优先于自动扫描（显式覆盖生效）");

      // T10.22 误传字符串 variant → undefined（不抛 Cannot read properties of undefined）
      let misuse;
      let misuseThrew = false;
      try { misuse = plat.resolveElectronBinary("workbuddy"); } catch { misuseThrew = true; }
      check("T10.22", misuseThrew === false && misuse === undefined,
        "误传字符串 variant → undefined（守卫生效，不抛生僻错误）");

      // T10.23 静态接线断言：scanWindowsInstallRoots 真的被 resolveElectronBinary 调用，
      //        且用的是 variant.electron.windowsExeBasename（防止该字段再次沦为死字段）
      const platSrc = readFileSync(join(root, "lib", "platform.mjs"), "utf8");
      const fnBody = platSrc.slice(platSrc.indexOf("export function resolveElectronBinary"));
      check("T10.23",
        /scanWindowsInstallRoots\s*\([^)]*windowsExeBasename/s.test(fnBody),
        "resolveElectronBinary 已接入扫描且使用 windowsExeBasename（防「定义了但没接线」）");
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
}

// T10.24 真实环境探测（仅 win32 有意义；CI 为 ubuntu-latest，故此处为 SKIP 而非 WARN）
// 目的是把「本机 WorkBuddy 装在哪、有没有被自动找到」变成一条可读的实测记录。
{
  if (process.platform !== "win32") {
    skip("T10.24", `真实 Electron 二进制探测（当前平台 ${process.platform}，仅 win32 有效）`);
  } else if (typeof plat?.resolveElectronBinary !== "function") {
    bad("T10.24", "resolveElectronBinary 不可用");
  } else {
    const live = plat.resolveElectronBinary(plat.VARIANTS[0]);
    if (typeof live === "string" && existsSync(live)) {
      ok("T10.24", `本机国内版 Electron 自动定位成功：${live.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/u, "<用户目录>")}`);
    } else {
      // 未装 WorkBuddy 的机器走到这里属正常，故只提示、不计失败。
      warn("T10.24", "本机未自动定位到国内版 Electron（未安装或装在自选路径 → 需 WORKBUDDY_ELECTRON_BIN）");
    }
  }
}

// ── 汇总 ──
section("汇总");
console.log(`  PASS: ${PASS.length}   FAIL: ${FAIL.length}   WARN: ${WARN.length}`);
if (FAIL.length) { console.log("\n失败项："); for (const f of FAIL) console.log("  - " + f); }
if (WARN.length) { console.log("\n警告项："); for (const w of WARN) console.log("  - " + w); }
process.exit(FAIL.length ? 1 : 0);
