// packages/vortex-bench/tests/judge-prompt.test.ts
import { describe, it, expect } from "vitest";
import { renderObserveList, buildJudgePrompt } from "../src/runner/judge-prompt.js";
import type { ParsedObserve, ObserveRow } from "../src/scan-types.js";

const row = (over: Partial<ObserveRow>): ObserveRow => ({
  ref: "@e1", role: "button", name: "搜索", flags: [], bbox: [10, 20, 30, 40], frameId: 0, ...over,
});
const parsed = (rows: ObserveRow[]): ParsedObserve => ({
  header: { snapshotId: "s", url: "http://x", viewport: { width: 800, height: 600, scrollY: 0, scrollHeight: 600 } },
  rows, frameOffsets: {},
});

describe("renderObserveList", () => {
  it("渲染 role/name/bbox", () => {
    const out = renderObserveList(parsed([row({})]));
    expect(out).toContain('[button] "搜索" bbox=[10,20,30,40]');
  });
  it("离屏行(bbox=null)标注 off-screen", () => {
    const out = renderObserveList(parsed([row({ bbox: null })]));
    expect(out).toContain("(off-screen)");
  });
  it("跳过非主 frame 行(MVP 仅主 frame)", () => {
    const out = renderObserveList(parsed([row({ name: "child", frameId: 2 })]));
    expect(out).not.toContain("child");
  });
  it("name 为 null 渲染空引号", () => {
    const out = renderObserveList(parsed([row({ name: null })]));
    expect(out).toContain('[button] "" bbox=[10,20,30,40]');
  });
});

describe("buildJudgePrompt", () => {
  it("含指令关键句 + JSON 形态 + observe 列表", () => {
    const p = buildJudgePrompt(parsed([row({})]));
    expect(p).toContain('"misses"');
    expect(p).toContain("clearly visible");        // 只报清晰可见
    expect(p).toContain('[button] "搜索" bbox=[10,20,30,40]');
  });
});

// 2026-06-04 京东 live 评测:LLM 把非交互营销文字("组合购7折"slogan div,无 pointer/
// link/role)幻觉成可点 → 第二类假阳(bbox 兜底无法 catch,因 observe 本就正确排除)。
// prompt 加保守约束:营销文字无可点 affordance 不报。
import { buildJudgePrompt as _bjp } from "../src/runner/judge-prompt.js";
describe("judge prompt 保守性约束(2026-06-04 京东 FP-2)", () => {
  it("含'营销文字无 affordance 不报'规则", () => {
    const p = _bjp({ rows: [], header: {} as any } as any);
    expect(p).toContain("Decorative or marketing TEXT");
    expect(p.toLowerCase()).toContain("not a clickable element");
  });
});
