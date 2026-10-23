// instructions 端到端护栏：server 下发的正文必须首尾哨兵完整、带版本，
// 且 10 条契约的逐字串一条不缺、体积不超预算。
//
// 方向不可反：本测试从 contract.ts 取真值（单一真值），instructions.ts 也从
// contract.ts 取真值渲染正文——同源才不会出现"两边各说各话"。

import { describe, expect, it } from "vitest";
import { buildInstructions } from "../src/instructions.js";
import {
  CONTRACT_ITEMS,
  SENTINEL_PREFIX,
  SENTINEL_SUFFIX,
  estimateTokens,
  INSTRUCTIONS_TOKEN_BUDGET,
} from "../src/contract.js";

describe("instructions", () => {
  it("首尾哨兵完整且带版本", () => {
    const text = buildInstructions("4.1.0");
    expect(text.startsWith(`${SENTINEL_PREFIX}4.1.0`)).toBe(true);
    expect(text.trimEnd().endsWith(`${SENTINEL_SUFFIX}4.1.0`)).toBe(true);
  });

  it("每条契约的逐字串都在正文里", () => {
    const text = buildInstructions("4.1.0");
    for (const item of CONTRACT_ITEMS) {
      for (const s of item.mustInclude) expect(text, `${item.key}:${s}`).toContain(s);
    }
  });

  it("体积不超预算", () => {
    expect(estimateTokens(buildInstructions("4.1.0"))).toBeLessThanOrEqual(
      INSTRUCTIONS_TOKEN_BUDGET,
    );
  });
});
