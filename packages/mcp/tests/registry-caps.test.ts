// registry caps 机制测试（PART 1）。
// caps opt-in：cap 标记的 internal 工具，仅当其 cap ∈ enabledCaps 时
// 才被 getToolDefs/getToolDef 提升进 public 面。
// 默认 enabledCaps 为空 → 行为与现状完全一致（不回归）。
//
// 本文件用 schemas 内真实存在的 cap 标记工具（如 vortex_verify cap:'testing'）
// 验证提升语义。若某 cap 在当前 schemas 中无对应工具，setEnabledCaps 应为 no-op。

import { describe, it, expect, afterEach } from "vitest";
import {
  getToolDefs,
  getToolDef,
  getInternalToolDef,
  setEnabledCaps,
} from "../src/tools/registry.js";
import { getAllToolDefs } from "../src/tools/schemas.js";

describe("registry caps opt-in 机制", () => {
  afterEach(() => {
    // 每个用例后清空模块级 caps 状态，避免污染其它测试文件（默认面 = 20）。
    setEnabledCaps([]);
  });

  it("默认（无 caps）：getToolDefs 返回 20 个公开工具，且不含任何 cap 标记工具", () => {
    setEnabledCaps([]);
    const defs = getToolDefs();
    expect(defs.length).toBe(20);
    expect(defs.every((d) => d.cap === undefined)).toBe(true);
  });

  it("启用某 cap 后，该 cap 标记的 internal 工具全部进 public", () => {
    // 从 schemas 收集所有 cap 标记工具，按 cap 分组验证提升语义。
    const capped = getAllToolDefs().filter((d) => d.cap);
    if (capped.length === 0) {
      // 当前 schemas 无 cap 工具：setEnabledCaps 必须是安全 no-op。
      setEnabledCaps(["testing"]);
      expect(getToolDefs().length).toBe(20);
      return;
    }
    const cap = capped[0].cap!;
    const expectedNames = capped.filter((d) => d.cap === cap).map((d) => d.name);
    setEnabledCaps([cap]);
    const names = getToolDefs().map((d) => d.name);
    for (const n of expectedNames) {
      expect(names).toContain(n);
    }
    // 公开面 = 20 + 被提升的工具数
    expect(getToolDefs().length).toBe(20 + expectedNames.length);
  });

  it("启用 cap 后 getToolDef 可按名解析被提升的工具", () => {
    const capped = getAllToolDefs().filter((d) => d.cap);
    if (capped.length === 0) return;
    const cap = capped[0].cap!;
    setEnabledCaps([cap]);
    const def = getToolDef(capped[0].name);
    expect(def).toBeDefined();
    expect(def!.cap).toBe(cap);
  });

  it("未启用 cap 时，cap 工具不在 public 面（仍可经 getInternalToolDef 取到）", () => {
    const capped = getAllToolDefs().filter((d) => d.cap);
    if (capped.length === 0) return;
    setEnabledCaps([]);
    expect(getToolDef(capped[0].name)).toBeUndefined();
    expect(getInternalToolDef(capped[0].name)).toBeDefined();
  });

  it("未知 cap 被忽略，不影响默认面（仍 20）", () => {
    setEnabledCaps(["nonexistent-cap-xyz"]);
    const defs = getToolDefs();
    expect(defs.length).toBe(20);
  });

  it("setEnabledCaps([]) 可回到默认面（幂等清空）", () => {
    const capped = getAllToolDefs().filter((d) => d.cap);
    if (capped.length === 0) return;
    setEnabledCaps([capped[0].cap!]);
    expect(getToolDefs().length).toBeGreaterThan(20);
    setEnabledCaps([]);
    expect(getToolDefs().length).toBe(20);
  });
});
