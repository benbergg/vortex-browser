// bench CLI 的套件过滤纯逻辑：--suite a|b|all 的解析、显式 case 名的提取、
// 按 def.suite 的过滤、以及报告里 suite 字段的写入。
//
// 这些函数原先内联在 CLI 入口（src/index.ts）里，只有"真跑一遍 bench"才能验证 ——
// bench 测试目录里 grep 不到 parseSuite / --suite 的任何直接断言。搬到这里是为了
// 让过滤分支能被单测直接覆盖。
//
// 搬动只做"抽成纯函数 + 导出"，逻辑与搬动前逐字一致，CLI 行为不变。

import type { CaseMetrics } from "../types.js";

/** bench 支持的套件：a = 组件能力基线（依赖 playground），b = 自包含失败路径用例（依赖 fixture）。 */
export type SuiteFilter = "a" | "b" | "all";

/** 单个 case 的套件归属（缺省视为 "a"）。 */
export type SuiteKey = "a" | "b";

/**
 * Parse `--suite a|b|all` or `--suite=<v>` from argv.
 * Returns null on invalid input (caller surfaces the user-facing error),
 * defaults to "all" when the flag is absent（既有行为不变）。
 */
export function parseSuite(args: string[]): SuiteFilter | null {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--suite") {
      raw = args[i + 1];
      break;
    }
    if (a.startsWith("--suite=")) {
      raw = a.slice("--suite=".length);
      break;
    }
  }
  if (raw === undefined) return "all";
  const v = raw.trim().toLowerCase();
  if (v === "a" || v === "b" || v === "all") return v;
  return null;
}

/**
 * `--flag <value>` / `--flag=<value>` 占用的 argv 下标（**含 value 本身**）。
 * 用来把 `--suite b` 的 "b" 从"显式 case 名"里剔掉（--repeats 的 N 同理）。
 */
export function flagValueIndexes(args: string[], flag: string): Set<number> {
  const used = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      used.add(i);
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) used.add(i + 1);
      break;
    }
    if (a.startsWith(`${flag}=`)) {
      used.add(i);
      break;
    }
  }
  return used;
}

/**
 * 显式 case 名：argv 里不以 "-" 开头、不是纯数字、且不是 flag 的"值"的项。
 * `--suite b` 的 "b" 与 `--repeats 3` 的 "3" 都不算 case 名。
 */
export function parseExplicitCaseNames(args: string[]): string[] {
  const consumed = new Set<number>([
    ...flagValueIndexes(args, "--repeats"),
    ...flagValueIndexes(args, "--suite"),
  ]);
  return args.filter((a, i) => !a.startsWith("-") && !/^\d+$/.test(a) && !consumed.has(i));
}

/**
 * 候选 case 名：显式 case 名优先；没给名字时 --all / --suite a|b = 跑整套该套件。
 * 全量名单由调用方注入（CLI 传 listCaseNames；单测传假的）。
 */
export async function pickCandidateNames(
  args: string[],
  opts: { runAll: boolean; suite: SuiteFilter },
  listAllNames: () => Promise<string[]>,
): Promise<string[]> {
  const explicitNames = parseExplicitCaseNames(args);
  if (explicitNames.length > 0) return explicitNames;
  if (opts.runAll || opts.suite !== "all") return await listAllNames();
  return [];
}

/**
 * 套件过滤：读 case 模块的 def.suite（**不靠文件名约定**），缺省视为 "a"。
 */
export function filterBySuite<T extends { suite?: SuiteKey }>(
  defs: T[],
  suite: SuiteFilter,
): T[] {
  return defs.filter((def) => suite === "all" || (def.suite ?? "a") === suite);
}

/**
 * 报告里的 suite 字段：aggregate() 只搬数值字段（tier/suite 这类透传字段会丢）——
 * 但**只为 suite B 补回**：suite A 的序列化必须与加这个字段之前逐字节一致。
 */
export function tagSuiteMetric(m: CaseMetrics, suiteKey: SuiteKey): CaseMetrics {
  if (suiteKey === "b") m.suite = "b";
  return m;
}
