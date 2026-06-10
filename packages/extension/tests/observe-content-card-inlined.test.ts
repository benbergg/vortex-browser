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

import { readFileSync as _rf } from "node:fs";
const OBSERVE_SRC = _rf(
  "/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts",
  "utf8",
);

describe("observe v2:isSelfClickable 内联 + 信号 swap(源码锁)", () => {
  it("inject func 含内联 isSelfClickable 定义", () => {
    expect(OBSERVE_SRC).toMatch(/const isSelfClickable = \(el: Element\): boolean =>/);
  });
  it("门 1247 守卫用 !isSelfClickable", () => {
    expect(OBSERVE_SRC).toMatch(
      /querySelector\(INTERACTIVE_SELECTORS\) && !isSelfClickable\(el\)\) continue;/,
    );
  });
  it("Task6 内容卡内 icon-link 直接丢弃(continue),非置空名", () => {
    // formLike(<a href>)绕过 BUG-3 !name 过滤,置空名仍占 maxElements 预算饿死商品卡,
    // 故必须显式 continue 丢弃。
    expect(OBSERVE_SRC).toMatch(/\/\^icon-link @\/\.test\(name\)/);
    expect(OBSERVE_SRC).toMatch(/if \(inCard\) continue;/);
    expect(OBSERVE_SRC).not.toMatch(/suppressedName/);
  });
  it("门 1282 仍用 isClickableContentCard(评价卡 BUG-04 不回退)", () => {
    expect(OBSERVE_SRC).toMatch(/hasFinerPointer && !isClickableContentCard\(el\)\) continue;/);
  });
});

describe("observe v2:卡吸收内部 cursor:pointer 后代(源码锁)", () => {
  it("含 cardAbsorbers / absorbedByCard / survivingExtras 吸收逻辑", () => {
    expect(OBSERVE_SRC).toMatch(/cardAbsorbers/);
    expect(OBSERVE_SRC).toMatch(/absorbedByCard/);
    expect(OBSERVE_SRC).toMatch(/survivingExtras/);
  });
  it("择叶 candidateSet 与 cursorPointerLeaves 基于 survivingExtras(非原始 cursorPointerExtras)", () => {
    expect(OBSERVE_SRC).toMatch(/new Set<Element>\(survivingExtras\)/);
    expect(OBSERVE_SRC).toMatch(/survivingExtras\.filter\(\s*\(el\) => !dropSet\.has\(el\)/);
  });
  it("吸收仅 filter=interactive 启用", () => {
    expect(OBSERVE_SRC).toMatch(/let survivingExtras = cursorPointerExtras;/);
  });
});
