/**
 * 自带凭据读取：平台候选路径 → 解析 → （按需）解密 → 统一形状。
 *
 * 这是插件「独立可用」的核心：不依赖 dsh-workbuddy-connect 的任何导出，
 * 自己完成「找到 auth 文件 → 读出可用 token」的全过程，并且覆盖
 * 国内版与国际化版、明文与加密两种落盘形态。
 *
 * ⚠️ **一次只服务一个变体，且不跨版回落**（v0.3.0 起）。
 * 调用方先绑定一版（`resolveCredentialForVariant({ variant })`），本模块只在那
 * 一版的候选路径里找。读到**另一版**的凭据时拒绝采用并报错 —— 跨版静默回落
 * 会让用户以为在扣国际版额度、实际扣了国内版，那是账务上的意外，不是容错。
 * 这一取向与 `dsh-workbuddy-connect` 的 `credential-region-mismatch` 一致。
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
 * 同步解析一个 auth 文件（不解密、不跑子进程、不联网）。
 *
 * 供同步的 `available()` 与区域绑定使用：这里必须零成本，所以只做
 * 「读盘 + JSON 解析」，任何异常都吞掉并返回 undefined。
 *
 * @returns `parseAuthDocument` 的结果；文件不存在 / 过大 / 不可解析时为 undefined。
 */
