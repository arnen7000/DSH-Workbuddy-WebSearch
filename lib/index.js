/**
 * dsh-workbuddy-websearch
 *
 * 把 WorkBuddy 桌面 App 的网络搜索服务（云端 agenttool `/agenttool/v1/agentic_search`，
 * SSE 流式接口）接入 DeepSeek Harness 的 web 搜索接缝（`ctx.web`），使 dsh 内置的
 * `web_search` 工具通过 WorkBuddy 的积分套餐登录态完成联网搜索。
 *
 * 端点取证来源（2026-09-24）：
 * - WorkBuddy 桌面 App `app.asar`
 *   `packages/workbuddy-server/src/mcp/builtin-tools/tools/agentic-search-tool.ts`：
 *   `POST {endpoint}/agenttool/v1/agentic_search`，body
 *   `{query, search_mode: 2, stream: true, biz_via}`，鉴权 `Authorization: Bearer <token>`；
 *   SSE `done` 事件携带 `synthesis.content`（带引用的综述文本）。
 * - 搜索接缝契约：`@deepseek-ai/dsh-web` 的 `ctx.web.registerSearchProvider(provider)`，
 *   provider 为 `{id, available(), search(request, signal)}`，
 *   返回 `{content?, sources:[{url,title?,snippet?,publishedAt?}], truncated}`。
 *
 * 凭据策略（v0.2.1，**零硬依赖**）：
 *
 * 本插件**不依赖任何其他 dsh 插件**即可完整工作：
 * - 自带平台定位（`lib/platform.mjs`）：Windows / macOS(实验性) / Linux(实验性) 的
 *   WorkBuddy 桌面端 auth 目录与 Electron 二进制发现。
 * - 自带解密（`lib/decrypt.mjs`）：独立解开 5.6+ 桌面端的 `$wbEncrypted` 信封
 *   （用 App 自身的 Electron 跑 key helper），覆盖国内版与国际版。
 * - 自带读取（`lib/credentials.mjs`）：统一「明文 / 加密」「国内版 / 国际版」。
 *
 * `dsh-workbuddy-connect` 是**可选增强**，不是前置条件：
 * - 装了它 → 优先复用它的 `WorkBuddyCredentialStore`（对罕见落盘形态与刷新
 *   时序的兼容更完整）。它抛错时自动降级到自带路径，不会让搜索失效。
 * - 没装它 → 全程走自带路径，功能完整（这是 v0.2.1 相对于 v0.2.0 的关键改进）。
 *
 * 区域策略（v0.3.0，对齐 `dsh-workbuddy-connect` 的「拒绝混用」取向）：
 *
 * 国内版（WorkBuddy）与国际版（WorkBuddy AI）是**两套账号、两套积分**，
 * 两版 App 甚至可以把凭据写进同一个目录。因此本插件：
 * - 只注册**一个** provider，并在首次使用时**绑定其中一版**，整个会话不再改变；
 * - 只读取**被绑定那一版**的凭据路径，绝不跨版回落 —— 否则用户以为在扣国际版
 *   额度、实际扣了国内版，那是账务上的意外，不是容错；
 * - 读到属于另一版的凭据时**明确报错**（`WB_SEARCH_CREDENTIAL_REGION_MISMATCH`），
 *   而不是静默换账号。
 *
 * `region` 取 `auto`（默认）/ `global` / `cn`：`auto` 选**实际可用的那一版**，
 * 两版都可用时按 `AUTO_REGION_ORDER` 取舍（见该常量的说明）。
 *
 * 平台与版本适用范围见仓库根目录 `COMPATIBILITY.md`。
 *
 * @module dsh-workbuddy-websearch
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  VARIANTS,
  ENV_AUTH_FILE_CN,
  ENV_ELECTRON_BIN_CN,
  ENV_ELECTRON_BIN_AI,
  desktopAuthFiles,
  resolveElectronBinary,
  scanWindowsInstallRoots,
  findElectronFromMacosBundles,
  resolveElectronFromMacosDiscovery,
  resetMacosDiscoveryCache,
  MDFIND_BIN,
  PLUTIL_BIN,
} from "./platform.mjs";
import {
  parseAuthDocument,
  parseAuthFileSync,
  probeAuthFileSync,
  readCredentialFile,
  resolveCredentialForVariant,
  resolveCredentialIndependently,
  credentialPaths,
  credentialPathsForVariant,
  regionMismatch,
} from "./credentials.mjs";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "workbuddy-websearch";
/** 依赖的服务接缝：web 搜索/抓取能力（@deepseek-ai/dsh-web）。 */
export const inject = ["web"];

/** 本 provider 在 ctx.web 里的稳定 id（也写进 cordis.patch.yml 的 web 行）。 */
const PROVIDER_ID = "workbuddy-agentic";
/** WorkBuddy 国内版聊天/agenttool 网关。 */
const CN_CHAT_BASE = "https://copilot.tencent.com";
/** WorkBuddy 国际版网关。 */
const GLOBAL_BASE = "https://www.workbuddy.ai";
/** 云端 agentic 搜索端点（桌面 App 同款路径）。 */
const SEARCH_PATH = "/agenttool/v1/agentic_search";
/** token 刷新端点（与 dsh-workbuddy-connect 相同）。 */
const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
/** search_mode 固定 PRO（proto 枚举值 2，桌面 App 同款）。 */
const DEFAULT_SEARCH_MODE = 2;
/** SSE 整体兜底超时；服务端会主动关流，这里只是防 hang。 */
const SSE_TIMEOUT_MS = 300_000;
/** 单次 JSON 请求（刷新）超时。 */
const JSON_TIMEOUT_MS = 30_000;
/** 综述文本回传给模型的最大字符数；0 = 不截断。 */
const DEFAULT_MAX_CONTENT_CHARS = 30_000;
/** 从综述里最多提取多少个来源链接。 */
const MAX_SOURCES = 20;
/** 请求头上的 UA（探针实测可用）。 */
const USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";

