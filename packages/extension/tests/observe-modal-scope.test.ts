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
  it("R3 B010 修复: activeModal 显式注入 baseCandidates,dialog 容器自身召回", () => {
    // R3 评测发现:role=dialog aria-modal=true 的 modal 容器在 observe 输出
    // 中完全丢失(只显示内部 button/link)。INTERACTIVE_SELECTORS 不含
    // [role=dialog],dialog 容器不进 baseCandidates;modal-scope 裁剪/dialog
    // 注入只对"已在 baseCandidates 的元素"生效 → activeModal 永不显示。
    // 修复:在 modal-scope 步骤,filter==="all" 时把 __activeModal 显式
    // unshift 进 baseCandidates 头部,精准(只真 modal 进,普通 dialog 不污染)。
    // 字符串契约:__activeModal && !baseCandidates.includes(__activeModal)
    // 模式,新代码应包含此注入语句。
    expect(src).toMatch(
      /__activeModal.*baseCandidates\.unshift|baseCandidates\.unshift\(__activeModal\)|baseCandidates = \[__activeModal.*baseCandidates\]/s,
    );
  });

  it("R4 B011: INTERACTIVE_SELECTORS 含 [role=tabpanel] 让 tab 内容容器召回", () => {
    // R4 评测发现:react-aria Tabs 页面 4 个 tabpanel 元素 (role=tabpanel)
    // 在 observe 输出中完全丢失(2026-06-28 a11y 评测 R4 B011)。Agent 看到
    // tab "General" [selected] + controls=#tabpanel-general,但不知 tab
    // 内容长啥样。修复:[role=tabpanel] 加 INTERACTIVE_SELECTORS 总是收集
    // (不限 filter=all),tab 内容容器 (含内部 textbox/button) 也被一起召回。
    // tabpanel 自身不被标可点(无 cursor:pointer,无 [listener],getRole 返
    // "tabpanel")，仅显示结构 — 与 dialog 容器不同,无需 modal-scope 特殊处理。
    expect(src).toMatch(/\[role=tabpanel\]/);
  });

  it("R5 B013: TABLE_EXTRA_SELECTORS 含 table 元素让 table 容器自身召回", () => {
    // R5 评测发现:真站或注入的 <table aria-label="..."> 容器在 observe
    // 输出中完全丢失(只显示 row/cell/columnheader,2026-06-28 a11y 评测
    // R5 B013)。Agent 看到 row "Product Sales" 但不知是哪个 table 上下文。
    // 修复:原生 table 元素加 TABLE_EXTRA_SELECTORS(filter=all 时收集),
    // 与 tr/td/th/[role=row]/[role=cell]/[role=columnheader] 等表结构
    // 角色一起召回。getRole 返 "table"(HTML-AAM),无 cursor:pointer 时
    // 不被 react-clickable 误标。
    expect(src).toMatch(/TABLE_EXTRA_SELECTORS[\s\S]*?["']table,/);
  });

  it("R7 B016: INTERACTIVE_SELECTORS 含 [role=progressbar] / [role=meter]", () => {
    // R7 评测发现:真站或注入的 <div role="progressbar" aria-valuenow="65">
    // 进度条元素在 observe 输出中完全丢失(2026-06-28 a11y 评测 R7 B016)。
    // Agent 看不到 "65% / 100%" 这种关键状态。WAI-ARIA 标准进度/量度元素
    // (progressbar / meter),任何 upload progress / 评分 / loading bar 都用。
    // 修复:加 [role=progressbar] 和 [role=meter] 进 INTERACTIVE_SELECTORS。
    // 不交互(无 cursor:pointer 时),getRole 返 "progressbar"/"meter"
    // 自然不与 button 混淆。valuenow/min/max 走已有 valueNow/valuemin/max
    // 字段(observe-render.ts 已渲染 [valuemin=0] [valuemax=100] value=X)。
    expect(src).toMatch(/\[role=progressbar\]/);
    expect(src).toMatch(/\[role=meter\]/);
  });

  it("R8 B018: INTERACTIVE_SELECTORS 含 [role=listbox] 让 listbox 容器自身召回", () => {
    // R8 评测发现:真站或注入的 <ul role="listbox" aria-multiselectable="true">
    // 容器在 observe 输出中完全丢失(只显示 4 个 option,2026-06-28 a11y
    // 评测 R8 B018)。Agent 看到 option "Red" [selected] 但不知是哪个
    // listbox 上下文(Colors? Sizes? Filters?)。修复:[role=listbox] 加
    // INTERACTIVE_SELECTORS,与 [role=option] 一起召回;走 extractCompound
    // 输出 count + options(R2 B006 已加 truncated)。与 R4 B011 tabpanel
    // / R5 B013 table / R7 B016 progressbar 同模式:listbox 不交互
    // (无 cursor:pointer 时),getRole 返 "listbox" 自然不与 button 混淆。
    expect(src).toMatch(/\[role=listbox\]/);
  });

  it("R9 B019: INTERACTIVE_SELECTORS 含 [role=menu] 让 menu 容器自身召回", () => {
    // R9 评测发现:R8 B018 修复 listbox 容器时漏了 [role=menu] 容器 —
    // 同一类下拉容器(WAI-ARIA menu pattern,button [haspopup=menu]
    // controls=menu 关联)。Agent 看到 button "Open menu" controls=#r9-menu
    // 但不知 menu 内部结构(Cut/Copy/Paste 等 menuitem),menu 元素
    // 整体在 observe 输出中完全丢失(2026-06-28 a11y 评测 R9 B019)。
    // 修复:[role=menu] 加 INTERACTIVE_SELECTORS,与 [role=menuitem]
    // 一起召回,走 extractCompound 输出 count + options。
    expect(src).toMatch(/\[role=menu\]/);
  });

  it("R10 B020: INTERACTIVE_SELECTORS 含 [role=region] 让 region 容器自身召回", () => {
    // R10 评测发现:R9 修复后 listbox/menu/dialog/tabpanel/table/progressbar
    // 都召回,但 [role=region] (WAI-ARIA landmark 容器,用于
    // disclosure/fieldset/分组)仍丢失(2026-06-28 a11y 评测 R10 B020)。
    // Agent 看到 button "Show details" [expanded] controls=#r10-panel
    // 但 region 容器整体不见,不知 panel 内容范围。修复:[role=region]
    // 加 INTERACTIVE_SELECTORS,与 listbox/menu/dialog/tabpanel/table
    // /progressbar 同模式。region 不交互(无 cursor:pointer 时),
    // getRole 返 "region" 自然不与 button 混淆。
    expect(src).toMatch(/\[role=region\]/);
  });

  it("R11 B021: INTERACTIVE_SELECTORS 含 [role=radiogroup] 让 radiogroup 容器自身召回", () => {
    // R11 评测发现:R10 修复 region 后,ARIA 1.2 radio pattern 的容器
    // radiogroup 仍丢失(2026-06-28 a11y 评测 R11 B021)。Agent 看到
    // radio "Apple" [checked] 不知属哪个 group(react-aria Tree 站 6 个
    // radiogroup 全部 0 召回:style / selectionMode / selectionBehavior
    // 各 aria-label 关键状态被丢;W3C APG 官方 radio 范例 2 个 radiogroup
    // 也丢)。radiogroup 携带 aria-label / aria-required / aria-disabled,
    // 屏幕阅读器把整组作为 landmark 播报 — 容器不在 → agent 拿不到 group
    // context,跨组同名 radio(Apple/Pear/Orange 多个 demo)极易选错。
    // 修复:[role=radiogroup] 加 INTERACTIVE_SELECTORS,与 listbox/menu/
    // region 同模式。radiogroup 不交互(无 cursor:pointer 时),getRole
    // 返 "radiogroup" 自然不与 radio/button 混淆。
    expect(src).toMatch(/\[role=radiogroup\]/);
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