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

describe("renderObserveTree compound 元数据增强 (T5)", () => {
  it("date-input compound 渲染 formatHint", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "textbox", name: "出生日期", frameId: 0,
        compound: { role: "date-input", formatHint: "YYYY-MM-DD" } },
    ]};
    const out = renderObserveTree(data as any, "h1", false);
    expect(out).toContain("compound=(date-input format=YYYY-MM-DD)");
  });

  it("time-input compound 渲染 formatHint", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "textbox", name: "时间", frameId: 0,
        compound: { role: "date-input", formatHint: "HH:mm" } },
    ]};
    const out = renderObserveTree(data as any, "h1", false);
    expect(out).toContain("compound=(date-input format=HH:mm)");
  });

  it("file-input compound 渲染有文件时显示文件名", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "textbox", name: "文件上传", frameId: 0,
        compound: { role: "file-input", formatHint: "resume.pdf" } },
    ]};
    const out = renderObserveTree(data as any, "h1", false);
    expect(out).toContain("compound=(file-input file=resume.pdf)");
  });

  it("file-input compound 渲染无文件时显示 None", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "textbox", name: "文件上传", frameId: 0,
        compound: { role: "file-input", formatHint: "None" } },
    ]};
    const out = renderObserveTree(data as any, "h1", false);
    expect(out).toContain("compound=(file-input file=None)");
  });

  it("range-input compound 渲染 min/max/step", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "slider", name: "音量", frameId: 0,
        compound: { role: "range-input", min: "0", max: "100", step: "5" } },
    ]};
    const out = renderObserveTree(data as any, "h1", false);
    expect(out).toContain("compound=(range-input min=0 max=100 step=5)");
  });

  it("number-input compound 仅有 min/max 时不渲染 step", () => {
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "spinbutton", name: "数量", frameId: 0,
        compound: { role: "number-input", min: "1", max: "99" } },
    ]};
    const out = renderObserveTree(data as any, "h1", false);
    expect(out).toContain("compound=(number-input min=1 max=99)");
    expect(out).not.toContain("step=");
  });

  it("range-input 无约束属性时 compound 不渲染", () => {
    // 无 min/max/step/formatHint 的 compound 应简洁,只显示 role
    const data = { ...base, elements: [
      { index: 0, tag: "input", role: "slider", name: "进度", frameId: 0,
        compound: { role: "range-input" } },
    ]};
    const out = renderObserveTree(data as any, "h1", false);
    // 仅 role,无其他元数据时极简
    expect(out).toContain("compound=(range-input)");
  });
});