// ─────────────────────────── 配置（cordis config + 环境变量） ───────────────────────────

/**
 * 运行时配置。来源优先级：cordis config（写进 profile 的 cordis.patch.yml，
 * 随 profile 持久化）> 环境变量 > 内置默认。
 *
 * 之所以支持 config：环境变量依赖启动脚本（dsh.bat 等），而这些脚本可能被
 * DSH 管理器重新生成而覆盖；写进 profile YAML 的配置则不受影响。
 */
let runtimeConfig = {};

/** 由 apply(ctx) 在插件启动时注入 ctx.config。 */
export function configure(config) {
  runtimeConfig = (typeof config === "object" && config !== null) ? config : {};
}

function configString(key) {
  const value = runtimeConfig[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function envString(key) {
  const value = process.env[key];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/** config > env 的字符串取值。 */
function settingString(configKey, envKey) {
  return configString(configKey) ?? envString(envKey);
}

function envNumber(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const searchMode = () => envNumber("WORKBUDDY_SEARCH_MODE", DEFAULT_SEARCH_MODE);
const maxContentChars = () => envNumber("WORKBUDDY_SEARCH_MAX_CONTENT_CHARS", DEFAULT_MAX_CONTENT_CHARS);
const endpointOverride = () => settingString("endpoint", "WORKBUDDY_SEARCH_ENDPOINT")?.replace(/\/+$/, "");

/**
 * 桌面端 Electron 二进制路径覆盖（解密加密凭据所需）。
 * 对国际版尤其重要：其变体没有 defaultPathSegments，自动发现依赖注册表。
 */
const electronBinOverride = (region) => (region === "global"
  ? settingString("aiElectronBin", "WORKBUDDY_AI_ELECTRON_BIN")
  : settingString("cnElectronBin", "WORKBUDDY_ELECTRON_BIN"));

// ──────────── 凭据来源：自带实现为主，dsh-workbuddy-connect 为可选增强 ────────────

/**
 * 本插件是否需要 connect？**不需要**。
 *
 * 下面这层 bridge 的定位是「锦上添花」：如果环境里恰好装了
 * dsh-workbuddy-connect，就复用它久经验证的 WorkBuddyCredentialStore
 * （对刷新时序、罕见落盘形态的兼容更完整）；装不上、加载失败、或它
 * 内部抛错，一律**静默降级**到自带实现，用户无需任何配置。
 *
 * 因此：`lastConnectError` 只用于诊断输出，绝不作为功能可用性的判据。
 */
let lastConnectError;
/** 最近一次实际生效的凭据来源（"connect" | "builtin"），供诊断输出。 */
let lastCredentialSource;

/**
 * 懒加载 dsh-workbuddy-connect（纯可选）。
 *
 * 加载顺序（重要）：本插件常以 symlink 方式装进 profile，Node 会按**真实路径**
 * 解析依赖，此时 `import("dsh-workbuddy-connect")` 可能找不到包。因此：
 *   1) 先试裸包名 import（同一 node_modules 树时最快）；
 *   2) 失败则按绝对路径从 DSH_HOME 的 profile node_modules 直接加载 connect 入口。
 *
 * 两路都失败是**正常情况**（用户没装 connect），返回 undefined 即可。
 */
async function importConnectModule() {
  // 1) 裸包名（正常工作流）
  try {
    return await import("dsh-workbuddy-connect");
  } catch {}
  // 2) 绝对路径兜底：<dsh-home>/profiles/<profile>/node_modules/dsh-workbuddy-connect
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profile = process.env.DSH_PROFILE ?? "web";
  const roots = [
    join(dshHome, "profiles", profile, "node_modules", "dsh-workbuddy-connect"),
    join(dshHome, "node_modules", "dsh-workbuddy-connect"),
  ];
  for (const root of roots) {
    for (const entry of ["lib/index.js", "index.js"]) {
      const target = join(root, entry);
      if (!existsSync(target)) continue;
      try {
        const url = pathToFileURL(target).href;
        return await import(url);
      } catch {}
    }
  }
  return undefined;
}

/**
 * 构建 connect bridge。**任何一步失败都返回 undefined，不抛错**——
 * 这是「有它没它都能用」的实现要点。
 *
 * 返回 `{ stores: [{variant, store}], hasRefresh }`。
 */
async function buildConnectBridge() {
  try {
    const mod = await importConnectModule();
    if (mod === undefined) {
      lastConnectError = new Error("dsh-workbuddy-connect 未安装（可选依赖，缺失不影响功能）");
      return undefined;
    }
    const { WorkBuddyCredentialStore, WORKBUDDY_VARIANTS, WorkBuddyUpstreamClient } = mod;
    if (typeof WorkBuddyCredentialStore !== "function") {
      lastConnectError = new Error(
        `dsh-workbuddy-connect 未导出 WorkBuddyCredentialStore（实际导出: ${Object.keys(mod).slice(0, 8).join(",")}…）`,
      );
      return undefined;
    }
    // connect 的变体定义优先（它的字段更全）；拿不到则退回本插件自带的等价定义。
    const variants = Array.isArray(WORKBUDDY_VARIANTS) && WORKBUDDY_VARIANTS.length > 0
      ? WORKBUDDY_VARIANTS
      : VARIANTS;
    // 注入 refresh 回调：store 在 token 临近过期（<5 分钟）时会调用它续期。
    // 复用 connect 自带的上游客户端，保证与插件其余部分完全一致的请求形状
    // （含国内版/国际版网关分流）。取不到客户端时退化为「不自动续期」。
    const upstream = typeof WorkBuddyUpstreamClient === "function" ? new WorkBuddyUpstreamClient() : undefined;
    const stores = variants.map((variant) => {
      // Electron 路径覆盖：解密 $wbEncrypted 凭据需 App 的 key helper。
      // 注意：connect 的 electron key provider 在**构造器**里读 process.env[product.envVar]，
      // 之后才把结果快照到 explicitPath；因此这里必须在 new 之前真正写入 process.env，
      // 光改 variant.env 是无效的。写进 profile 的 cordis.patch.yml 最稳
      // （不受 dsh.bat 被 DSH 管理器重新生成而丢失环境变量影响）。
      const electronBin = electronBinOverride(variant?.region);
      let effectiveVariant = variant;
      if (electronBin !== undefined) {
        const envKey = variant?.electron?.envVar ?? (variant?.region === "global"
          ? ENV_ELECTRON_BIN_AI
          : ENV_ELECTRON_BIN_CN);
        if (envString(envKey) === undefined) process.env[envKey] = electronBin;
        effectiveVariant = {
          ...variant,
          electron: { ...(variant?.electron ?? {}), binPath: electronBin },
          env: { ...(variant?.env ?? {}), [envKey]: electronBin },
        };
      }
      const options = { variant: effectiveVariant };
      if (upstream !== undefined && typeof upstream.refreshToken === "function") {
        options.refresh = (credential) => upstream.refreshToken(credential);
      }
      return { variant: effectiveVariant, store: new WorkBuddyCredentialStore(options) };
    });
    return { stores, hasRefresh: upstream !== undefined };
  } catch (error) {
    lastConnectError = error;
    return undefined;
  }
}

/** 懒加载 + 缓存（含失败缓存，避免每次搜索都重试导入）。 */
let connectBridgeCache;
function loadConnectBridge() {
  connectBridgeCache ??= buildConnectBridge();
  return connectBridgeCache;
}

// ─────────────────────────── 区域选择与绑定 ───────────────────────────
//
// 为什么需要「绑定」而不是「每次挑一个」：
// 国内版与国际版是两套账号、两套积分。若每次搜索都重新挑，那么在用户
// 两个 App 都登录、其中一个 token 恰好过期的瞬间，请求会**漂移**到另一版，
// 于是「这一次扣的是谁的钱」变得不可预测 —— 用户看到的只是账单对不上。
// 因此：**首次使用时选定一版，之后整个会话都用它**，不可用就明确报错。

/** `region` 设置的三档取值（内部常量；对外只暴露 `region` 设置项本身）。 */
const REGION_AUTO = "auto";
const REGION_GLOBAL = "global";
const REGION_CN = "cn";

/**
 * `auto` 模式下两版**都可用**时的取舍顺序。
 *
 * 取 `global` 优先是**刻意的向后兼容**：v0.2.x 的默认行为就是国际版优先，
 * 老用户升级到 v0.3.0 后额度归属不变（不会突然改扣国内版）。
 * 想固定用国内版，写 `region: cn`（或设 `WORKBUDDY_SEARCH_REGION=cn`）即可。
 */
const AUTO_REGION_ORDER = [REGION_GLOBAL, REGION_CN];

/**
 * 区域设置：config > env > 默认 `auto`。
 *
 * - `auto`（默认）：用**实际可用的那一版**。这是「用户无感」的关键 ——
 *   只装了一版的人不需要做任何配置。
 * - `global` / `cn`：强制指定，即使那一版不可用也不改用另一版。
 *
 * 兼容旧写法：`china` → cn；`ai` / `intl` / `international` → global。
 * 无法识别的值一律落到 `auto`（而不是默默当成 global）——
 * 拼错一个单词不该让用户被扣另一个账号的额度。
 */
function regionSetting() {
  const raw = (settingString("region", "WORKBUDDY_SEARCH_REGION") ?? REGION_AUTO).trim().toLowerCase();
  if (raw === REGION_CN || raw === "china") return REGION_CN;
  if (raw === REGION_GLOBAL || raw === "ai" || raw === "intl" || raw === "international") return REGION_GLOBAL;
  return REGION_AUTO;
}

/** 按 region 取变体。 */
function variantByRegion(region) {
  return region === REGION_GLOBAL ? VARIANTS[1] : VARIANTS[0];
}

/** 同步版 dsh-home 解析（不 import 宿主包，供同步探测用）。 */
function syncDshHome() {
  const env = process.env.DSH_HOME;
  return env !== undefined && env.trim() !== "" ? env.trim() : join(homedir(), ".dsh");
}

/**
 * 一个变体手上凭据的**形态**（同步、只读、不跑子进程）。
 *
 * - `"plain"`     ：有明文 accessToken → 一定能用；
 * - `"encrypted"` ：只有 `$wbEncrypted` 信封 → 能否用取决于 Electron 能否定位；
 * - `"absent"`    ：该版一个凭据文件都没有。
 *
 * `options.candidates` 可显式指定候选路径（`(variant) => string[]`），
 * 供测试/诊断把被测逻辑与真实机器状态隔离开（平台默认布局无法用 env 注入）。
 */
function variantCredentialState(variant, env = process.env, options = {}) {
  const paths = typeof options.candidates === "function"
    ? options.candidates(variant) ?? []
    : credentialPathsForVariant(variant, { env, dshHome: options.dshHome ?? syncDshHome() });
  let sawEncrypted = false;
  for (const path of paths) {
    const parsed = parseAuthFileSync(path);
    if (parsed === undefined) continue;
    if (parsed.accessToken !== "") return "plain";
    if (parsed.encrypted === true) sawEncrypted = true;
  }
  return sawEncrypted ? "encrypted" : "absent";
}

/**
 * 选定变体（同步、纯探测，不联网）。
 *
 * - 显式指定 `global` / `cn` → 就用那一版，**即使它没有凭据**。
 *   这样报错才会指向用户真正想用的那一版，而不是含糊地说「没凭据」。
 * - `auto` → 优先「明文可用」的；否则在「加密」的两版里优先能定位到
 *   Electron（即真能解开）的那一版；都不行则取顺序里第一个加密的
 *   （让 `search()` 有机会给出可操作的解密指引）；两版都没有 → undefined。
 *
 * ⚠️ 只有真的读到加密凭据时才会去问 Electron 位置（那一步可能起一次
 * `reg.exe`，结果按进程缓存）。前面命中时不该付这个成本。
 */
function selectVariant(env = process.env, options = {}) {
  const setting = regionSetting();
  if (setting !== REGION_AUTO) return variantByRegion(setting);
  const ranked = AUTO_REGION_ORDER.map((region) => {
    const variant = variantByRegion(region);
    return { region, variant, state: variantCredentialState(variant, env, options) };
  });
  const plain = ranked.find((entry) => entry.state === "plain");
  if (plain !== undefined) return plain.variant;
  const encrypted = ranked.filter((entry) => entry.state === "encrypted");
  if (encrypted.length === 0) return undefined;
  const decryptable = encrypted.find((entry) => resolveElectronBinary(entry.variant, env, options) !== undefined);
  return (decryptable ?? encrypted[0]).variant;
}

/** 已绑定的变体 / 区域（一次绑定，会话内不变）。 */
let boundVariant;
let boundRegion;

/**
 * 绑定变体：**首次成功即固化**。
 *
 * 尚未绑定时每次重算（容忍「先装插件、后登录」的顺序），一旦绑定就不再改变 ——
 * 这正是「不会漂移到另一个账号」的实现点。
 */
function bindVariant(env = process.env, options = {}) {
  if (boundVariant !== undefined) return boundVariant;
  const variant = selectVariant(env, options);
  if (variant === undefined) return undefined;
  boundVariant = variant;
  boundRegion = variant.region;
  // 只打一次：让用户在日志里看到「这次会话扣的是哪一版」，而不是去猜。
  const line = `[dsh-workbuddy-websearch] 本次会话使用 ${variant.displayName}`
    + `（region=${variant.region}，来源设置：${regionSetting()}）；`
    + `整个会话不再切换版本。`;
  try {
    console.log(line);
  } catch {}
  return boundVariant;
}

/** 当前生效的变体（未绑定时先尝试绑定）。 */
function currentVariant() {
  return boundVariant ?? bindVariant();
}

/** 已绑定的区域（诊断/测试用）；尚未绑定时为 undefined。 */
function getLastRegion() {
  return boundRegion;
}

/** 仅供测试：清掉绑定，使下一次访问重新选择。 */
function resetBinding() {
  boundVariant = undefined;
  boundRegion = undefined;
}

/**
 * 通过 connect 的 store 解析凭据（纯增强路径）。
 *
 * v0.3.0 起**只在被绑定的那一版**里取：connect 的 store 是按变体分开的，
 * 这里只挑 region 相符的那一个，不做「这一版不行就换另一版」的排序回落。
 */
async function resolveViaConnect(variant = currentVariant(), signal) {
  if (variant === undefined) return undefined;
  const bridge = await loadConnectBridge();
  if (bridge === undefined) return undefined;
  const entry = bridge.stores.find((candidate) => candidate.variant?.region === variant.region);
  if (entry === undefined) return undefined;
  const credential = await entry.store.resolve();
  if (credential === undefined) return undefined;
  return { ...credential, variant: entry.variant };
}

/** dsh-home 解析：优先宿主包，失败退回 env / 默认。 */
async function resolveDshHomeSafe() {
  try {
    const mod = await import("@deepseek-ai/dsh-home-paths");
    if (typeof mod.resolveDshHome === "function") return mod.resolveDshHome();
  } catch {}
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim() !== "") return env.trim();
  return join(homedir(), ".dsh");
}

// ─────────────────────────── 凭据解析（自带实现） ───────────────────────────

/**
 * 解析 WorkBuddy auth 文档，兼容两种落盘形态：
 * 插件 OAuth 嵌套形 `{"auth":{...},"account":{...}}` 与扁平面板形。
 * v0.2.1 起由 `lib/credentials.mjs` 提供实现（同时识别加密文档）。
 */
const parseWorkBuddyAuth = parseAuthDocument;

/**
 * 同步版凭据候选（供 `available()` 用）。
 *
 * ⚠️ v0.3.0 起**只给被绑定那一版**的路径。旧版会把国内版 + 国际版的候选
 * 混在一起，于是「只装了国际版」的用户会因为国内版目录里有一份无关文件
 * 而被判为可用。区域绑定之后这个问题不复存在。
 *
 * 显式传 `variant` 可绕过绑定直接枚举某一版（测试用）。
 */
function syncCredentialCandidates(variant = currentVariant()) {
  if (variant === undefined) return [];
  return credentialPathsForVariant(variant, { env: process.env, dshHome: syncDshHome() });
}

/**
 * 凭据候选路径（异步版，dsh-home 走宿主包解析）。
 * 与 `syncCredentialCandidates` 同一语义：只给被绑定那一版。
 */
async function credentialCandidates(variant = currentVariant()) {
  if (variant === undefined) return [];
  const home = await resolveDshHomeSafe().catch(() => undefined);
  return credentialPathsForVariant(variant, { env: process.env, dshHome: home ?? syncDshHome() });
}

/** 从被绑定那一版的候选路径里读出第一个可用凭据（含解密）。 */
async function loadCredential() {
  const variant = currentVariant();
  if (variant === undefined) return undefined;
  const home = await resolveDshHomeSafe().catch(() => undefined);
  return resolveCredentialForVariant({ variant, dshHome: home });
}

/** 登录域名 → 区域；空域名视为国内。 */
function regionOf(domain) {
  const lowered = domain.trim().toLowerCase();
  if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
  return "cn";
}

function chatBase(credential) {
  // 变体信息（来自 connect）优先于域名推断：国际版即使 domain 字段缺失也走 global。
  if (credential?.variant?.region === "global") return GLOBAL_BASE;
  return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}

// ─────────────────────────── token 内存续期 ───────────────────────────

let refreshedCache = undefined; // { key(refreshToken), credential, atMs }

function isSessionUsable(credential, now = Date.now()) {
  return credential !== undefined
    && credential.accessToken !== ""
    && (credential.expiresAtMs === 0 || credential.expiresAtMs - now > 60_000);
}

async function webError(message, code, cause) {
  try {
    const mod = await import("@deepseek-ai/dsh-web");
    if (mod?.WebError !== undefined) return new mod.WebError(message, code, cause === undefined ? undefined : { cause });
  } catch {}
  // 兜底：@deepseek-ai/dsh-web 缺席时（如脱离宿主单测），仍要保留 code，
  // 否则上层无法按错误码分类（重试/重登/中止等语义会丢失）。
  const error = new Error(message);
  if (code !== undefined) error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** 调云端刷新端点；成功返回新凭据字段。 */
async function refreshUpstream(credential, signal) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "X-Refresh-Token": credential.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
    "User-Agent": USER_AGENT,
  };
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
  const response = await fetch(`${chatBase(credential)}${REFRESH_PATH}`, {
    method: "POST",
    headers,
    signal: signal === undefined ? AbortSignal.timeout(JSON_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
  });
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw await webError(`WorkBuddy token refresh returned HTTP ${response.status} with a non-JSON body`, "WB_SEARCH_REFRESH_FAILED");
  }
  if (!response.ok || envelope?.code !== 0) {
    throw await webError(
      `WorkBuddy token refresh failed (HTTP ${response.status}); sign in again in the WorkBuddy desktop app`,
      "WB_SEARCH_SESSION_DEAD",
    );
  }
  const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
  const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
  if (accessToken === "") {
    throw await webError("WorkBuddy token refresh returned no accessToken; sign in again in the WorkBuddy desktop app", "WB_SEARCH_SESSION_DEAD");
  }
  const refreshed = { ...credential, accessToken, source: "refreshed" };
  if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") refreshed.refreshToken = data["refreshToken"];
  if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) refreshed.expiresAtMs = Date.now() + data["expiresIn"] * 1e3;
  if (typeof data["domain"] === "string" && data["domain"] !== "") refreshed.domain = data["domain"];
  return refreshed;
}

/**
 * 构造「被绑定的那一版没有可用凭据」的可操作错误。
 *
 * 关键是把**是哪一版、该去哪登录、怎么改区域**说清楚 —— 用户看到的第一句话
 * 就该告诉他该做什么，而不是「no usable credential found」这种无从下手的措辞。
 */
async function buildNoCredentialError(variant, setting) {
  const appName = variant?.displayName ?? "WorkBuddy";
  const envVar = variant?.env ?? ENV_AUTH_FILE_CN;
  const other = variant?.region === REGION_GLOBAL ? REGION_CN : REGION_GLOBAL;
  const lines = [
    `没有找到可用的 ${appName} 凭据（当前区域设置：${setting}）。`,
    "",
    `请在 ${appName} 桌面端登录后重试（插件只读取磁盘上的登录态，不需要 App 正在运行）；`,
    `也可以显式指定凭据文件：${envVar}=<auth 文件的绝对路径>。`,
  ];
  if (setting === REGION_AUTO) {
    lines.push(
      "",
      `若你用的是另一版（${variant?.region === REGION_GLOBAL ? "国内版 WorkBuddy" : "国际版 WorkBuddy AI"}），`,
      `请确认该版本已登录；也可以在 profile 的 cordis.patch.yml 里写 region: ${other} 指定。`,
    );
  }
  return webError(lines.join("\n"), "WB_SEARCH_CREDENTIAL_MISSING");
}

/**
 * 解析当前可用凭据（**只在被绑定的那一版里找**）。
 *
 * v0.2.1 起为「自带实现为主、connect 为可选增强」：
 *   1) connect 若可用、能解析出凭据、**且该凭据确实可用** → 采用；
 *   2) 否则走**自带**路径：平台候选路径 → 明文/加密解析 → token 内存续期。
 *      自带路径功能完整，不因 connect 缺席而降级。
 *
 * ⚠️ v0.3.0 起**不跨版回落**：所有候选路径都来自被绑定的那一版。
 * 「这一版没登录」如实报 `WB_SEARCH_CREDENTIAL_MISSING`，绝不悄悄改用另一版 ——
 * 那会让额度扣到用户没预期的账号上。改用另一版只有一条路：改 `region` 设置。
 *
 * ⚠️ 两条「connect 坏了也不能拖累我们」的硬约束（v0.2.4 补）：
 *
 * - **必须校验可用性再采信**。connect 的 `store.resolve()` 完全可能返回一个
 *   「token 为空」或「已过期」的凭据（它内部续期失败时就是这样）。若直接采信，
 *   我们就会拿着死 token 去搜索、然后报 401，而**不会**回落到自带路径 ——
 *   那就违背了「connect 只做增强」这条承诺。故此处用 `isSessionUsable()` 过一道，
 *   不可用即视为 connect 本次未命中，继续走自带路径。
 * - **`forceRefresh` 时不能再用 connect**。该参数的语义是「刚才那个 token 已经死了，
 *   换一个新的」。而 connect 的 `resolve()` **没有**「强制刷新」入参，它只会把手上
 *   那个（正是死掉的那个）还回来，于是 401 重试必然再失败一次。因此强制刷新时
 *   **先走自带路径**（自带路径有显式的上游 refresh）；自带路径也拿不到时才回头找 connect。
 */
async function resolveCredential(forceRefresh = false, signal) {
  const variant = currentVariant();
  if (variant === undefined) throw await buildNoCredentialError(variantByRegion(regionSetting()), regionSetting());
  // 1) 可选增强：connect（含其自有解密 / 续期）
  //    forceRefresh 时跳过——见上方第二条约束。
  if (!forceRefresh) {
    try {
      const viaConnect = await resolveViaConnect(variant, signal);
      if (viaConnect !== undefined) {
        if (isSessionUsable(viaConnect)) {
          lastResolvedCredential = viaConnect;
          lastCredentialSource = "connect";
          return viaConnect;
        }
        // 拿得到但不可用：记录诊断，继续走自带路径（而不是直接失败）。
        lastConnectError = new Error(
          "dsh-workbuddy-connect 返回的凭据不可用（accessToken 为空或已过期），已改用自带路径",
        );
      }
    } catch (connectError) {
      // connect 的局部问题不应影响功能：记录后继续走自带路径。
      lastConnectError = connectError;
    }
  }
  // 2) 自带路径（功能完整，非降级）
  const disk = await loadCredential();
  if (disk !== undefined && disk.undecryptable !== true) {
    lastCredentialSource = "builtin";
    if (!forceRefresh && isSessionUsable(disk)) {
      lastResolvedCredential = disk;
      return disk;
    }
    const base = disk.refreshToken !== "" ? disk : undefined;
    if (base !== undefined) {
      const key = base.refreshToken;
      if (!forceRefresh && refreshedCache !== undefined && refreshedCache.key === key && isSessionUsable(refreshedCache.credential)) {
        lastResolvedCredential = refreshedCache.credential;
        return refreshedCache.credential;
      }
      const credential = await refreshUpstream(base, signal);
      refreshedCache = { key, credential, atMs: Date.now() };
      lastResolvedCredential = credential;
      return credential;
    }
  }
  // 3) 强制刷新时上面跳过了 connect；自带路径也没拿到 → 回头再试 connect，
  //    总比直接失败好（至少不比旧行为差）。
  if (forceRefresh) {
    try {
      const viaConnect = await resolveViaConnect(variant, signal);
      if (viaConnect !== undefined) {
        lastResolvedCredential = viaConnect;
        lastCredentialSource = "connect";
        return viaConnect;
      }
    } catch (connectError) {
      lastConnectError = connectError;
    }
  }
  throw await buildNoCredentialError(variant, regionSetting());
}

/** 最近一次成功解析的凭据（供同步 available() 快速判断，不读盘）。 */
let lastResolvedCredential;

/** 上游「会话已死」标记（与 dsh-workbuddy-connect 的 SESSION_DEAD_MARKERS 一致）。 */
function isSessionDead(status, body) {
  return status === 401 || body.includes("Offline user session not found") || body.includes("12153");
}

// ─────────────────────────── agentic 搜索（SSE） ───────────────────────────

/** 解析单个 SSE 帧，提取 event 名与 data 字符串（桌面 App 同款解析）。 */
function parseSseFrame(frame) {
  let eventName = "";
  let dataStr = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) eventName = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataStr += line.slice(6);
  }
  return { eventName, dataStr };
}