export function parseAuthFileSync(path) {
  try {
    if (!existsSync(path)) return undefined;
    const stat = statSync(path);
    if (stat.size === 0 || stat.size > MAX_AUTH_BYTES_SYNC) return undefined;
    return parseAuthDocument(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 同步探测一个 auth 文件是否「看起来可用」（不解密、不跑子进程）。
 * 供 `available()` 使用：加密文档只要信封可解析即视为「有凭据」，
 * 因为真正的可用性由后续 `search()` 决定，而这里必须零成本。
 *
 * 之所以把「加密信封可解析」也算作可用，是**刻意的诊断取舍**：
 * 若在这里就报 false，宿主只会给出笼统的「provider 不可用」；
 * 报 true 则会让 `search()` 有机会抛出带完整修复指引的错误
 * （见 `buildEncryptedCredentialError`）。
 */
export function probeAuthFileSync(path) {
  const parsed = parseAuthFileSync(path);
  if (parsed === undefined) return false;
  return parsed.accessToken !== "" || parsed.encrypted;
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
 * 单个变体的候选凭据路径，按探测顺序。
 *
 * 顺序：**该变体自己的**环境变量 → dsh-home 自有副本 → 该变体的桌面端 auth
 * 文件（含该平台的全部候选目录）。
 *
 * ⚠️ 只含该变体自己的路径。v0.3.0 起**不再跨版回落**：国内版只找国内版的
 * 文件，国际版只找国际版的。环境变量同理，只用该变体自己那一个
 * （国内版 `WORKBUDDY_AUTH_FILE`、国际版 `WORKBUDDY_AI_AUTH_FILE`），
 * 与 `dsh-workbuddy-connect` 的 `resolveDesktopCandidates()` 保持一致。
 */
export function credentialPathsForVariant(variant, { env = process.env, dshHome } = {}) {
  const out = [];
  if (variant === null || typeof variant !== "object") return out;
  const push = (value) => {
    if (typeof value === "string" && value.trim() !== "" && !out.includes(value.trim())) out.push(value.trim());
  };
  push(env[variant.env]);
  if (typeof dshHome === "string" && dshHome.trim() !== "") {
    push(join(dshHome.trim(), variant.ownFilename));
  }
  for (const file of desktopAuthFiles(variant)) push(file);
  return out;
}

/**
 * 这份凭据是否属于**另一个区域**。
 *
 * 只在域名**明确**指向另一版时才判为不匹配：域名缺失或为空一律放行。
 * 比 connect 略宽 —— 它把空域名也当国内版，从而会拒绝一份域名恰好缺失的
 * 国际版凭据；而空域名是落盘形态差异，不是跨版混用，不该因此判死。
 */
export function regionMismatch(variant, credential) {
  const domain = typeof credential?.domain === "string" ? credential.domain.trim().toLowerCase() : "";
  if (domain === "") return false;
  const isGlobal = domain === "workbuddy.ai" || domain.endsWith(".workbuddy.ai");
  return variant?.region === "global" ? !isGlobal : isGlobal;
}

/**
 * 构造「凭据属于另一版」的可操作错误。
 *
 * 这是「拒绝混用」的用户可见面：**宁可报错，也不静默换成另一个账号去扣费**。
 */
function buildRegionMismatchError(variant, credential) {
  const appName = variant?.displayName ?? "WorkBuddy";
  const other = variant?.region === "global" ? "国内版（WorkBuddy）" : "国际版（WorkBuddy AI）";
  const switchTo = variant?.region === "global" ? "cn" : "global";
  const error = new Error([
    `WorkBuddy 凭据 ${credential.path} 属于${other}，但当前绑定的是 ${appName}`
      + `（域名 ${JSON.stringify(credential.domain)}）。`,
    "",
    "插件不跨版本混用账号与积分，因此拒绝采用这份凭据。",
    "常见成因：两版 App 的凭据文件被写混了（例如把国际版的 auth 文件复制到了国内版的位置）。",
    "",
    "处理办法二选一：",
    `  ① 检查该路径下的文件是否来自对应的 App；或`,
    `  ② 改用另一版：设 WORKBUDDY_SEARCH_REGION=${switchTo}（或写进 profile 的 cordis.patch.yml）后重启 dsh。`,
  ].join("\n"));
  error.code = "WB_SEARCH_CREDENTIAL_REGION_MISMATCH";
  return error;
}

/**
 * 解析**指定变体**的凭据。
 *
 * v0.3.0 起不再跨版回落：只在 `variant` 自己的候选路径里找。因此
 * 「这一版没登录」会如实表现为拿不到凭据，而不是悄悄改用另一版。
 *
 * @param options.variant - 要解析的变体（必填）。
 * @param options.dshHome - dsh-home 路径。
 * @param options.env - 环境变量表（可注入，便于测试）。
 * @param options.signal - 取消信号。
 * @param options.candidates - **显式指定候选路径**（测试/诊断用）。
 *   省略时按 `credentialPathsForVariant` 推导。给这个口子是因为平台默认布局
 *   无法通过 `env` 注入（`desktopAuthFiles` 读的是真实 `homedir()`），
 *   于是「跨版拒绝」「单变体隔离」这些行为没法在真机上做确定性验证 ——
 *   只能靠注入候选路径把被测逻辑与真实机器状态隔离开。
 * @returns {Promise<object|undefined>} 含 `variant` 的凭据；无凭据时 undefined。
 * @throws 凭据存在但不可用时抛出可操作错误（加密解不开 / 区域不匹配）。
 */
export async function resolveCredentialForVariant({ variant, dshHome, env = process.env, signal, candidates } = {}) {
  if (variant === null || typeof variant !== "object") return undefined;
  const paths = Array.isArray(candidates) ? candidates : credentialPathsForVariant(variant, { env, dshHome });
  let firstUndecryptable;
  let firstMismatch;
  for (const path of paths) {
    if (signal?.aborted === true) throw signal.reason ?? new Error("aborted");
    const credential = await readCredentialFile(path, { variant });
    if (credential === undefined) continue;
    if (credential.undecryptable === true) {
      firstUndecryptable ??= credential;
      continue;
    }
    // 区域校验：读到另一版的凭据 → 拒绝，不静默采用。
    if (regionMismatch(variant, credential)) {
      firstMismatch ??= credential;
      continue;
    }
    return credential;
  }
  // 区域不匹配比「解不开」更能解释问题，优先报它。
  if (firstMismatch !== undefined) throw buildRegionMismatchError(variant, firstMismatch);
  if (firstUndecryptable !== undefined) throw buildEncryptedCredentialError(firstUndecryptable);
  return undefined;
}

/**
 * 按区域解析凭据（**兼容既有测试与探针的签名**）。
 *
 * 等价于 `resolveCredentialForVariant` 解析 `region` 对应的那**一个**变体。
 * 注意语义已变：v0.3.0 起**不再回落到另一区域** —— 参数名仍是 `region`，
 * 但它是「用哪一版」而不是「先试哪一版」。
 */
export async function resolveCredentialIndependently({ region = "global", dshHome, env = process.env, signal } = {}) {
  return resolveCredentialForVariant({
    variant: region === "cn" ? VARIANTS[0] : VARIANTS[1],
    dshHome,
    env,
    signal,
  });
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
