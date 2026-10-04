/**
 * 自带凭据读取：平台候选路径 → 解析 → （按需）解密 → 统一形状。
 *
 * 这是插件「独立可用」的核心：不依赖 dsh-workbuddy-connect 的任何导出，
 * 自己完成「找到 auth 文件 → 读出可用 token」的全过程，并且同时覆盖
 * 国内版与国际化版、明文与加密两种落盘形态。
 *
 * ───────────────────────────── 来源与致谢 ─────────────────────────────
 * 「两种落盘形态」的识别规则（插件 OAuth 嵌套形 `{auth:{...},account:{...}}`
 * 与扁平面板形）对齐自 `dsh-workbuddy-connect`（Corrine Hu, MIT c 2026）的
 * `parseWorkBuddyAuth`；`expiresAt` 秒/毫秒双刻度用 `0xe8d4a51000` 作分界的
 * 判据亦同源。
 *
 * 「校验通过才返回 / 宁可判为未识别也不乱解」的保守取向也沿用其风格。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 与 connect 的关系（重要）：
 * - connect **存在**时，本模块仍可工作；插件会优先使用 connect 的 store
 *   （它对刷新时序、罕见落盘形态的兼容更完整）。本模块是**并行**的独立实现，
 *   不是「connect 的残缺备份」。
 * - connect **不存在**时，本模块是唯一路径，且功能完整。
 *
 * @module dsh-workbuddy-websearch/credentials
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  VARIANTS,
  ENV_AUTH_FILE_CN,
  ENV_AUTH_FILE_AI,
  desktopAuthFiles,
  resolveElectronBinary,
  variantForRegion,
} from "./platform.mjs";
import {
  collectEncryptedFields,
  decryptField,
  hasEncryptedFields,
  resolveDecryptionKeys,
} from "./decrypt.mjs";

/** 单文件大小上限（防呆：auth 文件不应超过 1MB）。 */
const MAX_AUTH_BYTES = 1_048_576;
/** available() 同步探测用更保守的上限。 */
const MAX_AUTH_BYTES_SYNC = 262_144;

/**
 * 秒/毫秒两种到期刻度统一到毫秒。
 * 有些落盘写秒（1.7e9），有些写毫秒（1.7e12），用 0xe8d4a51000 作分界。
 */
export function expiryToMs(value) {
  if (typeof value !== "number" || value <= 0) return 0;
  return value > 0xe8d4a51000 ? value : value * 1e3;
}

function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 把 auth 文档的 JSON 文本解析成统一凭据形状（**不做解密**）。
 * 兼容两种落盘形态：
 * - 插件 OAuth 嵌套形：`{"auth":{...},"account":{...}}`
 * - 扁平面板形：token 直接在最外层
 *
 * 加密字段在此处会是 wrapper 对象而非字符串 —— 这类文档会被识别出来
 * （`encrypted: true`），交由 `readCredentialFile` 解密后再取 token。
 */
export function parseAuthDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed;
  const nested = typeof document["auth"] === "object" && document["auth"] !== null;
  const auth = nested ? document["auth"] : document;
  const identity = nested && typeof document["account"] === "object" && document["account"] !== null
    ? document["account"]
    : document;

  const encrypted = hasEncryptedFields(document);
  const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
  // 无明文 token 且无加密字段 → 不是可用凭据文档。
  if (accessToken === "" && !encrypted) return undefined;

  return {
    document,
    auth,
    encrypted,
    accessToken,
    refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
    expiresAtMs: expiryToMs(auth["expiresAt"]),
    domain: optionalString(auth["domain"]) ?? "",
    uid: optionalString(identity["uid"]) ?? "",
    enterpriseId: optionalString(identity["enterpriseId"]),
  };
}

/**
 * 读出并解出一个 auth 文件的完整凭据。
 *
 * @returns {Promise<object|undefined>} 统一凭据对象，或 undefined（不存在/不可用）
 */
