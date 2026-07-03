// Regression lock for the focused-editable OBSCURED carve-out
// (钉钉 spreadsheetv2 canvas 电子表格 dogfood 2026-07)。
//
// 现象:canvas 电子表格 F2 打开单元格编辑器,真正接收键入的是一个 1px 绝对定位、
// 视觉上被上层 canvas 完全遮挡的 textarea/IME 捕获框。它已是 document.activeElement,
// 但 actionability 在其中心 hit-test 命中上层 canvas → 误判 OBSCURED,vortex_act(type)
// 只能靠手传 options.force 才能写入(dogfood 实测)。
//
// 修复:receivesEvents 之前加短路——el === document.activeElement 且 isEditable →
// 视为已聚焦编辑目标,跳过 occlusion(CDP insertText/键入直达,视觉遮挡不影响送达)。
// 不回归:未聚焦的可编辑元素被遮挡仍报 OBSCURED。
//
// jsdom does not implement elementFromPoint — mock required (mirror of I6).

import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

function mockRect(el: Element, dom: JSDOM): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    top: 100, left: 100, width: 2, height: 2, right: 102, bottom: 102, x: 100, y: 100,
    toJSON: () => ({}),
  } as DOMRect);
  void dom;
}

describe("actionability focused-editable cover — canvas sheet cell-editor OBSCURED carve-out (2026-07 dingtalk dogfood)", () => {
  const html = `
    <div id="sheet">
      <canvas id="grid" width="800" height="600"></canvas>
      <textarea id="celledit" style="position:absolute;left:100px;top:100px;width:1px;height:1px;"></textarea>
    </div>
  `;

  it("does NOT report OBSCURED for edit action (needsEditable) when target IS the focused editable", async () => {
    vi.resetModules();
    let canvasRef: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({
      html,
      // hit-test 命中上层 canvas,而非 1px 编辑器 textarea。
      elementFromPoint: (_x: number, _y: number) => canvasRef,
    });
    canvasRef = dom.window.document.getElementById("grid");

    const editor = dom.window.document.getElementById("celledit") as HTMLTextAreaElement;
    mockRect(editor, dom);
    editor.focus(); // → document.activeElement === editor

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    // needsEditable:true 对应 type/fill(dom.ts:639/919):豁免 occlusion。
    const res = await checkActionability(1, undefined, "#celledit", { needsEditable: true });
    expect(res.reason).not.toBe("OBSCURED");
    expect(res.ok).toBe(true);
  });

  it("STILL reports OBSCURED for edit action when the covered editable is NOT focused (invariant)", async () => {
    vi.resetModules();
    let canvasRef: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({
      html,
      elementFromPoint: (_x: number, _y: number) => canvasRef,
    });
    canvasRef = dom.window.document.getElementById("grid");

    const editor = dom.window.document.getElementById("celledit") as HTMLTextAreaElement;
    mockRect(editor, dom);
    // 不聚焦:activeElement 保持 <body>,豁免不生效(只隔离焦点变量,needsEditable 仍 true)。
    (dom.window.document.body as HTMLElement).focus?.();

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    const res = await checkActionability(1, undefined, "#celledit", { needsEditable: true });
    expect(res.reason).toBe("OBSCURED");
    expect(res.ok).toBe(false);
  });

  it("STILL reports OBSCURED for non-edit action (click, needsEditable:false) even if focused (gate)", async () => {
    vi.resetModules();
    let canvasRef: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({
      html,
      elementFromPoint: (_x: number, _y: number) => canvasRef,
    });
    canvasRef = dom.window.document.getElementById("grid");

    const editor = dom.window.document.getElementById("celledit") as HTMLTextAreaElement;
    mockRect(editor, dom);
    editor.focus(); // 已聚焦,但 click 动作 needsEditable=false → 豁免不生效

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    // 默认 needsEditable=false(click/hover):occlusion 行为不变,仍 OBSCURED。
    const res = await checkActionability(1, undefined, "#celledit");
    expect(res.reason).toBe("OBSCURED");
    expect(res.ok).toBe(false);
  });
});
