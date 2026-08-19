// 防漂移：shared 的 PUBLIC_TOOL_NAMES 必须与 schemas-public.ts 实际暴露的工具集完全相等。
//
// 没有这条锁，白名单会像 I20 那样烂掉：它手抄的 11 个工具冻结在 v0.6，而公开面早已
// 24 个，于是一个本该保证 hint 诚实的不变量反过来把正确的 hint 判红（2026-08-19）。
import { describe, it, expect } from "vitest";
import { PUBLIC_TOOL_NAMES } from "@vortex-browser/shared";
import { PUBLIC_TOOLS } from "../src/tools/schemas-public.js";

const actual = PUBLIC_TOOLS.map((t) => t.name).sort();
const declared = [...PUBLIC_TOOL_NAMES].sort();

describe("PUBLIC_TOOL_NAMES 与 schemas-public 不漂移", () => {
  it("两侧集合完全相等（多一个少一个都红）", () => {
    expect(declared).toEqual(actual);
  });

  it("扫描面非空（防两侧同时塌成空集的假绿）", () => {
    expect(actual.length).toBeGreaterThanOrEqual(20);
    expect(new Set(actual).size).toBe(actual.length);
  });
});
