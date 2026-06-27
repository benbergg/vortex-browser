// @vitest-environment jsdom
/**
 * Description: N0002 B017 — <iframe> 元素召回。
 *   MDN 文档页 / PDF embed / video / 跨源 widget 都有 <iframe>, 但 vortex
 *   INTERACTIVE_SELECTORS 不含 iframe → 不进 baseCandidates → 完全忽略。
 *   修复: 在 INTERACTIVE_SELECTORS 加 "iframe", getRole 推断 role=iframe (无 title)
 *   或 role=region (有 title, frame landmark)。sandbox / src 走 attrs 透传。
 *   本测试 source-lock 注入体代码字面量, 与 observe-modal-scope.test.ts 模式一致。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/handlers/observe.ts"),
  "utf8",
);

describe("observe-iframe: B017 source-lock (N0002)", () => {
  it("INTERACTIVE_SELECTORS 数组含 'iframe' 字符串", () => {
    // 注入体 INTERACTIVE_SELECTORS = [ 'button', 'a[href]', 'iframe', ... ]
    // 注: 数组内有 [href] 字符串, regex 避免 [^\]]* (会被 a[href] 截断)。
    // 用 .indexOf 简单匹配: 找 "iframe" 在 INTERACTIVE_SELECTORS = [ 后的位置。
    const afterIdx = src.indexOf("const INTERACTIVE_SELECTORS = [");
    expect(afterIdx).toBeGreaterThan(-1);
    const window = src.slice(afterIdx, afterIdx + 1500);
    expect(window).toMatch(/['"]iframe['"]/);
  });

  it("getRole iframe 推断: tag==='iframe' + title 路径", () => {
    // role 推断: iframe + title → 'region' (frame landmark)
    expect(src).toMatch(/if\s*\(\s*tag\s*===\s*['"]iframe['"]\s*\)/);
    expect(src).toMatch(/return\s+el\.hasAttribute\(\s*['"]title['"]\s*\)\s*\?\s*['"]region['"]\s*:\s*['"]iframe['"]/);
  });

  it("iframe 注释说明 B017 + A5 backlog 关联", () => {
    expect(src).toMatch(/N0002 B017[\s\S]{0,200}iframe/i);
  });
});

describe("observe-iframe: B017 iframe role 推断(浏览器 DOM 真值, jsdom)", () => {
  // 真实推断逻辑在 inject func 内, 复刻核心规则测试:
  // 复刻自 observe.ts:961-983 提取的纯函数 (与内联副本同步)。
  function inferIframeRole(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) {
      const first = explicit.trim().split(/\s+/)[0];
      if (first) return first;
    }
    if (el.tagName.toLowerCase() === "iframe") {
      return el.hasAttribute("title") ? "region" : "iframe";
    }
    return el.tagName.toLowerCase();
  }

  it("iframe 无 title → role=iframe", () => {
    document.body.innerHTML = `<iframe src="https://example.com"></iframe>`;
    expect(inferIframeRole(document.querySelector("iframe")!)).toBe("iframe");
  });

  it("iframe 有 title → role=region", () => {
    document.body.innerHTML = `<iframe src="https://example.com" title="Map"></iframe>`;
    expect(inferIframeRole(document.querySelector("iframe")!)).toBe("region");
  });

  it("iframe 显式 role=region 优先", () => {
    document.body.innerHTML = `<iframe src="x" role="region"></iframe>`;
    expect(inferIframeRole(document.querySelector("iframe")!)).toBe("region");
  });

  it("iframe srcdoc 仍 role=iframe (无 title)", () => {
    document.body.innerHTML = `<iframe srcdoc="<p>hi</p>"></iframe>`;
    expect(inferIframeRole(document.querySelector("iframe")!)).toBe("iframe");
  });

  it("非 iframe 元素不受影响", () => {
    document.body.innerHTML = `<div></div>`;
    expect(inferIframeRole(document.querySelector("div")!)).toBe("div");
  });
});
