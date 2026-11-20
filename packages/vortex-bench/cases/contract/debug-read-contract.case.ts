// D-1（2026-11-20）：vortex_debug_read 的公开契约与运行时一致性（浏览器侧合同检查）。
//
// 本 case 只锁 **MCP 层**能保证的那一半：
//   ① filter 传字符串 → 报「filter 形状错」，不再报 "pattern is required"
//      （此前 Object.assign 静默丢弃字符串 filter，随后报 pattern 缺失 ——
//        把形状错误报成字段缺失，agent 按错方向重试）
//   ② 错误文本带 Hint 段
//
// 为什么只锁这一半：D-1b（source=request + 不存在的 reqid → REQUEST_NOT_FOUND）
// 的判定发生在**扩展层**（packages/extension/src/handlers/network.ts），
// 由扩展单测 packages/extension/tests/network-request-detail.test.ts 锁；
// bench 跑的是浏览器里**已安装**的扩展产物，版本落后时会红，但那时红的是
// 「扩展没更新」而不是「代码有缺陷」—— 那种红会掩盖真回归，故不放进 bench。
//
// 依赖：无（不需要打开任何站点）。

import type { CaseDefinition } from "../../src/types.js";
import { extractText } from "../_helpers.js";

const def: CaseDefinition = {
  name: "contract/debug-read-contract",
  suite: "b",
  async run(ctx) {
    // ① filter 形状错
    const bad = extractText(
      await ctx.call("vortex_debug_read", {
        source: "network",
        filter: "example",
      }),
    );
    ctx.assert(
      /Error \[INVALID_PARAMS\]/.test(bad),
      `字符串 filter 应报 INVALID_PARAMS，实际: ${bad.slice(0, 300)}`,
    );
    ctx.assert(
      /filter must be an object/i.test(bad),
      `错误应指向 filter 形状，实际: ${bad.slice(0, 300)}`,
    );
    ctx.assert(
      !/pattern is required/i.test(bad),
      `不应再把 filter 形状错报成 pattern 缺失，实际: ${bad.slice(0, 300)}`,
    );

    // ② 错误文本带 Hint 段（agent 要知道下一步做什么）
    ctx.assert(
      /^Hint:/m.test(bad),
      `错误文本应带 Hint 段，实际: ${bad.slice(0, 300)}`,
    );

    // ③ 反向：形状正确的 filter 不能再被当成形状错（不回归）
    const ok = extractText(
      await ctx.call("vortex_debug_read", {
        source: "network",
        filter: { pattern: "vortex-bench-no-such-marker" },
      }),
    );
    ctx.assert(
      !/filter must be an object/i.test(ok),
      `对象 filter 不应被判形状错，实际: ${ok.slice(0, 300)}`,
    );
    ctx.assert(
      !/pattern is required/i.test(ok),
      `filter.pattern 已给，不应报 pattern 缺失，实际: ${ok.slice(0, 300)}`,
    );
  },
};

export default def;