export async function readCredentialFile(path, { variant, allowDecrypt = true } = {}) {
  let text;
  try {
    if (!existsSync(path)) return undefined;
    const stat = statSync(path);
    if (stat.size === 0 || stat.size > MAX_AUTH_BYTES) return undefined;
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseAuthDocument(text);
  if (parsed === undefined) return undefined;

  let { accessToken, refreshToken } = parsed;
  const document = parsed.document;

  // 加密文档：解出 token。解密失败则整份视为不可用（会有明确诊断）。
  if (parsed.encrypted && (accessToken === "" || refreshToken === "")) {
    if (!allowDecrypt) return undefined;
    const fields = collectEncryptedFields(document);
    const electronBin = resolveElectronBinary(variant ?? variantForRegion("cn"));
    if (electronBin === undefined) {
      // 有加密凭据但找不到 App 二进制 → 无法解密。返回带诊断的 undefined，
      // 让上层能给出「请设置 WORKBUDDY_*_ELECTRON_BIN」的指引。
      return {
        undecryptable: true,
        path,
        variant,
        reason: "electron-binary-unavailable",
      };
    }
    const keys = await resolveDecryptionKeys(fields.map((f) => f.keyId), electronBin);
    const decoded = new Map();
    for (const entry of fields) {
      const value = decryptField(entry, keys);
      if (value !== undefined) decoded.set(entry.field, value);
    }
    if (decoded.size === 0) {
      return { undecryptable: true, path, variant, reason: "decryption-failed" };
    }
    accessToken = decoded.get("accessToken") ?? accessToken;
    refreshToken = decoded.get("refreshToken") ?? refreshToken;
  }

  if (accessToken === "") return undefined;
  return {
    accessToken,
    refreshToken,
    expiresAtMs: parsed.expiresAtMs,
    domain: parsed.domain,
    uid: parsed.uid,
    enterpriseId: parsed.enterpriseId,
    source: parsed.encrypted ? "desktop-encrypted" : "desktop",
    path,
    variant,
  };
}

/**
 * 同步探测一个 auth 文件是否「看起来可用」（不解密、不跑子进程）。
 * 供 `available()` 使用：加密文档只要信封可解析即视为「有凭据」，
 * 因为真正的可用性由后续 `search()` 决定，而这里必须零成本。
 */
export function probeAuthFileSync(path) {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size > MAX_AUTH_BYTES_SYNC) return false;
    const text = readFileSync(path, "utf8");
    const parsed = parseAuthDocument(text);
    if (parsed === undefined) return false;
    if (parsed.accessToken !== "") return true;
    // 加密文档：信封结构合法即认为「有凭据可尝试」。
    return parsed.encrypted;
  } catch {
    return false;
  }
}

/**
 * 全部候选凭据路径，按探测顺序（含两版、含所有平台候选目录）。
 * 顺序：环境变量 → dsh-home 自有副本 → 桌面端 auth 文件。
 */
export function credentialPaths({ variants = VARIANTS, env = process.env, dshHome } = {}) {
  const out = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim() !== "" && !out.includes(value.trim())) out.push(value.trim());
  };
  push(env[ENV_AUTH_FILE_CN]);
  push(env[ENV_AUTH_FILE_AI]);
  if (typeof dshHome === "string" && dshHome.trim() !== "") {
    const home = dshHome.trim();
    for (const variant of variants) push(join(home, variant.ownFilename));
  }
  for (const variant of variants) {
    for (const file of desktopAuthFiles(variant)) push(file);
  }
  return out;
}

/**
 * 独立解析凭据：按候选顺序读取，优先返回期望区域的账号。
 *
 * @param {object} options
 * @param {"cn"|"global"} options.region 期望区域（失败会回退到另一区域）
 * @param {string|undefined} options.dshHome dsh-home 路径
 * @param {AbortSignal|undefined} options.signal
 * @returns {Promise<object|undefined>} 含 `variant` 的凭据
 */
