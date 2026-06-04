import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:getAccessibleName 的 aria-label / aria-labelledby 计算修复
 * (2026-06-04 多 agent 审计 observe-计算)。
 *
 * 1. aria-label 裸返回不过 normName:full 模式下含换行/超长的 aria-label 会泄漏进
 *    observe 炸 token 预算。须 normName(归一空白 + cap 80),与其它 name 路径一致。
 * 2. aria-labelledby 整串 getElementById:aria-labelledby 是空格分隔 IDREF 列表
 *    (非单 ID),整串查只命中单 id 且仅主文档;多 IDREF / shadow 内全漏。须 split
 *    后在元素所在 root(支持 ShadowRoot.getElementById)逐个解析拼接。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe getAccessibleName aria-label/labelledby 计算 (2026-06-04 审计)", () => {
  it("aria-label 经 normName 归一化(非裸返回,防 full 模式换行/超长泄漏)", () => {
    expect(OBSERVE_SRC).toMatch(/const aria = el\.getAttribute\("aria-label"\);\s*\n\s*if \(aria\) return normName\(aria\)/);
  });

  it("aria-labelledby 按空格分隔解析多 IDREF(非整串 getElementById)", () => {
    expect(OBSERVE_SRC).toMatch(/labelledBy\.split\(\/\\s\+\/\)/);
    // 不再用整串 document.getElementById(labelledBy)。
    expect(OBSERVE_SRC).not.toMatch(/getElementById\(labelledBy\)/);
  });

  it("aria-labelledby 在元素所在 root 内解析(支持 shadow 的 getElementById)", () => {
    expect(OBSERVE_SRC).toMatch(/el\.getRootNode\(\)/);
    expect(OBSERVE_SRC).toMatch(/getElementById\(id\)/);
  });
});
