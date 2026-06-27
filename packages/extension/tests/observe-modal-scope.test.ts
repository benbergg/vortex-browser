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
  isModalLikeOverlay,
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
  it("inject func 内联 aria-modal 检测存在", () => {
    expect(src).toMatch(/getAttribute\(["']aria-modal["']\)\s*===\s*["']true["']/);
  });
  it("inject func 内联 selectActiveModal 同名逻辑存在", () => {
    expect(src).toContain("__activeModal");
  });
  it("inject func 模态块用 inject 形参 filter(非外层 filterMode)防 ReferenceError", () => {
    // inject func 第 5 形参名是 `filter`(func 签名 L731);只有外层 scanOneFrame 才叫 filterMode。
    // 模态块若误用 filterMode → inject MAIN-world 作用域无此变量 → minify 成自由变量 `a`
    // → ReferenceError: a is not defined → 模态打开时 observe 整帧崩(2026-06-26 实机 spike 实证)。
    expect(src).toMatch(/__activeModal && filter === "all"/);
    expect(src).toMatch(/__activeModal && filter !== "all"/);
    expect(src).not.toMatch(/__activeModal && filterMode/);
  });
});

describe("modal-scope: isModalLikeOverlay (N0002 B002 — 多信号 modal 判定)", () => {
  // 构造 mock Element:对象字面量带 getAttribute + getBoundingClientRect,viewport 固定 1440x800。
  // 之所以用对象字面量而非真实 DOM:getBoundingClientRect 在 jsdom 里恒返回 0,无法覆盖覆盖门逻辑。
  const VIEW = { w: 1440, h: 800 };
  type MockEl = {
    getAttribute: (n: string) => string | null;
    getBoundingClientRect: () => { width: number; height: number };
  };
  const mockEl = (attrs: Record<string, string | null>, w: number, h: number): MockEl => ({
    getAttribute: (n: string) => (n in attrs ? attrs[n] ?? null : null),
    getBoundingClientRect: () => ({ width: w, height: h } as DOMRect),
  });

  it("aria-modal=true(任意尺寸,小 220x300 也算) → true", () => {
    const e = mockEl({ "aria-modal": "true" }, 220, 300);
    expect(isModalLikeOverlay(e as unknown as Element, undefined, () => VIEW)).toBe(true);
  });

  it("role=dialog 无 aria-modal,小尺寸 600x400(伪模态) → true(语义门)", () => {
    const e = mockEl({ role: "dialog" }, 600, 400);
    expect(isModalLikeOverlay(e as unknown as Element, undefined, () => VIEW)).toBe(true);
  });

  it("role=alertdialog 无 aria-modal,小尺寸 → true", () => {
    const e = mockEl({ role: "alertdialog" }, 500, 350);
    expect(isModalLikeOverlay(e as unknown as Element, undefined, () => VIEW)).toBe(true);
  });

  it("无 role 无 aria-modal,但全屏 1440x788(0.82 宽,0.985 高) → true(覆盖门)", () => {
    const e = mockEl({}, 1440, 788);
    expect(isModalLikeOverlay(e as unknown as Element, undefined, () => VIEW)).toBe(true);
  });

  it("无 role 无 aria-modal,小尺寸 220x300(el-select popper) → false", () => {
    const e = mockEl({}, 220, 300);
    expect(isModalLikeOverlay(e as unknown as Element, undefined, () => VIEW)).toBe(false);
  });

  it("role 多个空格分词 + 第一 token 为 dialog → 仍判 true", () => {
    const e = mockEl({ role: "dialog  extra tokens" }, 100, 100);
    expect(isModalLikeOverlay(e as unknown as Element, undefined, () => VIEW)).toBe(true);
  });

  it("aria-modal=true 时 getBoundingClientRect 异常/未挂载不影响结果(短路在前)", () => {
    const e = mockEl({ "aria-modal": "true" }, 0, 0);
    // 即使宽高为 0,aria-modal=true 短路优先 → true
    expect(isModalLikeOverlay(e as unknown as Element, undefined, () => VIEW)).toBe(true);
  });
});