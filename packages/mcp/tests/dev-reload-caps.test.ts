// vortex_dev_reload 的 caps 可见性测试。
// dev_reload 是 cap:"dev" 的 internal 工具:默认不在 tools/list(绝不进 prod 用户面),
// setEnabledCaps(["dev"]) 后才可见可调。

import { describe, it, expect, afterEach } from "vitest";
import {
  getToolDefs,
  getToolDef,
  getInternalToolDef,
  setEnabledCaps,
} from "../src/tools/registry.js";

describe("vortex_dev_reload caps 可见性", () => {
  afterEach(() => setEnabledCaps([]));

  it("默认(无 caps):vortex_dev_reload 不在 tools/list", () => {
    setEnabledCaps([]);
    const names = getToolDefs().map((d) => d.name);
    expect(names).not.toContain("vortex_dev_reload");
    expect(getToolDef("vortex_dev_reload")).toBeUndefined();
    // internal map 仍可路由
    expect(getInternalToolDef("vortex_dev_reload")).toBeDefined();
  });

  it("vortex_dev_reload 标记 cap:'dev' + action __mcp_dev_reload__", () => {
    const def = getInternalToolDef("vortex_dev_reload")!;
    expect(def.cap).toBe("dev");
    expect(def.action).toBe("__mcp_dev_reload__");
  });

  it("setEnabledCaps(['dev']) 后 vortex_dev_reload 可见可调", () => {
    setEnabledCaps(["dev"]);
    const names = getToolDefs().map((d) => d.name);
    expect(names).toContain("vortex_dev_reload");
    expect(getToolDef("vortex_dev_reload")).toBeDefined();
  });

  it("启用 testing cap 不会顺带暴露 dev_reload(cap 隔离)", () => {
    setEnabledCaps(["testing"]);
    const names = getToolDefs().map((d) => d.name);
    expect(names).not.toContain("vortex_dev_reload");
  });
});
