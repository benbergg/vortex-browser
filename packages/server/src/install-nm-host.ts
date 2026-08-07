import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NM_HOST_NAME = "com.vortexbrowser.host";

/**
 * 默认扩展 ID(方案 B:manifest.json 钉死 `key` 字段固定的 ID)。
 * 因为扩展用固定公钥,load unpacked / 自签 .crx 都得到同一个 ID,
 * 所以 `vortex-server install` 不带参时用此默认值即可,无需用户复制粘贴 ID。
 * 商店分发若 ID 不同,可 `vortex-server install <id>` 覆盖。
 */
export const DEFAULT_EXTENSION_ID = "fbonhjdohmkcejfgmaicnkknpfafihnd";

/** 有效的 Chrome 扩展 ID：32 位小写字母 */
const EXTENSION_ID_RE = /^[a-z]{32}$/;

export interface InstallResult {
  /** NM manifest 文件完整路径（多 channel 时为第一个） */
  manifestPath: string;
  /** 本次写入的全部 manifest 路径 */
  manifestPaths: string[];
  /** 本次实际写入的 channel */
  installed: ChannelNmDir[];
  /** native-host.sh 完整路径（写入 manifest 的 path 字段） */
  nativeHostPath: string;
  /** NM 宿主名称，固定为 com.vortexbrowser.host */
  hostName: string;
}

export interface ChannelNmDir {
  /** 展示名，用于 CLI 输出 */
  label: string;
  /** 浏览器用户数据目录，存在即视为该 channel 装过 */
  profileDir: string;
  /** 该 channel 的 NM manifest 目录 */
  nmDir: string;
}

/** darwin 与其他平台的产品目录名差异（Dev channel 在 Linux 叫 unstable）。 */
const CHANNELS: ReadonlyArray<{ label: string; darwin: string; posix?: string }> = [
  { label: "Google Chrome", darwin: "Google/Chrome", posix: "google-chrome" },
  { label: "Google Chrome Beta", darwin: "Google/Chrome Beta", posix: "google-chrome-beta" },
  { label: "Google Chrome Dev", darwin: "Google/Chrome Dev", posix: "google-chrome-unstable" },
  { label: "Google Chrome Canary", darwin: "Google/Chrome Canary" },
  { label: "Google Chrome for Testing", darwin: "Google/Chrome for Testing" },
  { label: "Chromium", darwin: "Chromium", posix: "chromium" },
  { label: "Microsoft Edge", darwin: "Microsoft Edge", posix: "microsoft-edge" },
  { label: "Microsoft Edge Beta", darwin: "Microsoft Edge Beta", posix: "microsoft-edge-beta" },
  { label: "Microsoft Edge Dev", darwin: "Microsoft Edge Dev", posix: "microsoft-edge-dev" },
  { label: "Microsoft Edge Canary", darwin: "Microsoft Edge Canary" },
];

/**
 * 枚举各 Chromium 系 channel 的 NM manifest 目录。纯函数，不碰文件系统。
 *
 * 缺 posix 字段的 channel 不发布 Linux 版，故只出现在 darwin 结果里。
 * Chrome stable 恒为第一项——单 channel 安装取 [0]。
 */
export function channelNmDirs(home: string, plat: string): ChannelNmDir[] {
  const isMac = plat === "darwin";
  const out: ChannelNmDir[] = [];
  for (const c of CHANNELS) {
    const rel = isMac ? join("Library/Application Support", c.darwin) : c.posix && join(".config", c.posix);
    if (!rel) continue;
    const profileDir = join(home, rel);
    out.push({ label: c.label, profileDir, nmDir: join(profileDir, "NativeMessagingHosts") });
  }
  return out;
}

export interface InstallOptions {
  /** 装到所有已安装的 channel，而非仅 Chrome stable */
  allChannels?: boolean;
}

export interface InstallArgs {
  extensionId: string;
  usingDefault: boolean;
  allChannels: boolean;
}

/**
 * 解析 `vortex-server install` 的参数。
 *
 * Chrome 拉起 NM host 时会追加 chrome-extension://<id>/ 位置参数，
 * 故只认裸 ID，flag 与 origin 一律不当 ID。
 */
export function parseInstallArgs(argv: readonly string[]): InstallArgs {
  const rest = argv.slice(3);
  const id = rest.find((a) => EXTENSION_ID_RE.test(a));
  return {
    extensionId: id ?? DEFAULT_EXTENSION_ID,
    usingDefault: id === undefined,
    allChannels: rest.includes("--all-channels"),
  };
}

/**
 * 注册 Chrome Native Messaging 宿主 manifest。
 *
 * 路径计算：编译后此文件位于 dist/src/install-nm-host.js，
 * native-host.sh 位于包根 packages/server/native-host.sh，
 * 即 __dirname/../../native-host.sh。
 *
 * @param extensionId 32 位小写字母的 Chrome 扩展 ID
 * @param opts allChannels=true 时装到所有已安装的 Chromium 系 channel
 * @throws VtxError(INVALID_PARAMS) 若 extensionId 为空或格式非法
 */
export function installNmHost(extensionId: string, opts: InstallOptions = {}): InstallResult {
  if (!extensionId || !EXTENSION_ID_RE.test(extensionId)) {
    throw vtxError(
      VtxErrorCode.INVALID_PARAMS,
      `Invalid extension ID: "${extensionId}". ` +
        "Expected 32 lowercase letters (a-z), e.g. abcdefghijklmnopabcdefghijklmnop",
      { extras: { extensionId } },
    );
  }

  // 编译后 __dirname = dist/src/，包根在 dist/src/../../ = packages/server/
  // native-host.sh 在包根下，即 join(__dirname, "..", "..", "native-host.sh")
  const nativeHostPath = resolve(join(__dirname, "..", "..", "native-host.sh"));

  const manifest = {
    name: NM_HOST_NAME,
    description: "Vortex browser automation middleware",
    path: nativeHostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  const channels = channelNmDirs(homedir(), platform());
  // 单 channel 走 Chrome stable 且不检查目录存在(全新机器也要能装);
  // all-channels 是「扫描已装的」,不给没装的浏览器留空壳目录。
  const targets = opts.allChannels
    ? channels.filter((c) => existsSync(c.profileDir))
    : [channels[0]];

  const manifestPaths: string[] = [];
  for (const c of targets) {
    mkdirSync(c.nmDir, { recursive: true });
    const p = join(c.nmDir, `${NM_HOST_NAME}.json`);
    writeFileSync(p, JSON.stringify(manifest, null, 2));
    manifestPaths.push(p);
  }

  return {
    manifestPath: manifestPaths[0],
    manifestPaths,
    installed: targets,
    nativeHostPath,
    hostName: NM_HOST_NAME,
  };
}
