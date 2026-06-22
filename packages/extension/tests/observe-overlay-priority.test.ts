// @vitest-environment jsdom
/**
 * Author: qingwa
 * Description: DEFECT-1 overlay-priority —— 密集页(交互元素 > maxElements)上 portal
 *   弹层(挂 body 末尾、DOM 序最后)被 80 截断的盲区修复。
 *
 *   实测(ant.design Select dogfood 2026-06-19):782 候选,observe 默认返回的 80 个全是
 *   顶部导航,刚点开、就在视口内的下拉选项(Jack/Lucy/yiminghe / 版本 6.4.4…)一个都没返回
 *   → agent「点开了却找不到选项」。根因:`allCandidates` 按纯 DOM 序取前 N,portal 弹层
 *   排最后必被截掉。
 *
 *   修复:扫描时检测「可见且脱流的浮层根」,把其交互后代前置到候选最前;**无浮层时候选
 *   顺序零改动(baseline 零漂移)**。脱流门(fixed/absolute)把静态在流内的 grid/tree/
 *   listbox(ag-grid / 侧栏树 / 常驻列表)排除——实测 antd 侧栏 role=menu(static)不前置。
 *
 *   本测试直测从 inject func 提取的纯导出(OVERLAY_POPUP_ROLES / isOverlayFloating /
 *   partitionOverlayFirst),并 source-lock inject func 内联副本不漂移。端到端真浏览器
 *   验证见 vortex-bench synth fixture `overlay-truncation-priority`(recall 3/3)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OVERLAY_POPUP_ROLES,
  isOverlayFloating,
  isPersistentNavMenu,
  partitionOverlayFirst,
} from "../src/handlers/observe.js";

describe("overlay-priority (DEFECT-1)", () => {
  describe("OVERLAY_POPUP_ROLES", () => {
    it("含弹层语义 role(dialog/listbox/menu/tooltip 等)", () => {
      ["dialog", "alertdialog", "listbox", "menu", "tree", "grid", "tooltip"].forEach((r) =>
        expect(OVERLAY_POPUP_ROLES.has(r)).toBe(true),
      );
    });
    it("不含普通控件/地标 role(button/navigation/region)", () => {
      ["button", "navigation", "region", "tabpanel", "banner"].forEach((r) =>
        expect(OVERLAY_POPUP_ROLES.has(r)).toBe(false),
      );
    });
  });

  describe("isOverlayFloating(脱流门:只认 fixed/absolute → 静态数据视图不前置)", () => {
    it("position:absolute → 浮层", () => {
      document.body.innerHTML = `<div id="d" role="listbox" style="position:absolute"></div>`;
      expect(isOverlayFloating(document.getElementById("d")!)).toBe(true);
    });
    it("position:fixed → 浮层", () => {
      document.body.innerHTML = `<div id="d" role="dialog" style="position:fixed"></div>`;
      expect(isOverlayFloating(document.getElementById("d")!)).toBe(true);
    });
    it("祖先 absolute(≤6 跳,选项在 .dropdown 内)→ 浮层", () => {
      document.body.innerHTML = `<div style="position:absolute"><ul><li id="opt" role="option"></li></ul></div>`;
      expect(isOverlayFloating(document.getElementById("opt")!)).toBe(true);
    });
    it("静态在流内的 role=grid(ag-grid 类持久数据表)→ 非浮层,保护 baseline", () => {
      document.body.innerHTML = `<div id="g" role="grid"></div>`;
      expect(isOverlayFloating(document.getElementById("g")!)).toBe(false);
    });
    it("position:sticky(粘性侧栏/导航)不算浮层", () => {
      document.body.innerHTML = `<div id="s" role="menu" style="position:sticky"></div>`;
      expect(isOverlayFloating(document.getElementById("s")!)).toBe(false);
    });
  });

  describe("partitionOverlayFirst(浮层后代前置 + 零漂移)", () => {
    it("无浮层根 → 返回原数组(同引用,baseline 零漂移)", () => {
      const cands = [document.createElement("a"), document.createElement("button")];
      expect(partitionOverlayFirst(cands, [])).toBe(cands);
    });
    it("浮层后代前置,其余元素保持原序", () => {
      document.body.innerHTML =
        `<a id="n0"></a><a id="n1"></a>` +
        `<div id="ov" role="listbox" style="position:absolute">` +
        `<div id="o0" role="option"></div><div id="o1" role="option"></div></div>`;
      const get = (id: string) => document.getElementById(id)!;
      // 候选按 DOM 序:导航在前、弹层选项在末尾(模拟被 maxElements 截断的处境)
      const cands = [get("n0"), get("n1"), get("o0"), get("o1")];
      const out = partitionOverlayFirst(cands, [get("ov")]);
      expect(out.map((e) => e.id)).toEqual(["o0", "o1", "n0", "n1"]);
    });
    it("浮层根自身也前置;浮层内后代保持相对 DOM 序", () => {
      document.body.innerHTML =
        `<a id="x"></a>` +
        `<div id="ov" role="menu" style="position:fixed">` +
        `<div id="m0" role="menuitem"></div><div id="m1" role="menuitem"></div></div>`;
      const get = (id: string) => document.getElementById(id)!;
      const out = partitionOverlayFirst([get("x"), get("ov"), get("m0"), get("m1")], [get("ov")]);
      expect(out.map((e) => e.id)).toEqual(["ov", "m0", "m1", "x"]);
    });
    it("无任何候选落在浮层内 → 原数组不变(front 为空)", () => {
      document.body.innerHTML = `<a id="a"></a><div id="ov" role="dialog" style="position:fixed"></div>`;
      const get = (id: string) => document.getElementById(id)!;
      const cands = [get("a")];
      expect(partitionOverlayFirst(cands, [get("ov")])).toBe(cands);
    });
  });

  describe("inject func 内联副本 drift 锁(改一处须同步)", () => {
    const SRC = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
      "utf8",
    );
    it("内联 OVERLAY_POPUP_ROLES 含同样弹层 role 集", () => {
      const inline = SRC.match(/const OVERLAY_POPUP_ROLES = new Set\(\[([\s\S]*?)\]\)/);
      expect(inline).toBeTruthy();
      ["dialog", "alertdialog", "listbox", "menu", "tree", "grid", "tooltip"].forEach((r) =>
        expect(inline![1]).toContain(`"${r}"`),
      );
    });
    it("内联保留脱流门(position fixed/absolute)", () => {
      expect(SRC).toMatch(/pos === "fixed" \|\| pos === "absolute"/);
    });
    it("内联保留 portal 信号(body 直接子 + z-index)", () => {
      expect(SRC).toMatch(/docBody\.children/);
      expect(SRC).toMatch(/zIndex/);
    });
    it("内联保留无浮层零漂移(overlayRoots.length === 0 → baseCandidates)", () => {
      expect(SRC).toMatch(/overlayRoots\.length === 0/);
    });
  });
});

describe("isPersistentNavMenu(持久导航菜单 ≠ 临时浮层,A-1 overlay 误判修复)", () => {
  it("role=menu 无触发器(侧栏导航;semi.design ul[role=menu].semi-navigation-list 实证)→ true", () => {
    document.body.innerHTML = `<ul id="m" role="menu"><li role="menuitem">a</li></ul>`;
    expect(isPersistentNavMenu(document.getElementById("m")!, "menu")).toBe(true);
  });
  it("role=menu 被 aria-controls 触发器关联(真弹出菜单)→ false", () => {
    document.body.innerHTML = `<button aria-controls="mm">open</button><ul id="mm" role="menu"></ul>`;
    expect(isPersistentNavMenu(document.getElementById("mm")!, "menu")).toBe(false);
  });
  it("role=menu 在 <nav> landmark 内 → true(导航结构)", () => {
    document.body.innerHTML = `<nav><ul id="n" role="menu"></ul></nav>`;
    expect(isPersistentNavMenu(document.getElementById("n")!, "menu")).toBe(true);
  });
  it("role=tree 无触发器(常驻文件树)→ true", () => {
    document.body.innerHTML = `<ul id="t" role="tree"></ul>`;
    expect(isPersistentNavMenu(document.getElementById("t")!, "tree")).toBe(true);
  });
  it("role=listbox(下拉弹层)不在此列 → false(仍交位置判据)", () => {
    document.body.innerHTML = `<ul id="lb" role="listbox"></ul>`;
    expect(isPersistentNavMenu(document.getElementById("lb")!, "listbox")).toBe(false);
  });
  it("role=dialog → false", () => {
    document.body.innerHTML = `<div id="d" role="dialog"></div>`;
    expect(isPersistentNavMenu(document.getElementById("d")!, "dialog")).toBe(false);
  });
});

describe("inject func isPersistentMenu 内联同步锁", () => {
  const SRC2 = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
    "utf8",
  );
  it("内联 overlay 收集排除持久菜单(role=menu/tree 无触发器不计浮层)", () => {
    expect(SRC2).toContain("isPersistentMenu");
    expect(SRC2).toContain("aria-controls~=");
    expect(SRC2).toMatch(/&& !isPersistentMenu\(el, role\)/);
  });
});
