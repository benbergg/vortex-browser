import { describe, it, expect } from "vitest";
import { renderObserveTree } from "../src/lib/observe-render.js";

const base = { snapshotId: "s1", url: "http://x", elements: [] as any[] };

describe("renderObserveTree AX 语义段", () => {
  it("compound / weakname / error / controls 渲染", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "select", role: "combobox", name: "国家", frameId: 0,
        compound: { role: "listbox", count: 240, options: ["中国","美国"] } },
      { index: 1, tag: "input", role: "textbox", name: "请输入", frameId: 0, nameSource: "placeholder" },
      { index: 2, tag: "input", role: "textbox", name: "邮箱", frameId: 0, errorMessage: "格式不正确" },
      { index: 3, tag: "div", role: "tab", name: "详情", frameId: 0, controls: [0] },
    ]};
    const out = renderObserveTree(data as any, "h1", false);
    expect(out).toContain("compound=(listbox count=240 options=中国|美国)");
    expect(out).toContain("[weakname]");
    expect(out).toContain('error="格式不正确"');
    expect(out).toMatch(/controls=@h1:e0|controls=@h1:f0e0|controls=@/); // ref 形态含 @
  });

  it("checked=mixed 渲染 [checked:mixed]", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "checkbox", name: "全选", frameId: 0, state: { checked: "mixed" } },
    ]};
    expect(renderObserveTree(data as any, "h1", false)).toContain("[checked:mixed]");
  });

  it("readonly 渲染 [readonly]", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "textbox", name: "ID", frameId: 0, state: { readonly: true } },
    ]};
    expect(renderObserveTree(data as any, "h1", false)).toContain("[readonly]");
  });
});
