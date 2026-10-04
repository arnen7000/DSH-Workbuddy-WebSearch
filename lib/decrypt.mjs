/**
 * WorkBuddy 5.6+ 桌面端「静态凭据加密」的自带解密实现。
 *
 * ───────────────────────────── 来源与致谢 ─────────────────────────────
 * **本模块的算法细节转录自 `dsh-workbuddy-connect`，作者 Corrine Hu（MIT, c 2026）。**
 *
 * 加密算法并未由 WorkBuddy 官方公开。connect 是第一个把它逆向出来、并在真实
 * App（5.6.2）上验证通过的项目——包括密钥获取途径、AAD 的逐字节构造、
 * 以及载荷校验规则。没有它的工作，本模块无法完成。
 *
 * 我们做的**不是**「参考思路后自己写」：AAD 构造是**逐字节对齐**的。
 * 起初我们按 `keyId=..\nfield=..` 自行推测，加解密往返测试直接失败；
 * 读了 connect 的实现才对上真实格式。详见仓库根目录 `CREDITS.md` §1.1。
 *
 * 与 connect 的区别：本模块**不依赖** connect（零外部依赖），使插件做到
 * 「装了 connect 更好、不装也能用」。connect 本身是模型 Provider，不涉及 web 搜索。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 背景：自 WorkBuddy 5.6（国际版 5.6.2）起，桌面端把 `auth.accessToken` 与
 * `auth.refreshToken` 以 `{$wbEncrypted:1, envelope:"<base64>"}` 信封形式落盘，
 * 而非明文。旧版读取逻辑只能拿到明文 token，于是在新版上会「明明登录了却读不到」。
 *
 * 算法（与桌面端 App 自身一致）：
 *   1) 运行 App 自带 Electron 二进制（`ELECTRON_RUN_AS_NODE=1`），用其**链接绑定**
 *      `process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`
 *      取回密封载荷 `{version:1, atRestSecretKey, atRestDeveloperPublicKey}`；
 *   2) `protectorKey = sha256(atRestSecretKey, "utf8")`；
 *   3) 用 AES-256-GCM 打开 envelope，AAD 由 `buildAuthenticatedContextAad`
 *      转录自 App 实现（见下方该函数的注释）。
 *
 * 安全约束（刻意为之）：
 * - 密钥与明文 token **只驻内存**，不写盘、不落日志；
 * - 错误信息只带尺寸/ID/退出码，绝不带密钥或 token 片段；
 * - key helper 单飞（single-flight），同一 keyId 只跑一次二进制。
 *
 * @module dsh-workbuddy-websearch/decrypt
 */
import { createHash, createDecipheriv } from "node:crypto";
import { spawn } from "node:child_process";

/** 支持的 envelope suite 版本。 */
const SUPPORTED_SUITE = 1;
/** AES-GCM 常量长度。 */
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
/** key helper 子进程超时。 */
const HELPER_TIMEOUT_MS = 15_000;
/** 被加密的字段名（顺序即 AAD 构造顺序）。 */
export const ENCRYPTED_FIELDS = ["accessToken", "refreshToken"];

/** 判定一个值是否是 `$wbEncrypted` 信封包装。 */
export function isEncryptedWrapper(value) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && value["$wbEncrypted"] === 1
    && typeof value["envelope"] === "string";
}

function parseBase64(value, exactLength) {
  if (typeof value !== "string" || value === "") return undefined;
  let decoded;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
  if (decoded.length === 0) return undefined;
  // 严格校验：重新编码后应还原（去掉 padding 差异），避免接受畸形输入。
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return undefined;
  if (exactLength !== undefined && decoded.length !== exactLength) return undefined;
  return decoded;
}

/**
 * 解析信封内层结构。返回 `{suite, keyId, nonce, authTag, ciphertext}`，
 * 任何一项不符合预期都返回 undefined（宁可判为「未识别」也不乱解）。
 */
