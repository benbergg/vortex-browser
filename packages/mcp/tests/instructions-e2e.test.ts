// instructions 端到端护栏：server 下发的正文必须首尾哨兵完整、带版本，
// 且 10 条契约的逐字串一条不缺、体积不超预算。
//
// 方向不可反：本测试从 contract.ts 取真值（单一真值），instructions.ts 也从
// contract.ts 取真值渲染正文——同源才不会出现"两边各说各话"。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildInstructions, renderDetail } from "../src/instructions.js";
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

  // —— ref 契约统一（评审 Important 2）——
  //
  // 契约统一为："旧 ref 不得静默命中错误元素；新 observe 后须重新取得 ref"。
  // 运行时对旧 hashed ref 的行为是**明确拒绝**（STALE_SNAPSHOT，见
  // packages/mcp/src/lib/ref-parser.ts 的 hash mismatch 分支），不是缺陷。
  // instructions 之前写的是"跨快照身份稳定"，与运行时相反 ⇒ 必须改口径。

  it("ref 契约要求重新 observe 后重新取 ref，不再承诺跨快照命中", () => {
    const text = buildInstructions("4.1.0");
    expect(text, "正文应写明重新 observe 后重新取得 ref").toContain("重新 observe 后请重新取得 ref");
    expect(text, "正文应写明旧 hashed ref 会被明确拒绝").toContain("旧 hashed ref 会被明确拒绝");
    expect(text, "正文应写明不会静默指向别的元素").toContain("不会静默指向别的元素");
    expect(text, "旧的跨快照稳定性承诺必须消失").not.toContain("跨快照身份稳定");
  });

  // —— 完整限制语句护栏（评审 Important 3）——
  //
  // 只断言关键词是不够的：渲染器在缺整条 DETAILS 时会兜底把 mustInclude
  // 补回正文，于是"删掉限制说明只留关键词"照样绿。
  // ⇒ 这里对**整句限制说明**（含解释部分）逐条断言，并额外验证：
  // 兜底渲染（等于删掉这条散文说明）拿不到整句 ⇒ 护栏会红。

  /**
   * 10 条契约要点的完整限制语句（硬编码 = 刻意的重复 = 锁）。
   *
   * 句子按渲染后的形态书写（`{{must}}` 已被替换成该条契约的逐字串）。
   */
  const REQUIRED_LIMIT_SENTENCES: Array<{ key: string; sentence: string }> = [
    {
      key: "workflow",
      sentence:
        "先用 vortex_observe 看清当前页面与可点元素，再动手操作；拿到的 ref 失效就重新再看，别凭空编 ref。",
    },
    {
      key: "ref-lifecycle",
      sentence:
        "带 hash 的 ref（形如 @<hash>:eN）也不跨快照复用：重新 observe 后请重新取得 ref；旧 hashed ref 会被明确拒绝（STALE_SNAPSHOT），不会静默指向别的元素。裸 ref 只绑定当前快照且已废弃。",
    },
    {
      key: "fill-value-shape",
      sentence:
        "值形状随控件变：普通输入框给字符串，日期区间控件需 {start,end}，级联选择器需逐级路径数组。填错时按错误信息里给出的正确形状重填。",
    },
    {
      key: "query-mode-boundary",
      sentence:
        "sheet 模式只认 Lake Sheet，不认普通 DOM table（普通表格改用 vortex_extract）；component 模式返回 Vue 实例/props，selector 仍是 CSS。",
    },
    {
      key: "wait-for-modes",
      sentence:
        "各 mode 含义不同：element 等元素出现（value 是 CSS 选择器）；idle 等空闲（value=network|xhr|dom）；mode=info 返回页面信息概览（默认含全部标签页）；custom 轮询 JS 表达式直到为真。",
    },
    {
      key: "screenshot-target",
      sentence: "target 可传 observe 给的 @ref，也可传 CSS selector；省略或传 null 表示整页截图。",
    },
    {
      key: "extract-truncation",
      sentence: "超长会截断并带 [VORTEX_TRUNCATED] 标记；要全文就缩小范围或分段取，别把截断当完整内容。",
    },
    {
      key: "debug-read-params",
      sentence:
        "filter 是平铺键，不要按 source 再嵌一层：console 用 level，network 用 pattern 必填，并用 statusMin 与 statusMax 过滤 HTTP 状态码区间；tail=N 取最近 N 条。",
    },
    {
      key: "effect-signals",
      sentence:
        "act 返回的信号（urlChanged、domMutations、networkRequests 等）只是观察到的证据；全阴性只说明没观察到阳性信号，不等于操作一定没生效。",
    },
    {
      key: "path-case",
      sentence:
        "hash 路由大小写敏感（/#/el-cascader 与其大小写变体不是同一条）；页面打得开不等于应用内路由存在，可能落到空状态页。",
    },
  ];

  it("每条契约的完整限制语句都在正文里（只留关键词不算数）", () => {
    const text = buildInstructions("4.1.0");
    for (const { key, sentence } of REQUIRED_LIMIT_SENTENCES) {
      expect(text, `key=${key} 缺少完整限制语句：「${sentence}」`).toContain(sentence);
    }
  });

  it("删掉整条散文说明时完整限制语句会消失（兜底只补关键词 ⇒ 上面那条护栏会红）", () => {
    for (const { key, sentence } of REQUIRED_LIMIT_SENTENCES) {
      const item = CONTRACT_ITEMS.find((i) => i.key === key);
      expect(item, `契约清单缺 key=${key}`).toBeDefined();
      // template=null ＝ 模拟"这条契约没有写散文说明"，渲染器退化成只输出逐字串。
      const fallback = renderDetail(item!, null);
      expect(
        fallback,
        `key=${key} 的兜底渲染不应包含完整限制语句（否则删掉说明护栏不会红）`,
      ).not.toContain(sentence);
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
