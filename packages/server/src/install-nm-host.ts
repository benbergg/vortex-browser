import { writeFileSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NM_HOST_NAME = "com.vortexbrowser.host";

/** 有效的 Chrome 扩展 ID：32 位小写字母 */
const EXTENSION_ID_RE = /^[a-z]{32}$/;

export interface InstallResult {
  /** NM manifest 文件完整路径 */
  manifestPath: string;
  /** native-host.sh 完整路径（写入 manifest 的 path 字段） */
  nativeHostPath: string;
  /** NM 宿主名称，固定为 com.vortexbrowser.host */
  hostName: string;
}

/**
 * 注册 Chrome Native Messaging 宿主 manifest。
 *
 * 路径计算：编译后此文件位于 dist/src/install-nm-host.js，
 * native-host.sh 位于包根 packages/server/native-host.sh，
 * 即 __dirname/../../native-host.sh。
 *
 * @param extensionId 32 位小写字母的 Chrome 扩展 ID
 * @throws VtxError(INVALID_PARAMS) 若 extensionId 为空或格式非法
 */
export function installNmHost(extensionId: string): InstallResult {
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

  let nmHostDir: string;
  if (platform() === "darwin") {
    nmHostDir = join(
      homedir(),
      "Library/Application Support/Google/Chrome/NativeMessagingHosts"
    );
  } else {
    nmHostDir = join(homedir(), ".config/google-chrome/NativeMessagingHosts");
  }

  mkdirSync(nmHostDir, { recursive: true });
  const manifestPath = join(nmHostDir, `${NM_HOST_NAME}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    manifestPath,
    nativeHostPath,
    hostName: NM_HOST_NAME,
  };
}
