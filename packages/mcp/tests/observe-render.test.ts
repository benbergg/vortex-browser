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

  it("aria-invalid 渲染 [invalid] 标记(Z,2026-06-02 dogfood)", () => {
    const withInvalid = {
      ...sample,
      elements: [
        { index: 0, tag: "input", role: "textbox", name: "邮箱", state: { invalid: true }, frameId: 0 },
        { index: 1, tag: "input", role: "textbox", name: "用户名", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(withInvalid, null);
    expect(out).toContain(`@e0 [textbox] "邮箱" [invalid]`);
    expect(out).not.toMatch(/用户名" \[invalid\]/);
  });

  it("aria-sort 渲染 [sort:asc]/[sort:desc]/[sortable] 标记(AC,2026-06-02 dogfood)", () => {
    const withSort = {
      ...sample,
      elements: [
        { index: 0, tag: "th", role: "columnheader", name: "姓名", state: { sort: "ascending" }, frameId: 0 },
        { index: 1, tag: "th", role: "columnheader", name: "年龄", state: { sort: "descending" }, frameId: 0 },
        { index: 2, tag: "th", role: "columnheader", name: "城市", state: { sort: "none" }, frameId: 0 },
        { index: 3, tag: "th", role: "columnheader", name: "无排序", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(withSort, null);
    expect(out).toContain(`@e0 [columnheader] "姓名" [sort:asc]`);
    expect(out).toContain(`@e1 [columnheader] "年龄" [sort:desc]`);
    expect(out).toContain(`@e2 [columnheader] "城市" [sortable]`);
    // 无 aria-sort 的普通表头不带任何排序标记
    expect(out).toMatch(/@e3 \[columnheader\] "无排序"\s*$/m);
  });

  it("aria-current 渲染 [current] 标记(W,2026-06-02 dogfood)", () => {
    const withCurrent = {
      ...sample,
      elements: [
        { index: 0, tag: "a", role: "link", name: "当前页", state: { current: true }, frameId: 0 },
        { index: 1, tag: "a", role: "link", name: "其他页", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(withCurrent, null);
    expect(out).toContain(`@e0 [link] "当前页" [current]`);
    expect(out).not.toMatch(/其他页" \[current\]/);
  });

  it("值域控件渲染 value= 段(X,2026-06-02 dogfood)", () => {
    const withValue = {
      ...sample,
      elements: [
        { index: 0, tag: "div", role: "slider", name: "音量", valueNow: "30/100", frameId: 0 },
        { index: 1, tag: "progress", role: "progressbar", name: "进度", valueNow: "70/100", frameId: 0 },
        { index: 2, tag: "button", role: "button", name: "普通", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(withValue, null);
    expect(out).toContain(`@e0 [slider] "音量" value=30/100`);
    expect(out).toContain(`@e1 [progressbar] "进度" value=70/100`);
    // 非值域控件不带 value 段。
    expect(out).toContain(`@e2 [button] "普通"`);
    expect(out).not.toMatch(/普通" value=/);
  });

  it("含空格的 valueNow(aria-valuetext)加引号,避免破坏分段(评审修复)", () => {
    const spaced = {
      ...sample,
      elements: [
        { index: 0, tag: "div", role: "slider", name: "评分", valueNow: "3 of 5 stars", frameId: 0 },
        { index: 1, tag: "div", role: "slider", name: "音量", valueNow: "30/100", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(spaced, null);
    expect(out).toContain(`@e0 [slider] "评分" value="3 of 5 stars"`);
    // 无空格的数值不加引号(保持简洁)。
    expect(out).toContain(`@e1 [slider] "音量" value=30/100`);
  });

  it("value= 段在 state flag 之后(X 与 W/Y 组合顺序)", () => {
    const combo = {
      ...sample,
      elements: [
        { index: 0, tag: "input", role: "spinbutton", name: "数量", state: { required: true }, valueNow: "4", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(combo, null);
    expect(out).toContain(`@e0 [spinbutton] "数量" [required] value=4`);
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

  it("aria-haspopup 渲染 [haspopup:menu]/[haspopup:listbox]/[haspopup:dialog] 标记(AA,2026-06-02 dogfood)", () => {
    // 菜单按钮/拆分按钮/combobox 点击会弹层,agent 据此预判多步交互。冒号语法
    // [haspopup:menu](bench parser 自 AC 起容忍冒号),保留弹层类型信息。
    const withPopup = {
      ...sample,
      elements: [
        { index: 0, tag: "div", role: "menuitem", name: "文件", state: { haspopup: "menu" }, frameId: 0 },
        { index: 1, tag: "button", role: "button", name: "字体", state: { haspopup: "listbox", expanded: true }, frameId: 0 },
        { index: 2, tag: "button", role: "button", name: "插入…", state: { haspopup: "dialog" }, frameId: 0 },
        { index: 3, tag: "button", role: "button", name: "普通按钮", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(withPopup, null);
    expect(out).toContain(`@e0 [menuitem] "文件" [haspopup:menu]`);
    // 与 expanded 组合:既报弹层类型也报当前已展开。
    expect(out).toContain(`@e1 [button] "字体" [expanded] [haspopup:listbox]`);
    expect(out).toContain(`@e2 [button] "插入…" [haspopup:dialog]`);
    // 无 haspopup 的普通按钮不带标记。
    expect(out).toMatch(/@e3 \[button\] "普通按钮"\s*$/m);
  });

  it("aria-activedescendant 高亮项渲染 [active] 标记(AE,2026-06-02 dogfood)", () => {
    // 虚拟焦点项复用既有 [active] flag(无新增语法),agent 看出方向键当前落在哪项。
    const withActiveDesc = {
      ...sample,
      elements: [
        { index: 0, tag: "li", role: "option", name: "Apple", frameId: 0 },
        { index: 1, tag: "li", role: "option", name: "Banana", state: { active: true }, frameId: 0 },
        { index: 2, tag: "li", role: "option", name: "Cherry", frameId: 0 },
      ] as CompactElement[],
    };
    const out = renderObserveCompact(withActiveDesc, null);
    expect(out).toContain(`@e1 [option] "Banana" [active]`);
    expect(out).not.toMatch(/Apple" \[active\]/);
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

// =========================================================
// 按 category 渲染派发(T5)
// - composite: count + options + truncated
// - structure: count + label,无 options
// - landmark: 元素行 [landmark:role] 锚点
// - live: 元素行 [live] 锚点
// - widget: 不变(input 子类型走现有 format/file/min/max/step 路径)
// =========================================================
describe("按 category 渲染派发(T5)", () => {
  function mkData(el: Record<string, unknown>) {
    return {
      snapshotId: "t",
      url: "https://x",
      viewport: { width: 100, height: 100, scrollY: 0, scrollHeight: 0 },
      elements: [el],
    };
  }

  it("composite(listbox)出 count+options 样本 + truncated", () => {
    const out = renderObserveCompact(mkData({
      index: 0, tag: "div", role: "listbox", name: "Colors", frameId: 0,
      compound: { role: "listbox", count: 8, options: ["Red", "Green"], truncated: 6 },
    }) as any, null);
    expect(out).toContain("count=8");
    expect(out).toContain("options=Red|Green");
    expect(out).toContain("+6 more");
  });

  it("structure(toolbar)只出标签+count,不出 options=", () => {
    const out = renderObserveCompact(mkData({
      index: 0, tag: "div", role: "toolbar", name: "Text formatting", frameId: 0,
      compound: { role: "toolbar", count: 6 },
    }) as any, null);
    expect(out).toContain("Text formatting");
    expect(out).toContain("toolbar");
    expect(out).toContain("compound=(toolbar");
    expect(out).toContain("6 controls");
    expect(out).not.toContain("options=");
  });

  it("landmark(region)渲染带 [landmark:role] 前缀", () => {
    const out = renderObserveCompact(mkData({
      index: 0, tag: "section", role: "region", name: "Details", frameId: 0,
    }) as any, null);
    expect(out).toContain("region");
    expect(out).toContain("[landmark:region]");
    expect(out).toContain("Details");
    expect(out).not.toContain("options=");
  });

  it("live(status)渲染带 [live] 前缀", () => {
    const out = renderObserveCompact(mkData({
      index: 0, tag: "div", role: "status", name: "Saved successfully", frameId: 0,
    }) as any, null);
    expect(out).toContain("status");
    expect(out).toContain("[live]");
    expect(out).toContain("Saved successfully");
  });

  it("widget(button)不变", () => {
    const out = renderObserveCompact(mkData({
      index: 0, tag: "button", role: "button", name: "Save", frameId: 0,
    }) as any, null);
    expect(out).toContain("[button]");
    expect(out).toContain("Save");
  });
});
