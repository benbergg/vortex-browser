import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { textSearchFunc } from "../src/handlers/query.js";

/**
 * 2026-06-14 真实站评测(the-internet/javascript_alerts):vortex_query mode=text
 * 描述称 "greps visible text",但 page-side TreeWalker 用裸 SHOW_TEXT 遍历 body 下
 * **全部**文本节点,把 <script>/<style>/<noscript>/<template> 的源码文本、以及
 * display:none 隐藏元素的文本一并计入 → 对内联 <script> 里的 "successfully clicked"
 * 产生假匹配(element_path 以 > script 结尾)。本测试锁:不可见文本不得进 grep 结果。
 *
 * textSearchFunc 是注入 page-side 的纯函数,JSDOM 直接执行验证真实遍历行为
 * (非 mock executeScript)。
 */
describe("query mode=text 只 grep 可见文本(@since 2026-06-14 real-site eval)", () => {
  beforeEach(() => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).NodeFilter = dom.window.NodeFilter;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
  });

  it("命中可见文本", () => {
    document.body.innerHTML = `<p id="result">You successfully clicked an alert</p>`;
    const r = textSearchFunc("successfully clicked", false, false, 40, 10) as {
      matches: Array<{ element_path: string }>;
      total: number;
    };
    expect(r.total).toBe(1);
    expect(r.matches[0].element_path).toContain("p#result");
  });

  it("不匹配 <script> 内的源码文本", () => {
    document.body.innerHTML = `
      <script>function jsAlert(){ log('You successfully clicked an alert'); }</script>
      <p id="result">Result: nothing yet</p>`;
    const r = textSearchFunc("successfully clicked", false, false, 40, 10) as {
      matches: Array<{ element_path: string }>;
      total: number;
    };
    // 唯一的出现在 <script> 里 → 过滤后应 0 命中
    expect(r.total).toBe(0);
    expect(r.matches.length).toBe(0);
  });

  it("不匹配 <style> / <noscript> / <template> 内的文本", () => {
    document.body.innerHTML = `
      <style>.x::after{content:"hiddenmarker"}</style>
      <noscript>hiddenmarker noscript</noscript>
      <template>hiddenmarker template</template>
      <p>visible only</p>`;
    const r = textSearchFunc("hiddenmarker", false, false, 20, 10) as { total: number };
    expect(r.total).toBe(0);
  });

  it("不匹配 display:none 隐藏元素的文本(checkVisibility 兜底)", () => {
    document.body.innerHTML = `
      <div id="hidden">secretmarker hidden</div>
      <p>visible only</p>`;
    // JSDOM 不实现 checkVisibility:为 hidden 元素打桩返回 false 复刻真实 Chrome 行为
    const hidden = document.getElementById("hidden")!;
    (hidden as any).checkVisibility = () => false;
    const r = textSearchFunc("secretmarker", false, false, 20, 10) as { total: number };
    expect(r.total).toBe(0);
  });

  it("checkVisibility 缺失时不误杀可见文本(向后兼容)", () => {
    // 不打桩 checkVisibility(JSDOM 默认无此 API)→ 可见文本仍正常命中
    document.body.innerHTML = `<p>plainvisible text here</p>`;
    const r = textSearchFunc("plainvisible", false, false, 20, 10) as { total: number };
    expect(r.total).toBe(1);
  });
});
