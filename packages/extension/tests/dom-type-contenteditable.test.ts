import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock for the contentEditable type path added in Round 1
 * (R1-A, 2026-05-20). Without this branch, vortex_act(action="type")
 * against a contentEditable div either:
 *   - throws JS_EXECUTION_ERROR "Illegal invocation" when the input
 *     setter is later reached, or
 *   - silently no-ops (the legacy KeyboardEvent dispatch path's
 *     `if (el.value !== undefined)` guard skips the write since
 *     contentEditable divs don't have .value)
 *
 * Source-level contract: DomActions.TYPE must run a host-side probe
 * that detects isContentEditable, and on `true` must route to the
 * Chrome DevTools Protocol `Input.insertText` command — the only
 * input pathway whose events have `isTrusted=true` and therefore
 * reach ProseMirror / Slate / Lexical / Notion / Confluence's
 * beforeinput pipeline.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "dom.ts"),
  "utf8",
);

describe("dom.type contentEditable path (@since 0.8.x Round-1 R1-A)", () => {
  it("probes isContentEditable from page-side", () => {
    expect(DOM_SRC).toMatch(/isContentEditable:\s*el\.isContentEditable\s*===\s*true/);
  });

  it("attaches debugger before sending CDP command", () => {
    // The probe → debugger.attach → Input.insertText ordering must
    // be preserved so the debugger session exists when insertText
    // fires. CDP-first 转正后 input/textarea 也默认走 CDP,故 guard 变为
    // `probe?.isContentEditable || cdpTypeEligible`;contentEditable 仍在其内。
    const block = DOM_SRC.match(
      /if\s*\(\s*probe\?\.isContentEditable[\s\S]*?debuggerMgr\.attach\(tid\)/,
    );
    expect(block).not.toBeNull();
  });

  it("uses Input.insertText (not Input.dispatchKeyEvent) on contentEditable path", () => {
    // The contentEditable branch must call insertText (whole-string)
    // OR per-character when delay > 0. dispatchKeyEvent for chars
    // is the legacy synthetic path — fine for input/textarea but
    // does not reach ProseMirror's beforeinput.
    const cePath = DOM_SRC.match(
      /probe\?\.isContentEditable[\s\S]*?Input\.insertText/,
    );
    expect(cePath).not.toBeNull();
  });

  it("honors delay by chunking insertText per character", () => {
    // delay > 0 must dispatch one CDP call per character so the
    // total wall-clock matches the LLM's pacing expectation.
    expect(DOM_SRC).toMatch(
      /if\s*\(\s*delay\s*>\s*0\s*\)\s*\{[\s\S]{0,200}for\s*\(\s*const\s+ch\s+of\s+text\s*\)[\s\S]{0,200}Input\.insertText/,
    );
  });

  it("pre-focuses element in page-side probe (CDP target needs a focused element)", () => {
    // Without focus, Input.insertText has nowhere to land. The
    // probe block must invoke el.focus() before returning.
    const probeBlock = DOM_SRC.match(
      /Pre-focus[\s\S]{0,400}el\.focus\(\)/,
    );
    expect(probeBlock).not.toBeNull();
  });

  it("falls back to page-side dispatch (with key events) for non-contentEditable elements", () => {
    // input/textarea 仍走 page-side dispatch 路径并保留合成 key 事件(keydown/keyup,
    // bench 50 case 依赖)。2026-06-03 族 F 修复把逐字值赋值从 `el.value += char` 换成
    // 原生 value setter(受控同步)+ clear-before + 非 text 类型整体写入,但 key 事件与
    // path 标识不变 —— 见 act-primitives-p1-batch3-family-f.test.ts 守护新行为。
    expect(DOM_SRC).toMatch(/page-side-dispatch/);
    expect(DOM_SRC).toMatch(/dispatchEvent\(new\s+KeyboardEvent\("keydown"/);
    expect(DOM_SRC).toMatch(/dispatchEvent\(new\s+InputEvent\("input"/);
  });

  it("emits `path` field on the result so callers can tell which branch ran", () => {
    expect(DOM_SRC).toMatch(/path:\s*"cdp-insertText"/);
    expect(DOM_SRC).toMatch(/path:\s*"page-side-dispatch"/);
  });

  // clear-before 回归锁(多 agent 审计 #4,2026-06-04 LIVE 确认)。
  //
  // 现象:type 一段文本到已有内容的 contentEditable,结果是 "NEW"+旧内容拼接
  //   ("NEWexisting")。CDP Input.insertText 在选区/光标处插入,空选区时不清空
  //   已有内容 → 拼接。与 input/textarea 路径(clear-before)契约不一致。
  //
  // 修复:probe 在 el.focus() 后,对 contentEditable 全选节点内容(Selection +
  //   range.selectNodeContents),使后续 insertText 替换选区。仅在有文本要写时
  //   全选(text !== ""),type("") 保持 no-op。
  it("contentEditable 路径 clear-before:probe 全选已有内容让 insertText 替换", () => {
    // 用 Selection API 全选节点内容(range.selectNodeContents)。
    expect(DOM_SRC).toMatch(/selectNodeContents/);
    // 全选受「是否有文本要写」门控。CDP-first 转正后 select-all 提到统一 probe:
    // input/textarea 走 el.select()、contentEditable 走 range(嵌套在 if(selectAll) 内)。
    expect(DOM_SRC).toMatch(/if\s*\(\s*selectAll\s*\)\s*\{\s*if\s*\(\s*el\.isContentEditable/);
  });

  it("contentEditable clear-before 仅在 text 非空时触发(type(\"\") 保持 no-op)", () => {
    // probe 的 selectAll 实参由 `text !== ""` 传入,空串不全选不清空。
    expect(DOM_SRC).toMatch(/\[selector,\s*text\s*!==\s*""\]/);
  });
});
