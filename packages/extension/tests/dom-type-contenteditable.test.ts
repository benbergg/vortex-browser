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
    // fires. Snapshot the canonical block: a probe.isContentEditable
    // guard followed by debuggerMgr.attach.
    const block = DOM_SRC.match(
      /if\s*\(\s*probe\?\.isContentEditable\s*\)\s*\{[\s\S]*?debuggerMgr\.attach\(tid\)/,
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
    // 全选受「是否有文本要写」门控,且仅对 contentEditable(避免误清 input/textarea
    // ——它们走另一分支自带 clear-before)。
    expect(DOM_SRC).toMatch(/selectAll\s*&&\s*el\.isContentEditable/);
  });

  it("contentEditable clear-before 仅在 text 非空时触发(type(\"\") 保持 no-op)", () => {
    // probe 的 selectAll 实参由 `text !== ""` 传入,空串不全选不清空。
    expect(DOM_SRC).toMatch(/\[selector,\s*text\s*!==\s*""\]/);
  });

  // silent-false-success 护栏回归锁(白盒实机复现,2026-06-20)。
  //
  // 现象:对 beforeinput.preventDefault() 的只读/受限富文本编辑器 type 文本,
  //   CDP Input.insertText 被拒、内容纹丝未动,但 contentEditable 路径无回读校验,
  //   照报 {success:true, typed:N}。与 input/textarea 路径(786-793 回读 NO_EFFECT)
  //   护栏不对称——族 A 遗漏点。
  //
  // 修复:probe 捕获写入前 textContent(ceText),insertText 后回读比对,内容完全
  //   未变且未含写入文本 → NO_EFFECT。
  it("contentEditable 路径 probe 捕获写入前文本基线(ceText)", () => {
    // probe 返回 ceText 作为回读校验基线。
    expect(DOM_SRC).toMatch(/ceText/);
  });

  it("contentEditable insertText 后回读校验,内容未变且未含写入文本 → NO_EFFECT", () => {
    // insertText 之后、cdp-insertText 结果之前,必须有一次回读把 NO_EFFECT 守卫
    // 接到 mapPageError(对齐 input/textarea 路径的硬失败上报)。
    const guard = DOM_SRC.match(
      /Input\.insertText[\s\S]*?errorCode:\s*"NO_EFFECT"[\s\S]*?path:\s*"cdp-insertText"/,
    );
    expect(guard).not.toBeNull();
    // 守卫条件:内容完全未变(now === before)且未含写入文本(now !== txt),
    // 避免「重输相同文本」假阳、对齐 input 路径只报硬失败的克制。
    expect(DOM_SRC).toMatch(/now\s*===\s*before\s*&&\s*now\s*!==\s*txt/);
  });
});
