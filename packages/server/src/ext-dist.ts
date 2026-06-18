import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * 解析**本 server 进程对应的**扩展 dist 目录。
 *
 * 运行期本文件位于 packages/server/dist/src/ext-dist.js,扩展 dist 在
 * packages/server/../extension/dist = packages/extension/dist。worktree 场景下
 * 这天然指向「本 worktree 的扩展 dist」,与 NM host 注册的 server 一致——这正是
 * dev-reload 验证「加载的扩展 == 本 server 服务的 dist」(C1 路径错配)的锚点。
 */
export function resolveExtensionDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../extension/dist");
}

/**
 * 读 dist/build-stamp.txt(vite 构建时写入的本次构建戳)。
 * 文件不存在(旧构建未带 stamp 插件)或读失败 → 返回 null,调用方降级处理。
 */
export function readBuildStamp(extDist: string): string | null {
  try {
    return readFileSync(resolve(extDist, "build-stamp.txt"), "utf-8").trim() || null;
  } catch {
    return null;
  }
}
