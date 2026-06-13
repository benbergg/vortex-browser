// vortex_verify 工具的 caps 可见性测试（PART 2）。
// verify 是 cap:"testing" 的 internal 工具：默认不在 tools/list，
// setEnabledCaps(["testing"]) 后可见可调。

import { describe, it, expect, afterEach } from "vitest";
import {
  getToolDefs,
  getToolDef,
  getInternalToolDef,
  setEnabledCaps,
} from "../src/tools/registry.js";

describe("vortex_verify caps 可见性", () => {
  afterEach(() => setEnabledCaps([]));

  it("默认（无 caps）：vortex_verify 不在 tools/list", () => {
    setEnabledCaps([]);
    const names = getToolDefs().map((d) => d.name);
    expect(names).not.toContain("vortex_verify");
    expect(getToolDef("vortex_verify")).toBeUndefined();
    // internal map 仍可路由（dispatch / call 入口经 getToolDef，但 internal 直查可见）
    expect(getInternalToolDef("vortex_verify")).toBeDefined();
  });

  it("vortex_verify 标记 cap:'testing'", () => {
    expect(getInternalToolDef("vortex_verify")!.cap).toBe("testing");
  });

  it("setEnabledCaps(['testing']) 后 vortex_verify 可见可调", () => {
    setEnabledCaps(["testing"]);
    const names = getToolDefs().map((d) => d.name);
    expect(names).toContain("vortex_verify");
    const def = getToolDef("vortex_verify");
    expect(def).toBeDefined();
    expect(def!.action).toBe("verify.assert");
  });

  it("--caps=testing 时公开面 = 21（20 默认 + vortex_verify）", () => {
    setEnabledCaps(["testing"]);
    expect(getToolDefs().length).toBe(21);
  });

  it("verify schema 暴露 mode enum visible|value|text|list", () => {
    const def = getInternalToolDef("vortex_verify")!;
    const props = (def.schema as { properties: Record<string, any> }).properties;
    expect(props.mode.enum.sort()).toEqual(["list", "text", "value", "visible"]);
  });
});
