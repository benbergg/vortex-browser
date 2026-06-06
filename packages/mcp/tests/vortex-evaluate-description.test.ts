import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * TDD: vortex_evaluate description 必须点出 MAIN world + cross-origin iframe 边界
 * (B3-5, v3.1 P2).
 *
 * Background: vortex_evaluate 跑在 chrome.scripting.executeScript 的 MAIN world,
 * 受 Chrome same-origin policy 约束, 无法读跨域 iframe 的 contentDocument.
 * LLM 不知道这个边界就会调 code: "document.querySelector('iframe').contentDocument.body..."
 * 然后撞到 "Blocked a frame with origin ... from accessing a cross-origin frame" 错误.
 *
 * Fix: description 必须:
 *   1. 含 "MAIN world" 关键词 (告诉 LLM 这是 page context 而非 isolated)
 *   2. 含 "cross-origin iframe" 关键词 (明确边界)
 *   3. ≤ 60 char (I15 invariant)
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SRC = readFileSync(
  join(__dirname, "..", "src", "tools", "schemas-public.ts"),
  "utf8",
);

function getEvaluateDescription(): string {
  const m = SCHEMA_SRC.match(
    /name:\s*["']vortex_evaluate["'][\s\S]*?description:\s*([\s\S]*?),\s*schema:\s*\{/,
  );
  expect(m, "vortex_evaluate description block").not.toBeNull();
  return m![1]
    .replace(/"\s*\+\s*"/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

describe("vortex_evaluate description 文档化 (B3-5, v3.1)", () => {
  it("description 含 'MAIN world' 关键词 (B3-5 关键)", () => {
    const desc = getEvaluateDescription();
    expect(desc).toMatch(/MAIN world/i);
  });

  it("description 含 'cross-origin iframe' 关键词 (B3-5 关键)", () => {
    const desc = getEvaluateDescription();
    expect(desc).toMatch(/cross-origin iframe/i);
  });

  it("description 总长度 ≤ 60 char (I15 invariant 约束)", () => {
    const desc = getEvaluateDescription();
    expect(desc.length).toBeLessThanOrEqual(60);
  });

  it("description 保留 async 行为提示 (回归保护)", () => {
    const desc = getEvaluateDescription();
    // 不破 async 的现有契约 (async=fn body)
    expect(desc).toMatch(/async.*fn body|fn body.*async|async.*function body/i);
  });
});
