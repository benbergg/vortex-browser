import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:act 原语白盒审计批次 1(P0)。page-side inline func 跑在 executeScript
 * 内不可 import,故对结构性不变量用 source-grep 守护;真实行为由 live 验证(见
 * dogfood 报告 §24)。2026-06-03 act 原语白盒审计。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");
const AUTOWAIT_SRC = readFileSync(
  join(__dirname, "../src/action/auto-wait.ts"),
  "utf8",
);

describe("族 D — 共享门超时 cap < MCP 传输超时(#1)", () => {
  it("waitActionable 把 timeout cap 在 MAX_ACTIONABLE_TIMEOUT_MS", () => {
    expect(AUTOWAIT_SRC).toMatch(/MAX_ACTIONABLE_TIMEOUT_MS\s*=\s*25_?000/);
    expect(AUTOWAIT_SRC).toMatch(
      /Math\.min\(\s*options\.timeout\s*\?\?\s*DEFAULT_TIMEOUT_MS\s*,\s*MAX_ACTIONABLE_TIMEOUT_MS\s*,?\s*\)/,
    );
  });

  it("cap 严格小于传输层默认 30000(留 margin)", () => {
    const m = AUTOWAIT_SRC.match(/MAX_ACTIONABLE_TIMEOUT_MS\s*=\s*([\d_]+)/);
    expect(m).not.toBeNull();
    const val = parseInt(m![1].replace(/_/g, ""), 10);
    expect(val).toBeLessThan(30_000);
    expect(val).toBeLessThanOrEqual(27_000);
  });
});

describe("族 B — FILL 元素类型分流报错(#3 select / #6 checkbox-radio)", () => {
  it("FILL 对原生 <select> 报 INVALID_TARGET 指引 select action", () => {
    expect(DOM_SRC).toMatch(
      /el instanceof HTMLSelectElement[\s\S]{0,160}INVALID_TARGET[\s\S]{0,80}use action "select"/,
    );
  });

  it("FILL 对 checkbox/radio 报 INVALID_TARGET 指引 click action", () => {
    expect(DOM_SRC).toMatch(/el\.type === "checkbox" \|\| el\.type === "radio"/);
    expect(DOM_SRC).toMatch(/use action "click" to toggle/);
  });

  it("guard 都在 fill 写值操作之前", () => {
    const selectGuard = DOM_SRC.indexOf("is a <select>; use action");
    const fillOp = DOM_SRC.indexOf("// === fill operation ===");
    expect(selectGuard).toBeGreaterThan(-1);
    expect(selectGuard).toBeLessThan(fillOp);
  });
});

describe("族 E — native <select multiple> 多选(#4)", () => {
  it("SELECT handler value 类型放宽为 string | string[]", () => {
    expect(DOM_SRC).toMatch(/const value = args\.value as string \| string\[\]/);
  });

  it("inline func 对数组 value 走多选分支", () => {
    expect(DOM_SRC).toMatch(/if \(Array\.isArray\(val\)\)/);
  });

  it("非 multiple 传数组报 INVALID_PARAMS", () => {
    expect(DOM_SRC).toMatch(
      /if \(!el\.multiple\)[\s\S]{0,120}INVALID_PARAMS/,
    );
  });

  it("多选逐 option 设 .selected(非单值赋值)", () => {
    expect(DOM_SRC).toMatch(/for \(const o of opts\) o\.selected = false/);
    expect(DOM_SRC).toMatch(/for \(const m of matched\) m\.selected = true/);
  });

  it("回读校验副作用真发生,不一致报 NO_EFFECT(族 A 处方)", () => {
    expect(DOM_SRC).toMatch(/el\.selectedOptions/);
    expect(DOM_SRC).toMatch(/errorCode:\s*"NO_EFFECT"/);
  });

  it("matched 去重避免重复匹配同一 option 误报 NO_EFFECT(评审 M1)", () => {
    // ["Apple","Apple"] 或 value+文本命中同一项时,不去重会让 matched.length >
    // selectedOptions.length 误报。用 Set 去重。
    expect(DOM_SRC).toMatch(/const seen = new Set<HTMLOptionElement>\(\)/);
    expect(DOM_SRC).toMatch(/if \(!seen\.has\(m\)\)/);
  });
});

describe("族 C — HOVER 走 CDP 真鼠标触发 CSS :hover(#2)", () => {
  it("HOVER probe 先 scrollIntoView 再算中心坐标", () => {
    const hoverIdx = DOM_SRC.indexOf("DomActions.HOVER");
    const block = DOM_SRC.slice(hoverIdx, hoverIdx + 2400);
    expect(block).toMatch(/scrollIntoView\(\{ block: "center", inline: "center" \}\)/);
    expect(block).toMatch(/const cx = rect\.left \+ rect\.width \/ 2/);
  });

  it("HOVER 发 CDP Input.dispatchMouseEvent mouseMoved 到元素中心", () => {
    // handler 层 CDP 调用在 inline func 之后;mouseMoved / getIframeOffset 在 dom.ts
    // 内 HOVER 独有(TYPE 用 insertText、CLICK 的 offset 在 cdp.ts),直接对全文件匹配。
    expect(DOM_SRC).toMatch(/debuggerMgr\.sendCommand\(\s*tid,\s*"Input\.dispatchMouseEvent"/);
    expect(DOM_SRC).toMatch(/type:\s*"mouseMoved"/);
    expect(DOM_SRC).toMatch(/getIframeOffset\(tid, frameId\)/);
  });

  it("mouseenter 合成事件用 bubbles:false 修正语义", () => {
    const hoverIdx = DOM_SRC.indexOf("DomActions.HOVER");
    const block = DOM_SRC.slice(hoverIdx, hoverIdx + 2600);
    expect(block).toMatch(/new MouseEvent\("mouseenter", \{ bubbles: false/);
  });
});
