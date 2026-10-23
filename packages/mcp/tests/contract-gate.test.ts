import { describe, expect, it } from "vitest";
import {
  CONTRACT_ITEMS,
  INSTRUCTIONS_TOKEN_BUDGET,
  SENTINEL_PREFIX,
  SENTINEL_SUFFIX,
  estimateTokens,
} from "../src/contract.js";
import { PUBLIC_TOOL_NAMES } from "@vortex-browser/shared";
import { getToolDefs } from "../src/tools/registry.js";

describe("契约护栏", () => {
  it("契约清单覆盖设计稿的 10 条要点", () => {
    expect(CONTRACT_ITEMS.map((i) => i.key)).toEqual([
      "workflow",
      "ref-lifecycle",
      "fill-value-shape",
      "query-mode-boundary",
      "wait-for-modes",
      "screenshot-target",
      "extract-truncation",
      "debug-read-params",
      "effect-signals",
      "path-case",
    ]);
  });

  it("每条契约都带至少一条逐字必须串", () => {
    for (const item of CONTRACT_ITEMS) {
      expect(item.mustInclude.length, item.key).toBeGreaterThan(0);
      for (const s of item.mustInclude) expect(s.length).toBeGreaterThan(0);
    }
  });

  it("体积预算常量是 1200 tokens", () => {
    expect(INSTRUCTIONS_TOKEN_BUDGET).toBe(1200);
  });

  it("哨兵常量成对", () => {
    expect(SENTINEL_PREFIX).toContain("vortex:instructions");
    expect(SENTINEL_SUFFIX).toContain("end");
  });

  it("估算函数对中英文分别计费", () => {
    expect(estimateTokens("中文字")).toBe(3);
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("公开工具名未被改动（冻结契约）", () => {
    expect(PUBLIC_TOOL_NAMES.size).toBe(24);
  });

  it("契约要点里的逐字串在工具 description 中仍然存在", () => {
    const defs = getToolDefs();
    const byName = new Map(defs.map((d) => [d.name, d]));
    const pairs: Array<[string, string]> = [
      ["vortex_fill", "{start,end}"],
      ["vortex_query", "Lake Sheet"],
      ["vortex_extract", "[VORTEX_TRUNCATED]"],
      ["vortex_debug_read", "statusMin"],
    ];
    for (const [tool, needle] of pairs) {
      const def = byName.get(tool);
      expect(def, tool).toBeDefined();
      const text = JSON.stringify(def!.schema) + " " + def!.description;
      expect(text, `${tool} 缺少契约串 ${needle}`).toContain(needle);
    }
  });
});