/** 从综述文本中提取来源（markdown 链接优先，裸 URL 兜底），按 URL 去重。 */
function extractSources(content) {
  const seen = new Set();
  const sources = [];
  const push = (url, title) => {
    const trimmed = url.trim().replace(/[).,;'""\]、。，；：！？（）【】《》「」『』“”‘’…—·]+$/u, "");
    if (trimmed === "" || !/^https?:\/\//i.test(trimmed) || seen.has(trimmed)) return;
    seen.add(trimmed);
    sources.push({
      url: trimmed,
      ...(title !== undefined && title.trim() !== "" ? { title: title.trim() } : {}),
    });
  };
  const linkPattern = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)[^)]*\)/gu;
  for (const match of content.matchAll(linkPattern)) push(match[2], match[1]);
  if (sources.length < MAX_SOURCES) {
    const barePattern = /(?<!\()https?:\/\/[^\s<>()\[\]{}"'\u2018\u2019\u201C\u201D\u2026\u2013\u2014\u3000-\u303F\uFF00-\uFFEF]+/gu;
    for (const match of content.matchAll(barePattern)) {
      if (sources.length >= MAX_SOURCES) break;
      push(match[0], undefined);
    }
  }
  return sources;
}

/** 清理综述里面向桌面 UI 的内部标记。 */
function cleanSynthesis(content) {
  return content
    .replace(/<selected-refs>[\s\S]*?<\/selected-refs>/giu, "")
    .replace(/<\/?selected-refs>/giu, "")
    .trim();
}

function capContent(content) {
  const limit = maxContentChars();
  if (limit === 0 || content.length <= limit) return content;
  return `${content.slice(0, limit)}\n\n(WorkBuddy 搜索综述在第 ${limit} 字符处被截断；可用 WORKBUDDY_SEARCH_MAX_CONTENT_CHARS 调整上限，或用更具体的查询缩小范围。)`;
}

/**
 * 调用云端 SSE 接口，返回 `{content, sources}`。
 * `tool_call`/`tool_result` 等中间事件忽略（桌面 App 也只用 done 的 synthesis）。
 */
async function callAgenticSearch(credential, query, signal) {
  // 入口即检查：signal 若在调用前已 abort，不会补触发 addEventListener，
  // 必须先短路，否则会照常发起一次云端检索（浪费计费）且上层拿不到 abort 语义。
  if (signal?.aborted === true) throw await webError("WorkBuddy search aborted", "WEB_ABORTED", signal.reason);
  const endpoint = `${endpointOverride() ?? chatBase(credential)}${SEARCH_PATH}`;
  const bizVia = credential.enterpriseId !== undefined && credential.enterpriseId.trim() !== "" ? "internal" : "public";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("WorkBuddy agentic search SSE timeout")), SSE_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal.reason);
  if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.accessToken}`,
        "User-Agent": USER_AGENT,
        "X-Conversation-Request-ID": randomUUID(),
      },
      body: JSON.stringify({
        query,
        search_mode: searchMode(),
        stream: true,
        biz_via: bizVia,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted === true) throw await webError("WorkBuddy search aborted", "WEB_ABORTED", signal.reason);
    throw await webError(`WorkBuddy search request failed: ${String(error)}`, "WB_SEARCH_TRANSPORT_ERROR", error);
  } finally {
    clearTimeout(timeout);
    if (response === undefined && signal !== undefined) signal.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    signal?.removeEventListener("abort", onAbort);
    const body = await response.text().catch(() => "");
    if (isSessionDead(response.status, body)) {
      const error = await webError(`WorkBuddy search session dead (HTTP ${response.status})`, "WB_SEARCH_SESSION_DEAD");
      error.status = response.status;
      error.body = body.slice(0, 500);
      throw error;
    }
    throw await webError(
      `WorkBuddy search failed: HTTP ${response.status} ${response.statusText}${body !== "" ? `: ${body.slice(0, 300)}` : ""}`,
      "WB_SEARCH_UPSTREAM_ERROR",
    );
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    signal?.removeEventListener("abort", onAbort);
    throw await webError("WorkBuddy search response has no body stream", "WB_SEARCH_UPSTREAM_ERROR");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let synthesis = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const { eventName, dataStr } = parseSseFrame(frame);
        if (eventName !== "done" || dataStr === "") continue;
        try {
          synthesis = JSON.parse(dataStr)?.synthesis?.content ?? "";
        } catch {}
      }
    }
  } catch (error) {
    if (signal?.aborted === true) throw await webError("WorkBuddy search aborted", "WEB_ABORTED", signal.reason);
    throw await webError(`WorkBuddy search stream failed: ${String(error)}`, "WB_SEARCH_TRANSPORT_ERROR", error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
  }
  if (synthesis === "") {
    // 收流结束但无综述：若期间收到中止信号，优先归因为 aborted（而非空结果）。
    if (signal?.aborted === true) throw await webError("WorkBuddy search aborted", "WEB_ABORTED", signal.reason);
    throw await webError("WorkBuddy search stream ended without synthesis content", "WB_SEARCH_EMPTY_RESULT");
  }
  // 竞态兜底：上游正常收流，但调用方在收流末尾已取消 → 仍按 aborted 上抛。
  if (signal?.aborted === true) throw await webError("WorkBuddy search aborted", "WEB_ABORTED", signal.reason);
  return { content: cleanSynthesis(synthesis), sources: extractSources(synthesis) };
}

// ─────────────────────────── provider 注册 ───────────────────────────

/**
 * WorkBuddy agentic 搜索 provider。一个查询 = 一次云端多步检索（约 10-60s），
 * 返回带引用的综述文本（content）与来源链接（sources）。
 */
class WorkBuddyAgenticSearchProvider {
  id = PROVIDER_ID;

  /**
   * 可用性检查：**只看被绑定的那一版**。
   *
   * v0.3.0 起不再「国内版或国际版有一个文件就算可用」——那种写法会让只装了
   * 国际版的用户因为国内版目录里有一份无关文件而被判为可用，随后在 `search()`
   * 里失败，错误信息还指错了版本。
   *
   * 「加密但解不开」**仍然返回 true**，这是刻意的诊断取舍：若这里就返回 false，
   * 宿主只会给出笼统的 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`；返回 true 则让
   * `search()` 有机会抛出带完整修复步骤的 `WB_SEARCH_CREDENTIAL_ENCRYPTED`。
   * 对本插件而言，**「告诉用户怎么修」比「提前举手说不可用」更有用**。
   *
   * 带短 TTL 缓存，避免每次执行 web_search 都同步读盘。
   */
  #cacheAt = 0;
  #cacheValue = false;
  available() {
    const now = Date.now();
    if (now - this.#cacheAt < 3_000) return this.#cacheValue;
    let usable = false;
    // 1) 已有成功解析结果且在有效期内 → 直接可用（省一次读盘）。
    if (lastResolvedCredential !== undefined && isSessionUsable(lastResolvedCredential)) {
      usable = true;
    }
    // 2) 同步探测被绑定那一版的凭据候选（明文 token 或可解析的加密信封）。
    if (!usable) {
      const variant = currentVariant();
      usable = variant !== undefined && variantCredentialState(variant) !== "absent";
    }
    this.#cacheAt = now;
    this.#cacheValue = usable;
    return usable;
  }

  async search(request, signal) {
    const query = typeof request?.query === "string" ? request.query.trim() : "";
    if (query === "") throw await webError("WorkBuddy search requires a non-empty query", "WB_SEARCH_BAD_REQUEST");
    let credential = await resolveCredential(false, signal);
    let result;
    try {
      result = await callAgenticSearch(credential, query, signal);
    } catch (error) {
      // 会话死亡 → 强制内存续期后重试一次。
      if (error?.code !== "WB_SEARCH_SESSION_DEAD" || signal?.aborted === true) throw error;
      credential = await resolveCredential(true, signal);
      result = await callAgenticSearch(credential, query, signal);
    }
    return {
      ...(result.content !== "" ? { content: capContent(result.content) } : {}),
      sources: result.sources,
      truncated: false,
    };
  }
}