export function parseEnvelope(wrapper) {
  if (!isEncryptedWrapper(wrapper)) return undefined;
  let inner;
  try {
    inner = JSON.parse(Buffer.from(wrapper["envelope"], "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined;
  const suite = inner["suite"];
  if (typeof suite !== "number" || !Number.isInteger(suite) || suite !== SUPPORTED_SUITE) return undefined;
  const keyId = inner["keyId"];
  if (typeof keyId !== "string" || !/^[0-9a-f]{16}$/u.test(keyId)) return undefined;
  const nonce = parseBase64(inner["nonce"], NONCE_BYTES);
  const authTag = parseBase64(inner["authTag"], AUTH_TAG_BYTES);
  const ciphertext = parseBase64(inner["ciphertext"]);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
  return { suite, keyId, nonce, authTag, ciphertext };
}

/**
 * 从已解析的 auth 文档中收集所有加密字段（去重、保持字段顺序）。
 * 未加密的文档返回空数组。
 */
export function collectEncryptedFields(document) {
  const auth = typeof document?.["auth"] === "object" && document["auth"] !== null
    ? document["auth"]
    : document;
  const found = [];
  for (const field of ENCRYPTED_FIELDS) {
    const wrapper = auth?.[field];
    const parsed = parseEnvelope(wrapper);
    if (parsed !== undefined) found.push({ field, ...parsed });
  }
  return found;
}

/** 文档是否至少含一个可解密的加密字段。 */
export function hasEncryptedFields(document) {
  return collectEncryptedFields(document).length > 0;
}

/**
 * GCM 的附加认证数据（AAD）。
 *
 * **逐字节转录自 `dsh-workbuddy-connect`（Corrine Hu, MIT c 2026）**
 * 的 `buildAuthenticatedContextAad`，后者又在真实 WorkBuddy 5.6.2 桌面端上
 * 验证过——该函数本身转录自 App bundle 的同名实现。
 *
 * 结构：固定前缀 `WB-AAD\0`，随后是版本字节、两个长度前缀字符串
 * （帧类型 `WBEV1`、密钥族 `sym-v1`）、suite 的 32 位大端、长度前缀的 keyId，
 * 最后三个固定字节 `02 00 00`。
 *
 * 帧类型 `WBEV1` 表示「凭据字段（field）」这一族。同族还有 WBEF1/WBER1/WBES1，
 * 属于其他文档类型，本模块**刻意不实现**——解凭据字段不是可以靠猜未来格式的地方。
 */
export function buildAuthenticatedContextAad(keyId, suite) {
  const prefix = Buffer.from("WB-AAD\0", "ascii");
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    prefix,
    Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 由 atRestSecretKey 推出 AES-256-GCM 密钥。 */
export function protectorKeyFrom(secretKey) {
  return createHash("sha256").update(String(secretKey), "utf8").digest();
}

/**
 * 解开单个字段。`keys` 为 `keyId -> Buffer(32)` 的映射。
 * 失败返回 undefined —— 失败即「格式不符或密钥不对」，不做重试、不试其他帧类型。
 */
export function decryptField(entry, keys) {
  const key = keys.get(entry.keyId);
  if (key === undefined) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, entry.nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(buildAuthenticatedContextAad(entry.keyId, entry.suite));
    decipher.setAuthTag(entry.authTag);
    const plaintext = Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // 认证失败（密钥不符/密文被改动）——不带任何敏感信息地失败。
    return undefined;
  }
}

/**
 * 校验 key helper 的返回是否符合 App 自身的规则：`version === 1` 且
 * atRestSecretKey 是规范的 32 字节 base64、非全零。不符合返回 undefined。
 *
 * 载荷里还有 `atRestDeveloperPublicKey`（开发期公钥，本插件用不到）；
 * 校验只针对**必需的**两个字段，多余字段一律容忍——App 加字段不应让插件失效。
 */
export function parseAtRestPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  if (parsed["version"] !== 1) return undefined;
  const secret = parsed["atRestSecretKey"];
  if (typeof secret !== "string" || secret === "") return undefined;
  let decoded;
  try {
    decoded = Buffer.from(secret, "base64");
  } catch {
    return undefined;
  }
  if (decoded.length !== 32) return undefined;
  if (decoded.toString("base64") !== secret) return undefined;
  if (decoded.every((byte) => byte === 0)) return undefined;
  return { atRestSecretKey: secret };
}
/**
 * key helper 脚本：在 App 自带 Electron 里以 Node 模式运行，
 * 读回密封载荷并打印到 stdout。刻意保持最小：只取 key，不做别的。
 *
 * ⚠️ 绑定名与调用方式**必须**与 WorkBuddy 改版 Electron 实际注册的一致：
 *   `process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`
 *
 * 两个易错点（都曾在真实设备上导致「登录了却解不开」）：
 * - 绑定名是 `electron_browser_workbuddy_storage`，**不是** `workbuddyStorage`；
 * - 必须走 `process._linkedBinding`（链接绑定），**不是** `process.binding`
 *   —— 后者查的是 Node 内置绑定表，WorkBuddy 的绑定不在其中，会报
 *   `No such module`。App 自身也是把它挂在 `electron.workbuddyStorage` 上用的。
 *
 * `loggerGet()` 是**同步**返回，且返回的是 JSON **字符串**（不是对象），
 * 因此这里 `String(...)` 后直接写 stdout，由 `parseAtRestPayload` 解析。
 * 失败时把原因码写 stderr 并置非零退出码，由 `runElectronKeyHelper` 转成拒绝。
 */
const KEY_HELPER_SOURCE = `
let payload;
try {
  payload = process._linkedBinding("electron_browser_workbuddy_storage").loggerGet();
} catch (error) {
  process.stderr.write(String(error?.code ?? error?.message ?? "unknown"));
  process.exitCode = 1;
}
if (payload !== undefined && payload !== null) process.stdout.write(String(payload));
`;

/**
 * 运行 Electron key helper，取回 `{version, atRestSecretKey}`。
 *
 * 用 `ELECTRON_RUN_AS_NODE=1` 让 App 二进制退化成 Node 解释器，
 * 从而能访问其私有绑定。用 `-e` 内联脚本，避免落盘临时文件。
 */
export function runElectronKeyHelper(electronBin, { timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(electronBin, ["-e", KEY_HELPER_SOURCE], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`electron key helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`electron key helper exited with code ${code}${stderr !== "" ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      const payload = parseAtRestPayload(stdout);
      if (payload === undefined) {
        reject(new Error("electron key helper returned an unexpected payload shape"));
        return;
      }
      resolve(payload);
    });
  });
}

/** keyId -> 密钥 的内存缓存（单飞：同一 keyId 只解一次）。 */
const keyCache = new Map();
let inflight;

/**
 * 取得 keyId 对应的解密密钥，带内存缓存与单飞。
 *
 * @param {string[]} keyIds 需要的 keyId 列表
 * @param {string|undefined} electronBin App 的 Electron 二进制路径
 * @returns {Promise<Map<string, Buffer>>} 可用密钥（可能不含个别 keyId）
 */
export async function resolveDecryptionKeys(keyIds, electronBin) {
  const unique = [...new Set(keyIds)];
  const missing = unique.filter((id) => !keyCache.has(id));
  if (missing.length > 0 && electronBin !== undefined) {
    inflight ??= runElectronKeyHelper(electronBin)
      .then((payload) => {
        const key = protectorKeyFrom(payload.atRestSecretKey);
        // helper 返回的是「当前 key」，把它记到所有缺失的 keyId 上；
        // 真实场景中同一时刻只有一个活跃 keyId，多 keyId 说明密钥已轮换，
        // 此时未命中的字段会解不开 —— 这是可接受的降级（下次刷新即自愈）。
        for (const id of missing) keyCache.set(id, key);
      })
      .catch(() => { /* 交给下面统一降级 */ })
      .finally(() => { inflight = undefined; });
    await inflight;
  }
  const keys = new Map();
  for (const id of unique) {
    const key = keyCache.get(id);
    if (key !== undefined) keys.set(id, key);
  }
  return keys;
}

/** 清空密钥缓存（测试用）。 */
export function __clearKeyCache() {
  keyCache.clear();
  inflight = undefined;
}
