import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:FILL handler 对 `<textarea>` 必须用 HTMLTextAreaElement 的原生 value setter,
 * 不能无条件用 HTMLInputElement 的(2026-06-03 第十七轮 Bing 真实站 dogfood)。
 *
 * 现象:`vortex_act(textarea, fill, ...)` 抛 `JS_EXECUTION_ERROR: Illegal invocation`。
 *   Bing/Google 的搜索框现在都是 `<textarea role="combobox">`,评论框/聊天输入框也多为
 *   textarea —— fill 对它们整类失效,直接阻断使用。
 *
 * 根因:FILL 走原生 value setter 是为绕过 React 受控组件覆盖的 setter,但代码无条件取
 *   `HTMLInputElement.prototype` 的 setter 再 `.call(el)`。当 `el` 是 `<textarea>` 时,
 *   浏览器对原生访问器做品牌检查(receiver 必须是 HTMLInputElement 实例),textarea 不是
 *   → 抛 "Illegal invocation"。已在 Bing 真实 textarea 上实证:input-setter 抛该错、
 *   textarea-setter 正常写入。
 *
 * 修复:按元素实际类型选原生 value setter——textarea 用 HTMLTextAreaElement.prototype、
 *   input 用 HTMLInputElement.prototype;都不匹配才回退 `el.value = val`。
 *
 * page-side inline func 跑在 executeScript 内不可 import,故用 source-grep 守护。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");

describe("FILL handler textarea 原生 value setter (2026-06-03 Bing dogfood)", () => {
  it("按元素类型选 setter:textarea 用 HTMLTextAreaElement.prototype", () => {
    expect(DOM_SRC).toMatch(/HTMLTextAreaElement\.prototype/);
  });

  it("仍保留 HTMLInputElement.prototype 路径供 <input> 使用", () => {
    expect(DOM_SRC).toMatch(/HTMLInputElement\.prototype/);
  });

  it("FILL 不再无条件对所有元素用 input setter(用 instanceof 判型)", () => {
    // FILL 块内必须出现 textarea 类型判别,确保不再对 textarea 误用 input setter
    const fillIdx = DOM_SRC.indexOf("// === fill operation ===");
    expect(fillIdx).toBeGreaterThan(-1);
    const fillBlock = DOM_SRC.slice(fillIdx, fillIdx + 800);
    expect(fillBlock).toMatch(/instanceof\s+HTMLTextAreaElement/);
    expect(fillBlock).toMatch(/HTMLTextAreaElement\.prototype/);
  });

  it("contenteditable 走 fill 时响亮报错而非静默假成功(回退 el.value=val 会伪装成功)", () => {
    // contenteditable 不是 value-bearing 元素,valueProto 为 null 会落到 `el.value = val`
    // 写幽灵 expando + dispatch 事件 → success:true 但页面无变化。必须在 fill 前拦截报错。
    // CDP-first 转正后 TYPE probe 也有 `if (el.isContentEditable) {`(select-all 分支)
    // 在 FILL 之前,故从 FILL 写值标记向前 lastIndexOf 定位 FILL 块内的 contentEditable guard。
    const fillOpIdx = DOM_SRC.indexOf("// === fill operation ===");
    const guardIdx = DOM_SRC.lastIndexOf("if (el.isContentEditable) {", fillOpIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    // guard 必须在 fill 写值操作之前
    expect(guardIdx).toBeLessThan(fillOpIdx);
    const guardBlock = DOM_SRC.slice(guardIdx, guardIdx + 200);
    expect(guardBlock).toMatch(/errorCode:\s*"INVALID_TARGET"/);
    // 指引 agent 改用 type action
    expect(guardBlock).toMatch(/type/);
  });
});
