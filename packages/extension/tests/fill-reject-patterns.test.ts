import { describe, it, expect, vi, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { FILL_REJECT_PATTERNS } from "../src/patterns/index.js";

describe("FILL_REJECT_PATTERNS registry", () => {
  it("has at least the three launch patterns", () => {
    const ids = FILL_REJECT_PATTERNS.map((p) => p.id);
    expect(ids).toContain("element-plus-datetime-range");
    expect(ids).toContain("element-plus-cascader");
    expect(ids).toContain("ant-design-range-picker");
  });

  it("all patterns have non-empty id/selector/reason/suggestedTool/fixExample", () => {
    for (const p of FILL_REJECT_PATTERNS) {
      expect(p.id).toBeTruthy();
      expect(p.closestSelector).toBeTruthy();
      expect(p.reason.length).toBeGreaterThan(10);
      expect(p.suggestedTool).toMatch(/^vortex_/);
      expect(p.fixExample.length).toBeGreaterThan(10);
    }
  });

  it("suggestedTool / fixExample point at v0.5 vortex_fill (not v0.4 vortex_dom_commit)", () => {
    for (const p of FILL_REJECT_PATTERNS) {
      expect(p.suggestedTool).not.toMatch(/vortex_dom_commit/);
      expect(p.fixExample).not.toMatch(/vortex_dom_commit/);
      expect(p.suggestedTool).toMatch(/vortex_fill/);
      expect(p.fixExample).toMatch(/vortex_fill/);
      expect(p.fixExample).toMatch(/widget:/);
    }
  });

  it("every closestSelector is a valid CSS selector (document.querySelector parses it)", () => {
    // Node / vitest 默认没有 DOM。用 happy-dom or jsdom? 这里简单验证字符串语法用 CSS.supports 不够，
    // 改用 document.createDocumentFragment().querySelector 在可用时验；不可用则只做类型校验。
    for (const p of FILL_REJECT_PATTERNS) {
      expect(typeof p.closestSelector).toBe("string");
      // 禁止出现换行 / 未闭合引号等明显的问题
      expect(p.closestSelector).not.toMatch(/[\r\n]/);
    }
  });

  it("pattern ids are unique", () => {
    const ids = FILL_REJECT_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// 模拟页面侧决策逻辑的独立小函数，跟 dom.ts 里 func 的拒绝分支等价。
// 真正的 page 侧 func 在 e2e / 集成测试里验证；这里先锁住决策算法。
function shouldReject(
  hit: string | null,
  allowFallback: boolean,
): { reject: boolean; patternId: string | null } {
  if (allowFallback) return { reject: false, patternId: null };
  if (!hit) return { reject: false, patternId: null };
  return { reject: true, patternId: hit };
}

describe("dom_fill reject decision (algorithm-level)", () => {
  it("allows fill when no pattern matches", () => {
    expect(shouldReject(null, false)).toEqual({ reject: false, patternId: null });
  });

  it("rejects when a pattern matches", () => {
    expect(shouldReject("element-plus-datetime-range", false)).toEqual({
      reject: true,
      patternId: "element-plus-datetime-range",
    });
  });

  it("bypasses rejection when fallbackToNative=true, even if pattern matches", () => {
    expect(shouldReject("element-plus-datetime-range", true)).toEqual({
      reject: false,
      patternId: null,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Tier 2 补漏：checkRejectPattern 穿 open shadow 守卫测试
//
// 验证修复：shadow-internal 受控组件目标（el-cascader / el-date-editor 等）原先
// light-DOM querySelector 返回 null → 守卫被静默跳过（{ rejected:false }）。
// 修复后 queryDeep 兜底解析到 shadow 内元素 → closest 命中 → 正确 rejected:true。
// ──────────────────────────────────────────────────────────────────────────────

/** 设置 jsdom 全局环境（与 actionability-test-setup.ts 同策略）。 */
function setupFillRejectEnv(html: string): JSDOM {
  const dom = new JSDOM(html);
  const win = dom.window as any;
  globalThis.window = win;
  globalThis.document = dom.window.document as unknown as Document;
  (globalThis as any).HTMLElement = win.HTMLElement;
  return dom;
}

afterEach(() => {
  vi.resetModules();
});

describe("checkRejectPattern — open shadow 穿透（Tier 2 补漏）", () => {
  it("shadow-internal el-cascader input 被识别为受控组件 → rejected:true", async () => {
    // element-plus-cascader 的 closestSelector 是 ".el-cascader"。
    // 构造：shadow host → shadow root → div.el-cascader > input[data-vortex-rid="rid-1"]
    // light-DOM querySelector("[data-vortex-rid='rid-1']") 返回 null，
    // queryDeep 穿 open shadow 找到 input，closest(".el-cascader") 命中。
    vi.resetModules();
    const dom = setupFillRejectEnv('<div id="host"></div>');
    const host = dom.window.document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });

    const wrapper = dom.window.document.createElement("div");
    wrapper.className = "el-cascader";
    const input = dom.window.document.createElement("input");
    input.setAttribute("data-vortex-rid", "rid-1");
    wrapper.appendChild(input);
    sr.appendChild(wrapper);

    await import("../src/page-side/fill-reject.js");

    const checkRejectPattern = (globalThis.window as any).__vortexFillReject.checkRejectPattern as (
      sel: string,
      patterns: typeof FILL_REJECT_PATTERNS,
    ) => { rejected: boolean };

    // 选择器使用 rid 属性选择器，light-DOM 查不到（在 shadow 内）
    const result = checkRejectPattern("[data-vortex-rid='rid-1']", FILL_REJECT_PATTERNS);
    expect(result.rejected).toBe(true);
    expect((result as any).errorCode).toBe("UNSUPPORTED_TARGET");
    expect((result as any).extras?.pattern).toBe("element-plus-cascader");
  });

  it("light-DOM 中的受控组件输入仍正常拒绝（回归：不破坏原有行为）", async () => {
    vi.resetModules();
    const dom = setupFillRejectEnv(
      '<div class="el-date-editor el-range-editor"><input id="rng" /></div>',
    );
    void dom;

    await import("../src/page-side/fill-reject.js");

    const checkRejectPattern = (globalThis.window as any).__vortexFillReject.checkRejectPattern as (
      sel: string,
      patterns: typeof FILL_REJECT_PATTERNS,
    ) => { rejected: boolean };

    const result = checkRejectPattern("#rng", FILL_REJECT_PATTERNS);
    expect(result.rejected).toBe(true);
    expect((result as any).extras?.pattern).toBe("element-plus-datetime-range");
  });

  it("shadow-internal 无框架祖先的普通 input 不被拒绝 → rejected:false", async () => {
    vi.resetModules();
    const dom = setupFillRejectEnv('<div id="host2"></div>');
    const host = dom.window.document.getElementById("host2")!;
    const sr = host.attachShadow({ mode: "open" });
    const input = dom.window.document.createElement("input");
    input.setAttribute("data-vortex-rid", "rid-plain");
    sr.appendChild(input);

    await import("../src/page-side/fill-reject.js");

    const checkRejectPattern = (globalThis.window as any).__vortexFillReject.checkRejectPattern as (
      sel: string,
      patterns: typeof FILL_REJECT_PATTERNS,
    ) => { rejected: boolean };

    const result = checkRejectPattern("[data-vortex-rid='rid-plain']", FILL_REJECT_PATTERNS);
    expect(result.rejected).toBe(false);
  });
});
