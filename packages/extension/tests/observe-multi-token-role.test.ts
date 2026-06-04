import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:多 token(回退列表)role 属性泄漏(2026-06-03 第十四轮 Wikipedia
 * 真实站 dogfood,AM)。
 *
 * 现象:Wikipedia 可排序表头 `role="columnheader button"`(ARIA 允许 role 是
 *   空格分隔的「回退角色列表」,浏览器取首个有效 token = columnheader)。
 *   getRole 旧逻辑 `const explicit = el.getAttribute("role"); if (explicit) return explicit;`
 *   逐字返回整串 → observe 输出畸形双词 role `[columnheader button]`,agent 无法
 *   匹配任何已知 role。这是真实 ARIA 渐进增强模式(role="menuitem button" 等)的
 *   通用 bug,影响所有 wikitable 排序表(数百万页面)。
 *
 * 修复:取首个空格分隔 token 近似 ARIA「首个有效 token」规则(作者惯例主角色置首)。
 *   role 仅空格时回落到隐式 role 推导(tag-based)。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe 多 token role 取首 token(AM,2026-06-03 dogfood)", () => {
  it("getRole 对显式 role 取首个空格分隔 token(非逐字返回整串)", () => {
    // 不再有「if (explicit) return explicit;」逐字返回。
    expect(OBSERVE_SRC).not.toMatch(/if \(explicit\) return explicit;/);
    // 改为 split 取首 token。
    expect(OBSERVE_SRC).toMatch(/explicit\.trim\(\)\.split\(\/\\s\+\/\)\[0\]/);
  });

  it("getRole 首 token 为空(role 仅空格)时回落隐式 role 推导", () => {
    // split 后取 [0] 再判真值才 return,空则继续往下走 tag-based 推导。
    expect(OBSERVE_SRC).toMatch(/const first = explicit\.trim\(\)\.split\(\/\\s\+\/\)\[0\];\s*\n\s*if \(first\) return first;/);
  });

  // cursor:pointer fallback 的非交互 role 过滤也必须取首 token(2026-06-04 多 agent
  // 审计 #7,LIVE 确认)。
  //
  // 现象:可点卡片把 cursor:pointer 继承给 role="text button" 文本叶子。
  //   getRole 取首 token "text" 输出 [text],但 fallback 噪声过滤用整串
  //   NON_INTERACTIVE_ROLES.has("text button")=false → 不跳过 → 幽灵
  //   `[text] "2.1万 views"` 入池(youtube 观看数类假阳的多 token 变体)。
  //
  // 修复:fallback role 检查 .has() 前同样取首 token,与 getRole 一致。
  it("cursor:pointer fallback 的非交互 role 过滤取首 token(非整串)", () => {
    // fallbackRole 必须先 split 取首 token 再 .has()——否则多 token role
    // (role=\"text button\")整串永不命中集合,幽灵文本叶子续命。
    expect(OBSERVE_SRC).toMatch(
      /fallbackRole\s*=\s*el\.getAttribute\("role"\)\??\.?\s*[\s\S]{0,80}\.split\(\/\\s\+\/\)\[0\]/,
    );
  });
});