export async function resolveCredentialIndependently({ region = "global", dshHome, signal } = {}) {
  const candidates = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim() !== "" && !candidates.includes(value.trim())) candidates.push(value.trim());
  };
  // 期望区域优先（环境变量指向的文件不区分区域，按位置排）。
  const ordered = region === "cn" ? [VARIANTS[0], VARIANTS[1]] : [VARIANTS[1], VARIANTS[0]];
  push(process.env[ENV_AUTH_FILE_CN]);
  push(process.env[ENV_AUTH_FILE_AI]);
  if (typeof dshHome === "string" && dshHome.trim() !== "") {
    const home = dshHome.trim();
    for (const variant of ordered) push(join(home, variant.ownFilename));
  }
  for (const variant of ordered) {
    for (const file of desktopAuthFiles(variant)) push(file);
  }

  let firstUndecryptable;
  for (const path of candidates) {
    if (signal?.aborted === true) throw signal.reason ?? new Error("aborted");
    // 从路径推断 variant（用于选 Electron 二进制）；推断不出时用期望区域。
    const variant = variantForPath(path, ordered) ?? variantForRegion(region);
    const credential = await readCredentialFile(path, { variant });
    if (credential === undefined) continue;
    if (credential.undecryptable === true) {
      firstUndecryptable ??= credential;
      continue;
    }
    return credential;
  }
  if (firstUndecryptable !== undefined) {
    throw buildEncryptedCredentialError(firstUndecryptable);
  }
  return undefined;
}

/**
 * 构造「凭据已加密但打不开」的可操作错误。
 *
 * 现实中最常见的成因不是插件有 bug，而是**用户把 WorkBuddy 装到了自选盘符/自定义路径**
 * （官方安装器允许改目录），此时默认布局与常见根扫描都覆盖不到，必须由用户显式指定。
 * 因此这里不只报错，而是给出「找哪个文件名 + 两条可直接粘贴的命令」，
 * 让用户一次就能修好，而不是来读源码。
 *
 * 注意：提示里的路径一律用 `<安装盘>` 占位，不出现任何具体盘符——
 * 仓库对外发布，不得夹带本机信息（由 tools/check-github-meta.mjs 的 G8 强制）。
 */
function buildEncryptedCredentialError(undecryptable) {
  const variant = undecryptable.variant;
  const envVar = variant?.electron?.envVar
    ?? (variant?.region === "global" ? "WORKBUDDY_AI_ELECTRON_BIN" : "WORKBUDDY_ELECTRON_BIN");
  const exeName = variant?.electron?.windowsExeBasename
    ?? (variant?.region === "global" ? "WorkBuddyAI.exe" : "WorkBuddy.exe");
  const appName = variant?.displayName ?? "WorkBuddy";

  const lines = [
    `WorkBuddy 凭据 ${undecryptable.path} 是 5.6+ 加密格式（$wbEncrypted），`
      + `需要 ${appName} 桌面端自带的 Electron 二进制才能解开，但没能自动定位到它`
      + `（原因：${undecryptable.reason}）。`,
    "",
    "已尝试：① 环境变量 " + envVar + "；② 默认安装布局；"
      + "③ %LOCALAPPDATA%\\Programs 与 %ProgramFiles%* 下的一层有界扫描。",
    "最常见的原因是安装时把目录改到了自选盘符或自定义路径，这种情况插件不做猜测。",
    "",
    "请先找到 " + exeName + "（Windows 上常见位置：`<安装盘>:\\Programs\\" + appName + "\\`、"
      + "`<安装盘>:\\<任意目录>\\" + appName + "\\`；macOS 为 `/Applications/" + appName + ".app`），"
      + "然后二选一：",
    "",
    `  cmd         set ${envVar}=<找到的绝对路径>`,
    `  PowerShell  $env:${envVar} = "<找到的绝对路径>"`,
    "",
    `更稳的做法是写进该 profile 的 cordis.patch.yml（不受 dsh.bat 重新生成影响）：`,
    `  ${envVar}: <找到的绝对路径>`,
    "改完重启 dsh 即可。详见 README.md「凭据来源」与 COMPATIBILITY.md「Electron 定位」。",
  ];
  const error = new Error(lines.join("\n"));
  error.code = "WB_SEARCH_CREDENTIAL_ENCRYPTED";
  return error;
}

/** 由路径反推 variant（按文件名匹配，失败返回 undefined）。 */
function variantForPath(path, variants) {
  for (const variant of variants) {
    if (path.endsWith(variant.desktopFilename) || path.endsWith(variant.ownFilename)) return variant;
  }
  return undefined;
}
