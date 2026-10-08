/**
 * 平台相关的路径与二进制定位（自带实现，不依赖任何外部插件）。
 *
 * ───────────────────────────── 来源与致谢 ─────────────────────────────
 * 本模块的**平台规则**借鉴自 `dsh-workbuddy-connect`（Corrine Hu, MIT c 2026）
 * 的 `defaultDesktopAuthCandidates` / `defaultWorkBuddyElectronPath`：
 * - Windows 需同时探测 Local 与 Roaming（只探一个会把「已登录」误判为未登录）；
 * - macOS 路径 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`；
 * - macOS Electron 默认路径取自其记录的官方安装布局；
 * - 「国际版 Windows 端不给默认路径，宁可不猜」这一取舍直接沿用其决定；
 * - `WORKBUDDY_*_AUTH_FILE` / `WORKBUDDY_*_ELECTRON_BIN` 变量名沿用其约定，
 *   使两插件共存时用户配置无需改写。
 *
 * 我们是**重写**而非复制：connect 的相关逻辑与其业务强耦合（含探测服务、
 * 心跳、目录存储等），这里只抽出「路径与定位」这一最小必要面，
 * 并补上了 WSL 与 XDG 分支的独立实现。详见 `CREDITS.md` §1.2–1.4。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 目标：本插件在「没有任何其他 dsh 插件」的干净环境里也能独立定位
 * WorkBuddy / WorkBuddy AI 桌面端的凭据文件与 Electron 二进制。
 *
 * 平台覆盖（macOS 为**实验性**）：
 * - win32（稳定）：`%LOCALAPPDATA%` / `%APPDATA%` 下的共享 auth 目录；
 * - darwin（实验性）：`~/Library/Application Support/` 下的同名目录；
 * - linux / 其他（实验性兜底）：XDG 规范目录，另对 WSL 探测宿主 Windows 路径。
 *
 * 说明：WorkBuddy 桌面端目前只发布 Windows 与 macOS 版本；Linux 分支仅为
 * 「在 Linux/WSL 上读取宿主已安装的 Windows 桌面端凭据」这一场景保留。
 *
 * @module dsh-workbuddy-websearch/platform
 */
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** 共享 auth 目录（两版 App 写同一目录，仅文件名不同）。 */
const AUTH_DIR_SEGMENTS = ["CodeBuddyExtension", "Data", "Public", "auth"];

/** 国内版 / 国际版桌面端凭据文件名。 */
export const DESKTOP_AUTH_FILENAME_CN = "workbuddy-desktop.info";
export const DESKTOP_AUTH_FILENAME_AI = "workbuddy-desktop-ai.info";

/** 插件自有副本文件名（写在 dsh-home 下，作为跨设备/备份兜底）。 */
export const OWN_AUTH_FILENAME_CN = ".workbuddy-auth.json";
export const OWN_AUTH_FILENAME_AI = ".workbuddy-ai-auth.json";

/** 环境变量名。 */
export const ENV_AUTH_FILE_CN = "WORKBUDDY_AUTH_FILE";
export const ENV_AUTH_FILE_AI = "WORKBUDDY_AI_AUTH_FILE";
export const ENV_ELECTRON_BIN_CN = "WORKBUDDY_ELECTRON_BIN";
export const ENV_ELECTRON_BIN_AI = "WORKBUDDY_AI_ELECTRON_BIN";

/**
 * 两个「变体」的定义。字段形状与 dsh-workbuddy-connect 的
 * `WORKBUDDY_VARIANTS` 保持**结构兼容**，这样当 connect 存在时，本插件
 * 生成的 variant 可以直接喂给它的 store（见 connect-bridge）。
 *
 * 这里刻意只保留本插件真正用得到的信息（区域、文件名、环境变量、
 * Electron 平台默认路径），不复制 connect 的业务逻辑。
 */
