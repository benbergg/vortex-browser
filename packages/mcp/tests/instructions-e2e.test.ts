// instructions 端到端护栏：server 下发的正文必须首尾哨兵完整、带版本，
// 且 10 条契约的逐字串一条不缺、体积不超预算。
//
// 方向不可反：本测试从 contract.ts 取真值（单一真值），instructions.ts 也从
// contract.ts 取真值渲染正文——同源才不会出现"两边各说各话"。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildInstructions } from "../src/instructions.js";
import {
  CONTRACT_ITEMS,
  SENTINEL_PREFIX,
  SENTINEL_SUFFIX,
  estimateTokens,
  INSTRUCTIONS_TOKEN_BUDGET,
} from "../src/contract.js";

/**
 * instructions.ts 的源码（静态护栏用）。
 *
 * 读源码而非运行时行为，是为了钉死"逐字必须串只存在于 contract.ts 一处"：
 * 只要 instructions.ts 里再抄一份 mustInclude 字面量，本护栏就红。
 */
const INSTRUCTIONS_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "instructions.ts"),
  "utf8",
);

/** 去掉注释（注释里说明契约不算抄写），只留可执行代码。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

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

  // —— 单一真值护栏（评审 Important：逐字串不得在 instructions.ts 再抄一份）——

  it("instructions.ts 不再抄一份逐字必须串（逐字串只能来自 contract.ts）", () => {
    const code = codeOnly(INSTRUCTIONS_SRC);
    for (const item of CONTRACT_ITEMS) {
      for (const s of item.mustInclude) {
        expect(
          code,
          `instructions.ts 里出现了契约逐字串「${s}」（key=${item.key}）：必须改为从 CONTRACT_ITEMS 插入，不得另写一份`,
        ).not.toContain(s);
      }
    }
  });

  it("正文里的逐字串随契约变化自动跟随（插入式渲染，不是抄写）", () => {
    const originals = CONTRACT_ITEMS.map((item) => item.mustInclude);
    try {
      // 把每条契约的逐字串换成探针串：正文若为"抄写"实现，探针串不会进正文。
      CONTRACT_ITEMS.forEach((item, idx) => {
        item.mustInclude = [`__VORTEX_MUST_PROBE_${idx}__`];
      });
      const text = buildInstructions("4.1.0");
      CONTRACT_ITEMS.forEach((item, idx) => {
        expect(text, `${item.key} 的探针串没进正文 = 正文不是从契约插入的`).toContain(
          `__VORTEX_MUST_PROBE_${idx}__`,
        );
      });
      // 旧逐字串应随契约一起消失（例外：契约自己的 title 里就带着它，
      // title 同样来自 contract.ts，不算 instructions.ts 抄写）。
      CONTRACT_ITEMS.forEach((item, idx) => {
        const old = originals[idx][0];
        if (item.title.includes(old)) return;
        expect(
          text,
          `${item.key} 的旧逐字串「${old}」仍留在正文 = 正文抄了第二份`,
        ).not.toContain(old);
      });
    } finally {
      CONTRACT_ITEMS.forEach((item, idx) => {
        item.mustInclude = originals[idx];
      });
    }
  });
});
