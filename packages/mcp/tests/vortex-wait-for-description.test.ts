import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dispatchNewTool } from "../src/tools/dispatch.js";

/**
 * TDD: vortex_wait_for description 必须明确 4 种 mode 区分
 * (B3-1, v3.1 P2).
 *
 * Background: 原 description "Wait element/idle/info/custom(value=JS expr truthy)."
 * 太隐晦, LLM 误把 JS 表达式 (e.g. 'location.href.includes("x")') 写到
 * mode:element 的 value, 被当作 CSS selector querySelector → 抛错 → 10s 超时.
 *
 * Fix: description 必须:
 *   1. 列出 4 种 mode: element / idle / info / custom
 *   2. 明确 element=**CSS selector**, custom=**JS expression** (B3-1 关键区分)
 *   3. 给具体示例避免 LLM 误用
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SRC = readFileSync(
  join(__dirname, "..", "src", "tools", "schemas-public.ts"),
  "utf8",
);

function getWaitForDescription(): string {
  // description 可能是字符串拼接 (e.g. "line1 " + "line2")
  // 从 name 字段起, 截到下一行 schema: { 之前
  const m = SCHEMA_SRC.match(
    /name:\s*["']vortex_wait_for["'][\s\S]*?description:\s*([\s\S]*?),\s*schema:\s*\{/,
  );
  expect(m, "vortex_wait_for description block").not.toBeNull();
  // 去掉字符串拼接的 "..." + 包装和转义引号
  return m![1]
    .replace(/"\s*\+\s*"/g, " ")  // 拼接点 → 空格
    .replace(/^["'`]+|["'`]+$/g, "")  // 头尾引号
    .replace(/\\"/g, '"')  // 转义引号
    .replace(/\s+/g, " ")   // 空白合并
    .trim();
}

describe("vortex_wait_for description 文档化 (B3-1, v3.1)", () => {
  it("description 列出全部 4 种 mode: element / idle / info / custom", () => {
    const desc = getWaitForDescription();
    expect(desc).toMatch(/element/);
    expect(desc).toMatch(/idle/);
    expect(desc).toMatch(/info/);
    expect(desc).toMatch(/custom/);
  });

  it("description 明确 element = CSS selector 关键词 (B3-1 关键)", () => {
    const desc = getWaitForDescription();
    // element 配 CSS (60 char 预算下不要求完整 "selector" 字)
    expect(desc).toMatch(/element[^"`]*CSS|element[^"`]*selector/i);
  });

  it("description 明确 custom = JS expression 关键词 (B3-1 关键)", () => {
    const desc = getWaitForDescription();
    // custom 配 JS (60 char 预算下不要求完整 "expression" 字)
    expect(desc).toMatch(/custom[^"`]*JS|custom[^"`]*expression/i);
  });

  it("description 不再使用旧隐晦措辞 (回归保护)", () => {
    const desc = getWaitForDescription();
    expect(desc).not.toMatch(/^Wait element\/idle\/info\/custom\(value=JS expr truthy\)\.$/);
  });

  it("description 总长度 ≤ 60 char (I15 invariant 约束)", () => {
    const desc = getWaitForDescription();
    expect(desc.length).toBeLessThanOrEqual(60);
  });
});

describe("vortex_wait_for dispatch 行为 (B3-1, 回归保护)", () => {
  it("mode:element + CSS selector → page.wait + selector 字段", () => {
    const r = dispatchNewTool("vortex_wait_for", { mode: "element", value: ".loaded" });
    expect(r?.action).toBe("page.wait");
    expect(r?.params.selector).toBe(".loaded");
  });

  it("mode:element + @ref 抛错 (显式引导用 CSS selector)", () => {
    expect(() => dispatchNewTool("vortex_wait_for", { mode: "element", value: "@e15" }))
      .toThrow(/CSS selector/);
  });

  it("mode:custom + JS expression → page.waitForExpression + expression 字段", () => {
    const r = dispatchNewTool("vortex_wait_for", {
      mode: "custom",
      value: "() => location.href.includes('x')",
    });
    expect(r?.action).toBe("page.waitForExpression");
    expect(r?.params.expression).toBe("() => location.href.includes('x')");
  });

  it("mode:idle + network → page.waitForNetworkIdle", () => {
    const r = dispatchNewTool("vortex_wait_for", { mode: "idle", value: "network" });
    expect(r?.action).toBe("page.waitForNetworkIdle");
  });
});