export const VARIANTS = [
  {
    id: "workbuddy",
    displayName: "WorkBuddy",
    appName: "WorkBuddy",
    region: "cn",
    desktopFilename: DESKTOP_AUTH_FILENAME_CN,
    ownFilename: OWN_AUTH_FILENAME_CN,
    env: ENV_AUTH_FILE_CN,
    electron: {
      productName: "WorkBuddy",
      envVar: ENV_ELECTRON_BIN_CN,
      /** macOS（实验性）：官方安装包的默认布局。 */
      macosPath: "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
      /** macOS bundle id（仅诊断用）。 */
      macosBundleId: "com.tencent.workbuddy.mac",
      /** Windows：相对 %LOCALAPPDATA% 的默认布局。 */
      windowsPathSegments: ["Programs", "WorkBuddy", "WorkBuddy.exe"],
      /** Windows：可执行文件名（注册表/目录扫描时用）。 */
      windowsExeBasename: "workbuddy.exe",
      /**
       * Windows：卸载注册表里 `DisplayName` 的形状。
       *
       * 官方安装器写 `WorkBuddy`；带版本号后缀的变体（如 `WorkBuddy 1.2.3`）
       * 也接受。刻意**不匹配** `WorkBuddy AI` —— 那是另一个产品，由下面的
       * 国际版变体负责，两者不能互相误选。
       */
      windowsDisplayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
    },
  },
  {
    id: "workbuddy-ai",
    displayName: "WorkBuddy AI",
    appName: "WorkBuddy AI",
    region: "global",
    desktopFilename: DESKTOP_AUTH_FILENAME_AI,
    ownFilename: OWN_AUTH_FILENAME_AI,
    env: ENV_AUTH_FILE_AI,
    electron: {
      productName: "WorkBuddy AI",
      envVar: ENV_ELECTRON_BIN_AI,
      macosPath: "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron",
      macosBundleId: "com.workbuddy.workbuddy-ai",
      /**
       * 国际版 Windows 端没有经过验证的默认安装位置（社区反馈为自定义路径），
       * 因此不给默认段，交给注册表发现或用户显式指定环境变量。
       * 与 dsh-workbuddy-connect 的取舍保持一致：宁可不猜，也不猜错。
       */
      windowsPathSegments: undefined,
      windowsExeBasename: "workbuddyai.exe",
      /** Windows：卸载注册表里 `DisplayName` 的形状（见国内版处的说明）。 */
      windowsDisplayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
    },
  },
];

/** 按 region 取 variant。 */
export function variantForRegion(region) {
  return region === "global" ? VARIANTS[1] : VARIANTS[0];
}

/** 是否运行在 WSL 内（Linux 分支判定用）。 */
export function isWsl(env = process.env) {
  if (process.platform !== "linux") return false;
  if (env["WSL_DISTRO_NAME"] !== undefined || env["WSL_INTEROP"] !== undefined) return true;
  return /microsoft/i.test(env["OS"] ?? "") || /microsoft/i.test(env["WSLENV"] ?? "");
}

/** 把 Windows 盘符路径转成 WSL 的 `/mnt/<drive>` 形式；非 Windows 路径原样返回。 */
export function windowsPathForWsl(value) {
  const path = typeof value === "string" ? value.trim() : "";
  if (path === "") return undefined;
  if (path.startsWith("/")) return path;
  const match = /^([a-z]):[\\/](.*)$/iu.exec(path);
  if (match === null) return undefined;
  return join("/mnt", match[1].toLowerCase(), ...match[2].split(/[\\/]+/u));
}

/** XDG 基准目录：环境变量优先（须为绝对路径），否则回落默认。 */
function xdgBase(env, envName, fallback) {
  const value = typeof env[envName] === "string" ? env[envName].trim() : "";
  if (value !== "" && value.startsWith("/")) return value;
  return fallback;
}

/**
 * 桌面端 auth 目录候选（**不含文件名**），按探测顺序。
 *
 * - darwin：单一位置（`~/Library/Application Support/...`）。
 * - win32：Local 与 Roaming 都探——新版写 Local，旧版写 Roaming；
 *   只探一个会把「已登录」误判成「未登录」。
 * - linux：XDG config/data 都探（多数发行版写 config，UOS/deepin 写 data）；
 *   在 WSL 下额外前置宿主 Windows 的对应目录。
 */
