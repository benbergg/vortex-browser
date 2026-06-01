import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock for the explicit-non-interactive-role precision fix
 * (youtube dogfood 2026-06-01).
 *
 * 现象:observe(filter:interactive)把视频卡内的观看数/时间戳报为可交互
 * `[text] "2.1万次观看"`。`getRole` 只有 `el.getAttribute("role")` 能返回
 * 字面 "text"(无任何 tag 映射到 "text"),所以输出里的 `[text]` 证明这些
 * 元素带显式 `role="text"`——ARIA 里明确的「纯文本、非控件」声明。
 *
 * 根因:可点卡片把 cursor:pointer 继承给内部 `role="text"` 文本叶子,叶子
 * 有非空文本 + 无交互祖先 → 进 cursor:pointer fallback;BUG-3 噪声过滤器里
 * `hasExplicitRole = !!getAttribute("role")` 对 role="text" 为真 → 续命。
 *
 * 修复:cursor:pointer fallback 跳过显式非交互 ARIA role(NON_INTERACTIVE_ROLES)。
 * 作者写下 role="text" 是比继承 cursor 更强的语义信号,优先尊重。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe non-interactive role filter — role=text precision (2026-06-01 youtube dogfood)", () => {
  it("defines NON_INTERACTIVE_ROLES including the role=text offender", () => {
    expect(OBSERVE_SRC).toMatch(/const NON_INTERACTIVE_ROLES = new Set\(\[/);
    // role="text" 是实测的具体误报来源,必须在集合内。
    const setMatch = OBSERVE_SRC.match(
      /const NON_INTERACTIVE_ROLES = new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(setMatch).not.toBeNull();
    expect(setMatch?.[1]).toMatch(/"text"/);
  });

  it("the cursor:pointer fallback skips explicit non-interactive roles", () => {
    // 跳过必须以 continue 表达(剔除该 candidate),且引用 NON_INTERACTIVE_ROLES。
    expect(OBSERVE_SRC).toMatch(
      /NON_INTERACTIVE_ROLES\.has\([a-zA-Z]+\)\)\s*continue;/,
    );
  });

  it("does NOT blanket-deny heading/group (accordion headers stay interactive)", () => {
    const setMatch = OBSERVE_SRC.match(
      /const NON_INTERACTIVE_ROLES = new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(setMatch?.[1]).not.toMatch(/"heading"/);
    expect(setMatch?.[1]).not.toMatch(/"group"/);
  });
});
