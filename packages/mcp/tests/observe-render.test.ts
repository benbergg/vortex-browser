import { describe, it, expect } from "vitest";
import { renderObserveCompact, refOf } from "../src/lib/observe-render.js";
import type { CompactElement } from "../src/lib/observe-render.js";

const sample = {
  snapshotId: "s_abc123",
  url: "https://erp.example.com/goods",
  title: "商品管理",
  viewport: { width: 1440, height: 900, scrollY: 320, scrollHeight: 4800 },
  frames: [
    { frameId: 0, parentFrameId: -1, url: "https://erp.example.com/goods", offset: { x: 0, y: 0 }, elementCount: 3, truncated: false, scanned: true },
    { frameId: 1, parentFrameId: 0, url: "https://erp.example.com/pay", offset: { x: 100, y: 200 }, elementCount: 1, truncated: false, scanned: true },
  ],
  elements: [
    { index: 0, tag: "button", role: "button", name: "新增商品", frameId: 0 },
    { index: 1, tag: "input", role: "textbox", name: "SKU 搜索", frameId: 0 },
    { index: 2, tag: "button", role: "button", name: "提交", state: { disabled: true }, frameId: 0 },
    { index: 3, tag: "input", role: "textbox", name: "卡号", state: {}, frameId: 1 },
  ],
};

describe("renderObserveCompact", () => {
  it("输出 SnapshotId + URL + Viewport 头", () => {
    const out = renderObserveCompact(sample, null);
    expect(out).toMatch(/^SnapshotId: s_abc123/m);
    expect(out).toMatch(/URL: https:\/\/erp\.example\.com\/goods/);
    expect(out).toMatch(/Viewport: 1440x900, scrollY=320\/4800/);
  });

  it("主 frame 元素渲染为 @eN [role] \"name\"", () => {
    const out = renderObserveCompact(sample, null);
    expect(out).toContain(`@e0 [button] "新增商品"`);
    expect(out).toContain(`@e1 [textbox] "SKU 搜索"`);
  });

  it("state flag 只打 true 值", () => {
    const out = renderObserveCompact(sample, null);
    expect(out).toContain(`@e2 [button] "提交" [disabled]`);
  });

  it("required 状态渲染 [required] 标记(Y,2026-06-02 dogfood)", () => {
    // observe-render 早支持 [required],本轮补上 producer(getUiState)接线。
    const withRequired = {
      ...sample,
      elements: [
        { index: 0, tag: "input", role: "textbox", name: "邮箱", state: { required: true }, frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(withRequired, null);
    expect(out).toContain(`@e0 [textbox] "邮箱" [required]`);
  });

  it("aria-expanded=true 渲染 [expanded] 标记(T2,2026-06-02 dogfood)", () => {
    // 折叠 / 展开态菜单按钮原本输出完全相同,agent 无法判断下拉是否已打开。
    const withExpanded = {
      ...sample,
      elements: [
        { index: 0, tag: "button", role: "button", name: "展开菜单", state: { expanded: true }, frameId: 0 },
        { index: 1, tag: "button", role: "button", name: "折叠菜单", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(withExpanded, null);
    expect(out).toContain(`@e0 [button] "展开菜单" [expanded]`);
    // collapsed(无 expanded 状态)不打标记,避免每个闭合下拉都加噪声。
    expect(out).toContain(`@e1 [button] "折叠菜单"`);
    expect(out).not.toMatch(/折叠菜单" \[expanded\]/);
  });

  it("子 frame 用 @fNeM 前缀", () => {
    const out = renderObserveCompact(sample, null);
    expect(out).toContain(`@f1e3 [textbox] "卡号"`);
  });

  it("100 元素中文场景输出 ≤ 3KB（真实 UI 典型体量）", () => {
    const manyElements = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: `按钮${i}`,
      frameId: 0,
    }));
    // 用完整头部模拟真实 observe 返回
    const big = { ...sample, elements: manyElements };
    const out = renderObserveCompact(big, null);
    const bytes = Buffer.byteLength(out, "utf-8");
    console.log(`100 中文元素 compact = ${bytes} bytes`);
    // 中文 name 每字符 3B UTF-8，3KB 允许 name 均值 ~6 字符；仍比 v0.4 的 ~100KB 降低 97%+
    expect(bytes).toBeLessThan(3072);
  });

  it("100 元素纯 ASCII 场景输出 ≤ 2KB（理想上限）", () => {
    const manyElements = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: `btn-${i}`,
      frameId: 0,
    }));
    const big = { ...sample, elements: manyElements };
    const out = renderObserveCompact(big, null);
    const bytes = Buffer.byteLength(out, "utf-8");
    console.log(`100 ASCII 元素 compact = ${bytes} bytes`);
    // 含完整头部（title/viewport/frames）约 200B，元素列表 ~2KB；整体 ≤ 2.5KB
    expect(bytes).toBeLessThan(2560);
  });

  it("scanned 但 0 元素的 sub-frame 公开为注释提示", () => {
    // bytenew testc 评价分析嵌套 iframe 场景：fid=22 已被扫描但页面无 interactive
    // 元素，prior renderer 沉默不报 → 多 frame 调试时误诊为 frame walker 漏。
    const data = {
      ...sample,
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://main.example/", offset: { x: 0, y: 0 }, elementCount: 1, truncated: false, scanned: true },
        { frameId: 22, parentFrameId: 19, url: "https://main.example/sub", offset: { x: 0, y: 0 }, elementCount: 0, truncated: false, scanned: true },
      ],
      elements: [{ index: 0, tag: "button", role: "button", name: "ok", frameId: 0 }],
    };
    const out = renderObserveCompact(data, null);
    expect(out).toContain("# frame 22 scanned, 0 interactive elements");
  });

  it("scanned 但 0 元素的主 frame 不重复输出（避免噪声）", () => {
    const data = {
      ...sample,
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://main.example/", offset: { x: 0, y: 0 }, elementCount: 0, truncated: false, scanned: true },
      ],
      elements: [],
    };
    const out = renderObserveCompact(data, null);
    expect(out).not.toContain("# frame 0");
  });

  it("未扫 sub-frame 仍用 not scanned 提示（向后兼容）", () => {
    const data = {
      ...sample,
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://main.example/", offset: { x: 0, y: 0 }, elementCount: 1, truncated: false, scanned: true },
        { frameId: 5, parentFrameId: 0, url: "https://other.example/", offset: { x: 0, y: 0 }, elementCount: 0, truncated: false, scanned: false },
      ],
      elements: [{ index: 0, tag: "button", role: "button", name: "ok", frameId: 0 }],
    };
    const out = renderObserveCompact(data, null);
    expect(out).toContain("# frame 5 not scanned");
    expect(out).not.toContain("# frame 5 scanned");
  });
});

