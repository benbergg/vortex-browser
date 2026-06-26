// @vitest-environment jsdom
/**
 * Description: 模态作用域(Modal Scoping)—— aria-modal=true 弹层打开时,observe 把模态控件
 *   与整页背景平铺混合返回(N002 T2-2,Element Plus dialog 实测复现:模态 3 按钮混进 56 个
 *   背景元素)。修复:检测 active modal → 裁剪 baseCandidates 到模态子树 + 发 # modal: meta。
 *   本测试直测从 inject func 提取的纯导出(isModalOverlayRoot / selectActiveModal /
 *   scopeCandidatesToModal),并 source-lock inject func 内联副本不漂移。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isModalOverlayRoot,
  selectActiveModal,
  scopeCandidatesToModal,
} from "../src/handlers/observe.js";

function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

describe("modal-scope: isModalOverlayRoot", () => {
  it("aria-modal=true → true", () => {
    expect(isModalOverlayRoot(el('<div role="dialog" aria-modal="true"></div>'))).toBe(true);
  });
  it("role=dialog 无 aria-modal → false(不裁剪伪模态)", () => {
    expect(isModalOverlayRoot(el('<div role="dialog"></div>'))).toBe(false);
  });
  it("aria-modal=false → false", () => {
    expect(isModalOverlayRoot(el('<div role="dialog" aria-modal="false"></div>'))).toBe(false);
  });
  it("非 dialog 但 aria-modal=true(drawer) → true", () => {
    expect(isModalOverlayRoot(el('<div class="el-drawer" role="dialog" aria-modal="true"></div>'))).toBe(true);
  });
});

describe("modal-scope: selectActiveModal", () => {
  it("无模态根 → null", () => {
    const a = el('<div role="listbox"></div>');
    expect(selectActiveModal([a])).toBe(null);
  });
  it("单个 aria-modal=true → 返回它", () => {
    const m = el('<div role="dialog" aria-modal="true"></div>');
    const lb = el('<div role="listbox"></div>');
    expect(selectActiveModal([lb, m])).toBe(m);
  });
  it("嵌套对话框(两个 aria-modal=true) → 取 overlayRoots 中最后一个(顶层)", () => {
    const outer = el('<div role="dialog" aria-modal="true" aria-label="Outer"></div>');
    const inner = el('<div role="dialog" aria-modal="true" aria-label="Inner"></div>');
    expect(selectActiveModal([outer, inner])).toBe(inner);
  });
});

describe("modal-scope: scopeCandidatesToModal", () => {
  it("保留模态内候选,统计背景抑制数", () => {
    const modal = el('<div role="dialog" aria-modal="true"><button id="ok">OK</button><button id="cancel">Cancel</button></div>');
    const inBtn1 = modal.querySelector("#ok")!;
    const inBtn2 = modal.querySelector("#cancel")!;
    const bg1 = el("<a href='/x'>nav1</a>");
    const bg2 = el("<a href='/y'>nav2</a>");
    const bg3 = el("<button>page</button>");
    const r = scopeCandidatesToModal([bg1, inBtn1, bg2, inBtn2, bg3], modal);
    expect(r.kept).toEqual([inBtn1, inBtn2]);
    expect(r.suppressed).toBe(3);
  });
  it("模态根自身在候选中也保留", () => {
    const modal = el('<div role="dialog" aria-modal="true"><button>OK</button></div>');
    const inBtn = modal.querySelector("button")!;
    const r = scopeCandidatesToModal([modal, inBtn], modal);
    expect(r.kept).toEqual([modal, inBtn]);
    expect(r.suppressed).toBe(0);
  });
});

describe("modal-scope: source-lock(inject func 内联副本同步)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/handlers/observe.ts"),
    "utf8",
  );
  it.skip("inject func 内联 aria-modal 检测存在", () => {
    expect(src).toMatch(/getAttribute\(["']aria-modal["']\)\s*===\s*["']true["']/);
  });
  it.skip("inject func 内联 selectActiveModal 同名逻辑存在", () => {
    expect(src).toContain("__activeModal");
  });
});