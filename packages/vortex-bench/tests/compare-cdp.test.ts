/**
 * Author: qingwa
 * Description: spike(cdp-first 阶段0) — compare-cdp 双模式对比的归类/汇总纯函数。
 *
 * 决策矩阵的核心输入是「baseline 过而 CDP-first 挂」(cdp-regression) 与
 * 「baseline 挂而 CDP-first 裸过」(cdp-fixes) 两个名单,归类逻辑必须可单测。
 */
import { describe, it, expect } from "vitest";
import {
  summarizeCdpCompare,
  renderCdpCompareTable,
  CDP_FIRST_OVERRIDES,
  SYNTHETIC_BASELINE_OVERRIDES,
} from "../src/compare-cdp.js";
import type { CaseMetrics } from "../src/types.js";

function mk(name: string, passed: boolean, durationMs = 100): CaseMetrics {
  return {
    case: name,
    passed,
    callCount: 1,
    fallbackToEvaluate: 0,
    observeMissedPopperItems: 0,
    durationMs,
    outputBytes: 0,
  };
}

describe("summarizeCdpCompare 归类", () => {
  it("四象限归类:both-pass / cdp-regression / cdp-fixes / both-fail", () => {
    const before = [mk("a", true), mk("b", true), mk("c", false), mk("d", false)];
    const after = [mk("a", true), mk("b", false), mk("c", true), mk("d", false)];
    const s = summarizeCdpCompare(before, after);
    expect(s.total).toBe(4);
    expect(s.bothPass).toBe(1);
    expect(s.cdpRegressions).toEqual(["b"]);
    expect(s.cdpFixes).toEqual(["c"]);
    expect(s.bothFail).toEqual(["d"]);
  });

  it("按 case 名匹配(顺序无关),两侧延迟都进 row", () => {
    const before = [mk("x", true, 50), mk("y", true, 80)];
    const after = [mk("y", true, 200), mk("x", true, 60)];
    const s = summarizeCdpCompare(before, after);
    const rowX = s.rows.find((r) => r.case === "x")!;
    expect(rowX.baselineMs).toBe(50);
    expect(rowX.cdpMs).toBe(60);
    expect(rowX.verdict).toBe("both-pass");
  });

  it("单侧缺失的 case 不进 rows(防御 runPass 异常中断)", () => {
    const s = summarizeCdpCompare([mk("a", true), mk("b", true)], [mk("a", true)]);
    expect(s.total).toBe(1);
    expect(s.rows.map((r) => r.case)).toEqual(["a"]);
  });
});

describe("renderCdpCompareTable", () => {
  it("regression/fixes 名单可读地出现在表格里", () => {
    const s = summarizeCdpCompare(
      [mk("good", true), mk("fixed-by-cdp", false)],
      [mk("good", false), mk("fixed-by-cdp", true)],
    );
    const text = renderCdpCompareTable(s);
    expect(text).toContain("good");
    expect(text).toContain("fixed-by-cdp");
    expect(text).toMatch(/cdp-regression/i);
    expect(text).toMatch(/cdp-fixes/i);
  });
});

describe("CDP_FIRST_OVERRIDES 实验旋钮", () => {
  it("click 走 useRealMouse,fill/type 走 cdpFill/cdpType(act 与独立 fill 工具都覆盖)", () => {
    expect(CDP_FIRST_OVERRIDES.vortex_act).toMatchObject({
      useRealMouse: true,
      cdpFill: true,
      cdpType: true,
    });
    expect(CDP_FIRST_OVERRIDES.vortex_fill).toMatchObject({ cdpFill: true });
  });

  it("pass A 基线注入 forceSynthetic(trusted Chrome 上还原非 trusted 合成默认)", () => {
    expect(SYNTHETIC_BASELINE_OVERRIDES.vortex_act).toMatchObject({ forceSynthetic: true });
    // 基线不得携带任何 CDP 旋钮
    expect(SYNTHETIC_BASELINE_OVERRIDES.vortex_act).not.toHaveProperty("useRealMouse");
    expect(SYNTHETIC_BASELINE_OVERRIDES.vortex_act).not.toHaveProperty("cdpFill");
  });
});