export function desktopAuthDirs(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", ...AUTH_DIR_SEGMENTS)];
  }
  if (platform === "win32") {
    return [
      join(home, "AppData", "Local", ...AUTH_DIR_SEGMENTS),
      join(home, "AppData", "Roaming", ...AUTH_DIR_SEGMENTS),
    ];
  }
  if (platform === "linux") {
    const configHome = xdgBase(env, "XDG_CONFIG_HOME", join(home, ".config"));
    const dataHome = xdgBase(env, "XDG_DATA_HOME", join(home, ".local", "share"));
    const native = dedupe([
      join(configHome, ...AUTH_DIR_SEGMENTS),
      join(dataHome, ...AUTH_DIR_SEGMENTS),
    ]);
    if (!isWsl(env)) return native;
    // WSL：先看宿主 Windows 的登录态，再看 Linux 原生目录。
    const profile = windowsPathForWsl(env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
    const hostLocal = windowsPathForWsl(env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
    const hostRoaming = windowsPathForWsl(env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
    return dedupe([
      join(hostLocal, ...AUTH_DIR_SEGMENTS),
      join(hostRoaming, ...AUTH_DIR_SEGMENTS),
      ...native,
    ]);
  }
  // 其他平台（如未来的鸿蒙 PC）：不代表支持，只是给出可探测路径，
  // 由 available() 的实际读文件结果决定最终是否可用。
  return [join(home, ".config", ...AUTH_DIR_SEGMENTS)];
}

function dedupe(values) {
  return [...new Set(values)];
}

/**
 * 桌面端凭据文件候选（含文件名），按探测顺序。两版使用同一目录，
 * 只切换文件名，因此顺序完全复用上面的目录顺序。
 *
 * ⚠️ 签名注意：本函数**首参是 variant**（用于取文件名），与相邻的
 * `desktopAuthDirs(platform, env, home)` 不同。这样设计是为了让最常见的
 * 「按 variant 枚举全部候选文件」写成最简形式 `desktopAuthFiles(v)`。
 * 需要跨平台模拟时显式传第二、三、四参。
 *
 * 对 `null` / `undefined` / 缺失 `desktopFilename` 的 variant 返回 `[]`，
 * 不抛生僻的 `Cannot read properties of undefined`——调用方（含探针脚本）
 * 可安全地枚举而无需先自行校验。
 */
export function desktopAuthFiles(
  variant,
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (variant === null || typeof variant !== "object" || typeof variant.desktopFilename !== "string" || variant.desktopFilename === "") {
    return [];
  }
  return desktopAuthDirs(platform, env, home).map((dir) => join(dir, variant.desktopFilename));
}

/**
 * Windows：在**常见安装根**下按可执行文件名做有界扫描。
 *
 * 补上两类「默认布局」覆盖不到的情况：
 * - **系统级安装**（`%ProgramFiles%\WorkBuddy\`，而非 per-user 的 `%LOCALAPPDATA%\Programs\`）；
 * - **目录名带后缀/变体**（如 `%LOCALAPPDATA%\Programs\WorkBuddy AI\`）。
 *
 * 边界（刻意保守）：
 * - 只扫**固定几个根目录**下的**一层**子目录，且只认目录名以 `WorkBuddy` 开头的，
 *   不做全盘遍历、不枚举盘符（枚举盘符可能卡在失联的网络驱动器上）；
 * - 任何一步失败（权限 / IO / 目录不存在）都静默跳过——探测函数不应抛错。
 *
 * ⚠️ 仍覆盖不到：用户把 App 装到**自选盘符或自定义路径**
 * （例如 `<安装盘>:\<任意目录>\`）。这种情形交给下游的
 * `resolveElectronFromRegistry`（卸载注册表里有 `InstallLocation` / `DisplayIcon`），
 * 再兜不住才要求用户用 `WORKBUDDY_*_ELECTRON_BIN` 显式指定 —— 本插件不枚举盘符、不猜。
 *
 * @returns 命中的绝对路径；未命中返回 `undefined`。
 */
export function scanWindowsInstallRoots(exeBasename, env = process.env) {
  if (typeof exeBasename !== "string" || exeBasename === "") return undefined;
  const roots = [
    typeof env["LOCALAPPDATA"] === "string" ? join(env["LOCALAPPDATA"], "Programs") : undefined,
    env["ProgramFiles"],
    env["ProgramW6432"],
    env["ProgramFiles(x86)"],
  ];
  const seen = new Set();
  for (const root of roots) {
    if (typeof root !== "string" || root.trim() === "") continue;
    const dir = root.trim();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^workbuddy/iu.test(entry.name)) continue;
      const candidate = join(dir, entry.name, exeBasename);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 定位桌面端 Electron 二进制（解密 `$wbEncrypted` 凭据需要用它跑 key helper）。
 *
 * 解析顺序（**从便宜到昂贵**，见下方每条的理由）：
 *   1) 显式环境变量（最可靠，用户可强制覆盖）；
 *   2) 平台默认路径（macOS 已验证；Windows 国内版有已验证的 per-user 默认位置）；
 *   3) Windows 常见安装根的一层有界扫描（`scanWindowsInstallRoots`，纯读目录）；
 *   4) **Windows 卸载注册表记录**（`findElectronFromUninstallRecords`）。
 *      放在最后是因为它是**唯一会起子进程的一步**（`reg.exe`），而本函数会被
 *      同步的 `available()` 调用；前面几步命中时就不该付这个成本。
 *      覆盖的正是前几步都够不到的情形：**两版装在同一个目录**（目录名只叫
 *      `WorkBuddy`，国际版那条扫描规则匹配不到）、**自选盘符或自定义路径**
 *      （默认布局与常见根都在系统盘）、以及系统级安装。
 *   5) 都失败返回 undefined（调用方据此给出明确指引，而不是瞎猜）。
 *
 * 注意：**本函数只读不跑**。真正执行二进制的是 `decrypt.mjs`。
 *
 * ⚠️ 首参是 **variant 对象**（不是字符串 id）。若误传字符串会取不到
 * `variant.electron`，故先做守卫：非对象或缺 `electron` 时直接返回 `undefined`，
 * 而不是抛 `Cannot read properties of undefined`。调用方据此走「未找到」分支。
 *
 * @param variant - 变体定义。
 * @param env - 环境变量表（可注入，便于测试）。
 * @param options.registry - 传 `false` 可完全跳过注册表（测试与诊断用）。
 * @param options.registryRunner - 注入 `reg query` 执行器（返回 stdout 字符串）。
 */