/** 注册 provider；随宿主 fiber 自动清理。 */
export function apply(ctx) {
  // 注入 cordis config（profile 的 cordis.patch.yml 会写进这里），
  // 使 Electron 路径 / 区域 / 端点等参数不依赖易失的启动脚本环境变量。
  try {
    configure(ctx?.config);
  } catch {}

  // ⚠️ 同一个 provider id 只能由一个插件注册：`ctx.web` 按 id 去重，后注册者抛
  // `WEB_DUPLICATE_PROVIDER`（见 `@deepseek-ai/dsh-web` 的 `registerProvider`）。
  // 任何注册了同一个 id 的插件都会撞上——不限于某个特定包名，例如本插件的旧版本、
  // 改过 id 的 fork，或任何自行注册同一 id 的第三方插件。
  // 这里把裸错误翻译成**可操作指引**——否则用户只看到一行 `1 entry did not activate`，
  // 完全不知道该卸谁。运行时拿不到占用者的包名，所以指引到「怎么把它查出来」。
  try {
    ctx.web.registerSearchProvider(new WorkBuddyAgenticSearchProvider());
  } catch (error) {
    if (error?.code === "WEB_DUPLICATE_PROVIDER") {
      throw new Error(
        `[dsh-workbuddy-websearch] 无法注册搜索 provider "${PROVIDER_ID}"：该 id 已被另一个插件占用。\n` +
          `  ctx.web 按 provider id 去重，同一个 id 只能有一个插件注册，**只能留一个**。\n` +
          `  常见于：本插件的旧版本/前身版本仍在装，或任何自行注册 "${PROVIDER_ID}" 的插件。\n` +
          `  排查：\n` +
          `    1) 打开该 profile 的 package.json，看 dependencies 与 dsh.profile.bundles\n` +
          `    2) 找出除 dsh-workbuddy-websearch 之外、还注册同一个 provider id 的那个插件\n` +
          `    3) 卸掉它，确认 bundles 里已无该条目，然后重启 dsh：\n` +
          `       dsh plugin --profile <你的 profile> remove <那个插件>\n` +
          `  原始错误：${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }

  // 区域与具体版本**不在启动时绑定**，而是首次真正用到时绑定一次并固化
  // （见 `bindVariant`）。原因：绑定可能要起一次 `reg.exe` 查卸载注册表
  // （两版装在同一个目录时这是唯一可靠的信息源），不该让插件加载去等它。
  // 这里只把设置值打出来，让用户在日志里一眼看到生效的是哪一档。
  const line = `[dsh-workbuddy-websearch] registered "${PROVIDER_ID}" into ctx.web`
    + ` (WorkBuddy agenttool agentic_search; region=${regionSetting()})`;
  try {
    ctx.root?.logger?.("workbuddy-websearch").info?.(line);
  } catch {}
  console.log(line);
}

// ─────────────────────────── 测试钩子（不进入运行时路径） ───────────────────────────

/** 仅供单测/探针脚本使用；宿主不会调用。 */
export const __internals = {
  parseWorkBuddyAuth,
  loadCredential,
  resolveCredential,
  resolveViaConnect,
  loadConnectBridge,
  credentialCandidates,
  syncCredentialCandidates,
  // 区域选择（v0.3.0）：设置值 / 选定 / 绑定 / 查询。
  regionSetting,
  selectVariant,
  bindVariant,
  resetBinding,
  getLastRegion,
  variantCredentialState,
  variantByRegion,
  AUTO_REGION_ORDER,
  REGION_AUTO,
  REGION_GLOBAL,
  REGION_CN,
  getLastConnectError: () => lastConnectError,
  getLastCredentialSource: () => lastCredentialSource,
  extractSources,
  cleanSynthesis,
  callAgenticSearch,
  regionOf,
  chatBase,
  PROVIDER_ID,
  // 自带实现的直接入口（便于单测在无 connect 环境下验证）。
  VARIANTS,
  resolveCredentialForVariant,
  resolveCredentialIndependently,
  readCredentialFile,
  parseAuthFileSync,
  probeAuthFileSync,
  credentialPathsForVariant,
  regionMismatch,
  desktopAuthFiles,
  resolveElectronBinary,
  scanWindowsInstallRoots,
  // macOS 定位（Spotlight 发现链）：与 Windows 的注册表发现对称。
  findElectronFromMacosBundles,
  resolveElectronFromMacosDiscovery,
  resetMacosDiscoveryCache,
  MDFIND_BIN,
  PLUTIL_BIN,
  // 统一凭据候选入口（含 env 覆盖的最高优先级），供测试验证分层行为。
  credentialPaths,
};
