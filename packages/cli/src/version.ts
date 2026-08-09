/**
 * Author: qingwa
 * Description: Resolves the CLI version from the nearest package.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 向上找最近的 package.json 取版本。
 * 源码在 src/、产物在 dist/src/，距包根层级不同，固定相对路径必有一种布局落空。
 */
export function readNearestVersion(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 5; i++) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`package.json not found above ${fromUrl}`);
}