export function resolveElectronBinary(variant, env = process.env, options = {}) {
  if (variant === null || typeof variant !== "object" || typeof variant.electron !== "object" || variant.electron === null) {
    return undefined;
  }
  const explicit = env[variant.electron.envVar];
  if (typeof explicit === "string" && explicit.trim() !== "" && existsSync(explicit.trim())) {
    return explicit.trim();
  }
  if (process.platform === "darwin" && variant.electron.macosPath !== undefined) {
    if (existsSync(variant.electron.macosPath)) return variant.electron.macosPath;
  }
  if (process.platform === "win32") {
    const local = env["LOCALAPPDATA"];
    const segments = variant.electron.windowsPathSegments;
    if (segments !== undefined && typeof local === "string" && local.trim() !== "") {
      const guess = join(local.trim(), ...segments);
      if (existsSync(guess)) return guess;
    }
    const scanned = scanWindowsInstallRoots(variant.electron.windowsExeBasename, env);
    if (scanned !== undefined) return scanned;
    const fromRegistry = resolveElectronFromRegistry(variant, env, options);
    if (fromRegistry !== undefined) return fromRegistry;
  }
  return undefined;
}

// ───────────────────── Windows 卸载注册表发现 ─────────────────────
//
// 为什么需要这一步：国内版与国际版可以**装进同一个目录**（实测
// `<安装盘>:\Programs\WorkBuddy\` 下 `WorkBuddy.exe` 与 `WorkBuddyAI.exe` 并排），
// 此时目录扫描的「目录名须以 WorkBuddy 开头」规则对国际版失效（目录名里没有
// ` AI`），而国际版又没有已验证的默认安装位置 —— 于是两版都自动发现不到。
// 卸载注册表记录里有 `InstallLocation` 与 `DisplayIcon`，是这种情况下唯一可靠
// 且不靠猜的信息源。
//
// 设计取向与 `dsh-workbuddy-connect` 一致（该实现久经验证）：
// - 三处 Uninstall 根都查（HKCU / HKLM / WOW6432Node）；
// - **注册表只是线索，不是信任**：每个候选都必须过 Electron 布局校验；
// - 按 realpath 去重；**多于一个就报歧义，不猜**；
// - `reg.exe` 用绝对路径调（`%SystemRoot%\System32\reg.exe`），不走 PATH；
// - 查询结果**按进程缓存一次** —— 这是子进程，不能让同步的 `available()` 每次都跑。

