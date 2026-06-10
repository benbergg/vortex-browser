import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function readBackgroundDist(): string {
  const dir = "/Users/lg/workspace/vortex/packages/extension/dist/assets/";
  const f = readdirSync(dir).find((f) => f.startsWith("background.ts"));
  if (!f) throw new Error("background.ts dist not found — 需先 pnpm build");
  return readFileSync(join(dir, f), "utf8");
}

describe("observe content-card 判据 page-side 内联(dist 静态分析)", () => {
  // esbuild 压缩本地 const 名(实测 hasFrameworkClick/hasFinerPointer 在 dist 计数=0),
  // 故不能 grep 内联函数名;改用 DOM 方法名 createTreeWalker 作哨兵——属性访问压缩存活,
  // 且当前 inject func 未用到它(实测 dist 计数=0),内联 hasOwnContentText 后必 ≥1。
  it("dist 含内联 hasOwnContentText 的 createTreeWalker 调用 ≥1 次", () => {
    const dist = readBackgroundDist();
    expect((dist.match(/createTreeWalker/g) || []).length).toBeGreaterThanOrEqual(1);
  });
});
