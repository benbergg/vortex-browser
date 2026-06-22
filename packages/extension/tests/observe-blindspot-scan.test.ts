// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectBlindspot } from "../src/page-side/blindspot-detect.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("scan func 内联 detectBlindspot 与纯函数一致", () => {
  it("observe.ts 内联副本存在(防漏内联)", () => {
    const src = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");
    expect(src).toContain("[inline detectBlindspot]");
    // 透传链:scan push + 两处 compact/full 映射
    expect(src).toContain("blindspot: __vtxBlind");
    expect(src).toContain("blindspot: e.blindspot");
    // candidateCount 透传到 frame summary
    expect(src).toContain("candidateCount: s.page.candidateCount");
    // A2-fb 非 ARIA 虚拟化回退内联
    expect(src).toContain("[inline detectVirtualByScroll]");
    // 误报闸:祖先 DOM 行数 >> 本列表渲染数 → 跳过(MDN 侧栏实证),须与 canonical 同步
    expect(src).toContain("__scrollerRows");
    expect(src).toContain("__scrollerRows > __rendered * 2");
  });
  it("纯函数对 grid aria-rowcount=1000/rendered=10 → virtual(行为基线)", () => {
    document.body.innerHTML = `<div role="grid" aria-rowcount="1000">${"<div role='row'></div>".repeat(10)}</div>`;
    expect(detectBlindspot(document.querySelector("[role=grid]") as HTMLElement, 10))
      .toEqual({ kind: "virtual", total: 1000, rendered: 10 });
  });
});