describe("refOf — hash prefix (v0.8)", () => {
  const baseEl = (overrides: Partial<CompactElement> = {}): CompactElement => ({
    index: 5,
    tag: "button",
    role: "button",
    name: "Click me",
    frameId: 0,
    ...overrides,
  });

  it("emits @<hash>:eN when hash is provided and frame is 0", () => {
    expect(refOf(baseEl(), "a3f7")).toBe("@a3f7:e5");
  });

  it("emits @eN when hash is null (legacy fixture path)", () => {
    expect(refOf(baseEl(), null)).toBe("@e5");
  });

  it("preserves frame prefix in hashed form: @<hash>:fNeM", () => {
    expect(refOf(baseEl({ frameId: 3 }), "a3f7")).toBe("@a3f7:f3e5");
  });

  it("preserves frame prefix in bare form: @fNeM", () => {
    expect(refOf(baseEl({ frameId: 3 }), null)).toBe("@f3e5");
  });
});

describe("renderObserveCompact — propagates hash to every ref (v0.8)", () => {
  it("emits hashed refs across all elements when given a hash", () => {
    const input = {
      snapshotId: "s_test",
      url: "https://example.com/",
      elements: [
        { index: 0, tag: "button", role: "button", name: "A", frameId: 0 },
        { index: 1, tag: "a", role: "link", name: "B", frameId: 0 },
      ],
    };
    const out = renderObserveCompact(input, "a3f7");
    expect(out).toContain("@a3f7:e0");
    expect(out).toContain("@a3f7:e1");
    expect(out).not.toContain("@e0 ");
    expect(out).not.toContain("@e1 ");
  });

  it("emits bare refs when hash is null (legacy)", () => {
    const input = {
      snapshotId: "s_test",
      url: "https://example.com/",
      elements: [{ index: 0, tag: "button", role: "button", name: "A", frameId: 0 }],
    };
    const out = renderObserveCompact(input, null);
    expect(out).toContain("@e0");
    expect(out).not.toContain("@a3f7");
  });
});