/** Electron 布局校验：`version` 文件的形状（实测为 `37.10.3-24`）。 */
const ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** `reg.exe` 单次查询的超时与输出上限（防呆，不追求大而全）。 */
const REGISTRY_TIMEOUT_MS = 4_000;
const REGISTRY_MAX_BYTES = 1_048_576;

/** Windows 卸载记录所在的三处注册表根。 */
export const WINDOWS_UNINSTALL_ROOTS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/**
 * 剥出 `DisplayIcon` 里的可执行文件路径。
 *
 * 实测可能出现的写法（`<安装盘>` 为占位符，本仓库不写具体盘符）：
 *   `"<安装盘>:\dir\App.exe",0`  /  `<安装盘>:\dir\App.exe,0`  /  `<安装盘>:\dir\App.exe`
 * 未加引号时去掉尾部的 `,<数字>` 图标索引。
 *
 * @returns 路径；无法解析时返回 undefined。
 */
export function parseDisplayIcon(value) {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  if (text === "") return undefined;
  if (text.startsWith("\"")) {
    const end = text.indexOf("\"", 1);
    if (end === -1) return undefined;
    text = text.slice(1, end);
  } else {
    text = text.replace(/,\s*-?\d+\s*$/u, "");
  }
  text = text.trim();
  return text === "" ? undefined : text;
}

/**
 * 解析 `reg query <根> /s` 的输出，**不过滤**，逐条取出我们关心的三个值。
 *
 * 输出形如（`<安装盘>` 为占位符）：
 * ```
 * HKEY_LOCAL_MACHINE\...\Uninstall\WorkBuddy AI
 *     DisplayName     REG_SZ    WorkBuddy AI
 *     DisplayIcon     REG_SZ    "<安装盘>:\Programs\WorkBuddy\WorkBuddyAI.exe",0
 *     InstallLocation REG_SZ    <安装盘>:\Programs\WorkBuddy
 * ```
 * 只认这三个值名；其余（含 `REG_EXPAND_SZ` 等类型与本地化列名）一律忽略。
 * 值名大小写不敏感（`reg.exe` 回显原始大小写）。
 *
 * 过滤交给调用方（`findElectronFromUninstallRecords`），这样一次查询的解析结果
 * 两个变体可以共用，不必为每版各跑一次 `reg.exe`。
 */
export function parseUninstallRecords(output) {
  const entries = new Map();
  let current;
  for (const line of String(output ?? "").split(/\r?\n/u)) {
    const keyMatch = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line);
    if (keyMatch !== null) {
      current = keyMatch[1];
      entries.set(current, {});
      continue;
    }
    if (current === undefined) continue;
    const valueMatch = /^\s+(DisplayName|DisplayIcon|InstallLocation)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line);
    if (valueMatch === null) continue;
    const entry = entries.get(current);
    if (entry === undefined) continue;
    entry[valueMatch[1].toLowerCase()] = valueMatch[2] ?? "";
  }
  const records = [];
  for (const entry of entries.values()) {
    const displayName = entry["displayname"];
    if (typeof displayName !== "string" || displayName.trim() === "") continue;
    const installLocation = entry["installlocation"];
    records.push({
      displayName: displayName.trim(),
      displayIcon: parseDisplayIcon(entry["displayicon"]),
      installLocation: typeof installLocation === "string" && installLocation.trim() !== ""
        ? installLocation.trim()
        : undefined,
    });
  }
  return records;
}

/**
 * Electron 布局校验：候选必须**真的是**该产品的 Electron 主程序。
 *
 * 三条判据（与 `dsh-workbuddy-connect` 一致）：
 *   1) 文件名等于该产品的 exe 名；
 *   2) 同目录有 `version` 文件，且形如 `37.10.3-24`（Electron 自己的版本号）；
 *   3) 同目录有 `resources/app.asar`。
 *
 * 只认这三条、不信任注册表：`DisplayIcon` 可能指向卸载程序（`Uninstall
 * WorkBuddy.exe`）或图标资源，光看路径会选错。
 *
 * @returns 校验通过时返回该路径，否则 undefined（**不抛错**）。
 */
