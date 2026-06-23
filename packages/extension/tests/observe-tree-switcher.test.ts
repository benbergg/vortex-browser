// @vitest-environment jsdom
/**
 * Author: qingwa
 * Description: R25 dogfood — tree 展开/折叠 switcher 无独立 ref 修复。
 *   antd Tree 点 treeitem-title 仅选中、点 switcher caret 才展开;switcher 因祖先 treeitem ∈
 *   ATOMIC 被 cursor:pointer fallback 的跨池祖先短路吸收 → 纯 observe agent 无法展开。
 *   Hybrid 检测(ARIA 门 + curated 类 + 几何兜底)把 toggle surface 成独立 ref。
 *   本测试直测纯导出 isTreeExpandToggle,并 source-lock inject func 内联副本不漂移。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isTreeExpandToggle } from "../src/handlers/observe.js";

// 几何路 stub:jsdom 无布局,注入 cursor/rect。
const ptr = () => "pointer";
const small = () => ({ width: 24, height: 24 });

describe("isTreeExpandToggle — ARIA 门", () => {
  it("switcher 不在 treeitem 内 → false", () => {
    document.body.innerHTML = `<span class="ant-tree-switcher" id="s"></span>`;
    expect(isTreeExpandToggle(document.getElementById("s")!)).toBe(false);
  });
  it("treeitem 无 aria-expanded(叶子)→ false（即便 curated 类命中）", () => {
    document.body.innerHTML = `<div role="treeitem"><span class="ant-tree-switcher" id="s"></span></div>`;
    expect(isTreeExpandToggle(document.getElementById("s")!)).toBe(false);
  });
  it("treeitem 自身 → false", () => {
    document.body.innerHTML = `<div role="treeitem" aria-expanded="true" id="t"></div>`;
    expect(isTreeExpandToggle(document.getElementById("t")!)).toBe(false);
  });
});

describe("isTreeExpandToggle — curated 类", () => {
  const wrap = (inner: string) => `<div role="treeitem" aria-expanded="true">${inner}</div>`;
  it("antd .ant-tree-switcher(可展开)→ true", () => {
    document.body.innerHTML = wrap(`<span class="ant-tree-switcher ant-tree-switcher_open" id="s"></span>`);
    expect(isTreeExpandToggle(document.getElementById("s")!)).toBe(true);
  });
  it("antd .ant-tree-switcher-noop(叶子占位)→ false", () => {
    document.body.innerHTML = wrap(`<span class="ant-tree-switcher ant-tree-switcher-noop" id="s"></span>`);
    expect(isTreeExpandToggle(document.getElementById("s")!)).toBe(false);
  });
  it("rc-tree .rc-tree-switcher → true", () => {
    document.body.innerHTML = wrap(`<span class="rc-tree-switcher rc-tree-switcher_close" id="s"></span>`);
    expect(isTreeExpandToggle(document.getElementById("s")!)).toBe(true);
  });
  it("element-plus .el-tree-node__expand-icon → true", () => {
    document.body.innerHTML = wrap(`<i class="el-tree-node__expand-icon" id="s"></i>`);
    expect(isTreeExpandToggle(document.getElementById("s")!)).toBe(true);
  });
  it("element-plus expand-icon.is-leaf → false", () => {
    document.body.innerHTML = wrap(`<i class="el-tree-node__expand-icon is-leaf" id="s"></i>`);
    expect(isTreeExpandToggle(document.getElementById("s")!)).toBe(false);
  });
  it("switcher 内的 caret 子图标(祖先链命中)→ true", () => {
    document.body.innerHTML = wrap(`<span class="ant-tree-switcher ant-tree-switcher_open"><span class="anticon" id="caret"></span></span>`);
    expect(isTreeExpandToggle(document.getElementById("caret")!)).toBe(true);
  });
  it("checkbox 在可展开 treeitem 内 → false(各有独立 ref)", () => {
    document.body.innerHTML = wrap(`<span role="checkbox" class="ant-tree-checkbox" id="cb"></span>`);
    expect(isTreeExpandToggle(document.getElementById("cb")!)).toBe(false);
  });
});

describe("isTreeExpandToggle — 几何兜底(未知库,注入 cursor/rect)", () => {
  const wrap = (inner: string) => `<div role="treeitem" aria-expanded="true">${inner}</div>`;
  it("treeitem 内首个小图标 cursor:pointer → true", () => {
    document.body.innerHTML = wrap(`<span id="caret"></span><span id="label">node</span>`);
    expect(isTreeExpandToggle(document.getElementById("caret")!, ptr, small)).toBe(true);
  });
  it("第二个图标(非首个)→ false", () => {
    document.body.innerHTML = wrap(`<span id="first"></span><span id="second"></span>`);
    // first/second 均小图标 pointer → 只有 first 命中
    expect(isTreeExpandToggle(document.getElementById("second")!, ptr, small)).toBe(false);
    expect(isTreeExpandToggle(document.getElementById("first")!, ptr, small)).toBe(true);
  });
  it("大尺寸内容区(>32px)即便 cursor:pointer → false", () => {
    document.body.innerHTML = wrap(`<span id="content"></span>`);
    expect(isTreeExpandToggle(document.getElementById("content")!, ptr, () => ({ width: 200, height: 30 }))).toBe(false);
  });
  it("cursor 非 pointer → false", () => {
    document.body.innerHTML = wrap(`<span id="x"></span>`);
    expect(isTreeExpandToggle(document.getElementById("x")!, () => "auto", small)).toBe(false);
  });
  it("零尺寸(未渲染)→ false", () => {
    document.body.innerHTML = wrap(`<span id="x"></span>`);
    expect(isTreeExpandToggle(document.getElementById("x")!, ptr, () => ({ width: 0, height: 0 }))).toBe(false);
  });
});

describe("inject func 内联 isTreeExpandToggle drift 锁(改一处须同步)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
    "utf8",
  );
  it("内联保留 curated switcher 类正则(antd/rc-tree/element-plus)", () => {
    expect(SRC).toMatch(/ant-tree-switcher\|rc-tree-switcher\|el-tree-node__expand-icon/);
  });
  it("内联保留 ARIA 门(treeitem + aria-expanded)", () => {
    expect(SRC).toMatch(/role="treeitem"/);
    expect(SRC).toMatch(/aria-expanded/);
  });
  it("内联保留 noop/is-leaf 排除", () => {
    expect(SRC).toMatch(/switcher-noop\|is-leaf/);
  });
});