export function inspectElectronCandidate(candidate, exeBasename, platform = process.platform) {
  if (typeof candidate !== "string" || candidate.trim() === "") return undefined;
  if (typeof exeBasename !== "string" || exeBasename === "") return undefined;
  const path = candidate.trim();
  if (platform === "win32" && basename(path).toLowerCase() !== exeBasename.toLowerCase()) return undefined;
  try {
    if (!statSync(path).isFile()) return undefined;
    accessSync(path, constants.X_OK);
  } catch {
    return undefined;
  }
  const installRoot = dirname(path);
  let version;
  try {
    version = readFileSync(join(installRoot, "version"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (!ELECTRON_VERSION_PATTERN.test(version)) return undefined;
  let entries;
  try {
    entries = readdirSync(join(installRoot, "resources"));
  } catch {
    return undefined;
  }
  if (!entries.includes("app.asar")) return undefined;
  // 返回**磁盘上的真实文件名**，而不是传进来的那个。调用方拼候选时用的是
  // `exeBasename`（全小写，如 `workbuddyai.exe`），直接返回会得到一个大小写
  // 不对的路径 —— Windows 文件系统不区分大小写所以能跑，但显示与比对都别扭。
  // （不用 realpathSync：实测在该环境下不会恢复大小写。）
  let actualName = basename(path);
  try {
    const siblings = readdirSync(installRoot);
    const hit = siblings.find((name) => name.toLowerCase() === actualName.toLowerCase());
    if (hit !== undefined) actualName = hit;
  } catch {
    // 读不到目录就用原名 —— 在 Windows 上照样能执行。
  }
  return join(installRoot, actualName);
}

/**
 * 从卸载记录里定位某产品的 Electron 主程序。
 *
 * 每条匹配的记录给出三类候选（都过布局校验，不预设哪一类对）：
 *   - `DisplayIcon` 本身；
 *   - `DisplayIcon` **同目录**下的该产品 exe 名（覆盖 DisplayIcon 指向卸载程序）；
 *   - `InstallLocation` 下的该产品 exe 名。
 *
 * 按 realpath 去重后：
 *   - 恰好一个 → `{ found: true, path }`
 *   - 多于一个 → `{ found: false, ambiguous: [...] }`（**不猜**，交给上层报诊断）
 *   - 没有     → `{ found: false, rejected: <候选数> }`
 *
 * @param records - `parseUninstallRecords` 的结果。
 * @param options.exeBasename - 该产品的 exe 名。
 * @param options.displayNamePattern - 该产品 `DisplayName` 的形状。
 */
export function findElectronFromUninstallRecords(records, { exeBasename, displayNamePattern, platform = process.platform } = {}) {
  const empty = { found: false, rejected: 0 };
  if (!Array.isArray(records) || typeof exeBasename !== "string" || exeBasename === "") return empty;
  if (!(displayNamePattern instanceof RegExp)) return empty;
  const candidates = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim() !== "") candidates.push(value.trim());
  };
  for (const record of records) {
    if (record === null || typeof record !== "object") continue;
    if (typeof record.displayName !== "string" || !displayNamePattern.test(record.displayName)) continue;
    push(record.displayIcon);
    if (typeof record.displayIcon === "string" && record.displayIcon.trim() !== "") {
      push(join(dirname(record.displayIcon.trim()), exeBasename));
    }
    if (typeof record.installLocation === "string" && record.installLocation.trim() !== "") {
      push(join(record.installLocation.trim(), exeBasename));
    }
  }
  const found = new Map();
  for (const candidate of candidates) {
    // `inspectElectronCandidate` 返回的已是磁盘上的真实文件名。
    const valid = inspectElectronCandidate(candidate, exeBasename, platform);
    if (valid === undefined) continue;
    let identity;
    try {
      identity = realpathSync(valid);
    } catch {
      identity = valid;
    }
    if (platform === "win32") identity = identity.toLowerCase();
    if (!found.has(identity)) found.set(identity, valid);
  }
  const paths = [...found.values()];
  if (paths.length === 0) return { found: false, rejected: candidates.length };
  if (paths.length > 1) return { found: false, ambiguous: paths };
  return { found: true, path: paths[0] };
}

/**
 * `reg query` 的默认执行器：**绝对路径**调 `%SystemRoot%\System32\reg.exe`。
 *
 * 不走 PATH —— 用户可改 PATH，而这是要执行的东西。查询不存在的键时
 * `reg.exe` 退出码为 1，这里当作「该根没有记录」返回空串而不是抛错。
 *
 * @returns `(root) => string`，root 为注册表根路径。
 */
export function defaultRegistryRunner(env = process.env) {
  return (root) => {
    const systemRoot = typeof env["SystemRoot"] === "string" ? env["SystemRoot"].trim() : "";
    if (systemRoot === "") throw new Error("SystemRoot 未配置");
    const regPath = join(systemRoot, "System32", "reg.exe");
    try {
      return execFileSync(regPath, ["query", root, "/s"], {
        encoding: "utf8",
        timeout: REGISTRY_TIMEOUT_MS,
        maxBuffer: REGISTRY_MAX_BYTES,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      // 退出码 1 = 该根不存在（正常）。其余（被拦 / 超时 / 无权限）同样按
      // 「这一根没给出信息」处理：**探测函数不应抛错**，更不该因为查不到
      // 注册表就让整个插件不可用。
      if (error?.status === 1) return "";
      return "";
    }
  };
}

/** 三处 Uninstall 根的解析结果缓存（**按进程一次**，见上方说明）。 */
let uninstallRecordsCache;

/**
 * 读取并缓存三处 Uninstall 根的记录。
 *
 * @param env - 环境变量表（取 `SystemRoot`）。
 * @param runner - 注入的执行器；省略时用 `defaultRegistryRunner(env)`。
 */
export function uninstallRecords(env = process.env, runner = undefined) {
  if (uninstallRecordsCache !== undefined) return uninstallRecordsCache;
  const run = typeof runner === "function" ? runner : defaultRegistryRunner(env);
  const records = [];
  for (const root of WINDOWS_UNINSTALL_ROOTS) {
    let output = "";
    try {
      output = run(root) ?? "";
    } catch {
      continue;
    }
    records.push(...parseUninstallRecords(output));
  }
  uninstallRecordsCache = records;
  return records;
}

/** 仅供测试与诊断：清掉注册表缓存（下一次查询会重新跑 `reg.exe`）。 */
export function resetUninstallRecordsCache() {
  uninstallRecordsCache = undefined;
}

/** 最近一次注册表定位的诊断结果（供 `__internals` 暴露）。 */
let lastRegistryOutcome;

/** 最近一次注册表定位的结果，供诊断输出。 */
export function lastElectronRegistryOutcome() {
  return lastRegistryOutcome;
}

/**
 * 从注册表定位某个变体的 Electron 主程序。
 *
 * @param options.registry - 传 `false` 完全跳过注册表。
 * @param options.registryRunner - 注入的 `reg query` 执行器（测试用）。
 * @param options.platform - 布局校验用的平台（默认 `process.platform`；
 *   测试里传 `"win32"` 才能在非 Windows 上覆盖到「exe 名须相符」这条判据）。
 * @returns 命中时返回路径；未命中 / 歧义 / 跳过时返回 undefined
 *   （歧义细节记在 `lastElectronRegistryOutcome()` 里）。
 */
export function resolveElectronFromRegistry(variant, env = process.env, options = {}) {
  const pattern = variant?.electron?.windowsDisplayNamePattern;
  const exeBasename = variant?.electron?.windowsExeBasename;
  if (options.registry === false || !(pattern instanceof RegExp) || typeof exeBasename !== "string") {
    lastRegistryOutcome = undefined;
    return undefined;
  }
  const outcome = findElectronFromUninstallRecords(
    uninstallRecords(env, options.registryRunner),
    { exeBasename, displayNamePattern: pattern, platform: options.platform ?? process.platform },
  );
  lastRegistryOutcome = outcome.found === true ? undefined : outcome;
  return outcome.found === true ? outcome.path : undefined;
}

