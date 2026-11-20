import { describe, it, expect } from "vitest";
import { getAllToolDefs } from "../src/tools/schemas.js";
import { getToolDefs, resolveToolDef } from "../src/tools/registry.js";
import { computeSchemaHash } from "../src/tools/schema-fingerprint.js";

/**
 * 直接约束**生产实现**的指纹算法（tools/schema-fingerprint.ts）。
 *
 * D-1(2026-11-20)：旧实现只哈希 name:action:description.length，公开 schema
 * 改了参数（加字段/改类型）而 description 长度没变时指纹不变 → 缓存方无感。
 * 这里 import 生产函数（不是自己复刻一份），生产改了算法本测试就会红。
 */
describe("MCP ping version fingerprint (@since 0.4.0)", () => {
  it("schemaHash is a 12-char lowercase hex string", () => {
    const h = computeSchemaHash(getToolDefs());
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  it("schemaHash changes when tool descriptions drift (length sensitive)", () => {
    const defs = getToolDefs();
    const h1 = computeSchemaHash(defs);
    // 长度变了就要变 hash（模拟 description 更新后的指纹漂移）
    const mutated = defs.map((d, i) =>
      i === 0 ? { ...d, description: d.description + " X" } : d,
    );
    expect(computeSchemaHash(mutated)).not.toBe(h1);
  });

  it("schemaHash changes when a tool's schema shape drifts (same description)", () => {
    // D-1: 公开 schema 加参数/改类型时 description 长度可能不变 → 旧指纹无感。
    const defs = getToolDefs();
    const h1 = computeSchemaHash(defs);
    const mutated = defs.map((d, i) => {
      if (i !== 0) return d;
      const schema = (d.schema ?? {}) as Record<string, unknown>;
      return {
        ...d,
        schema: {
          ...schema,
          properties: {
            ...((schema.properties ?? {}) as Record<string, unknown>),
            __driftProbe: { type: "string" },
          },
        },
      };
    });
    expect(computeSchemaHash(mutated)).not.toBe(h1);
  });

  it("includes diagnostics tool and core v0.5 tools in toolset", () => {
    const names = getAllToolDefs().map((d) => d.name);
    expect(names).toContain("vortex_ping");
    expect(names).toContain("vortex_fill");
    expect(names).toContain("vortex_wait_idle");
    expect(names).toContain("vortex_navigate");
    expect(names).toContain("vortex_batch");
  });

  it("vortex_ping description advertises version fingerprint", () => {
    const ping = getAllToolDefs().find((d) => d.name === "vortex_ping");
    expect(ping?.description).toMatch(/mcpVersion/);
    expect(ping?.description).toMatch(/extensionVersion/);
    expect(ping?.description).toMatch(/schemaHash/);
    expect(ping?.description).toMatch(/toolCount/);
  });

  it("vortex_ping 可被 tools/call 解析（指纹链路不再断在第一步）", () => {
    // D-1：v0.6 把 ping 移出 PUBLIC_TOOLS 时没留可达路径（无 cap），
    // 于是没有任何客户端能拿到 schemaHash —— 指纹机制整条链路是死的。
    expect(resolveToolDef("vortex_ping")?.action).toBe("__mcp_ping__");
  });

  it("vortex_ping 不在 tools/list（公开面不因它增长）", () => {
    expect(getToolDefs().map((d) => d.name)).not.toContain("vortex_ping");
  });

  it("其它 internal 工具仍不可被 tools/call 解析（只给 ping 开一条路）", () => {
    expect(resolveToolDef("vortex_verify")).toBeUndefined();
    expect(resolveToolDef("vortex_dev_reload")).toBeUndefined();
    expect(resolveToolDef("vortex_not_a_tool")).toBeUndefined();
  });

  it("vortex_mouse_click description mentions frameId for iframe support", () => {
    const mc = getAllToolDefs().find((d) => d.name === "vortex_mouse_click");
    expect(mc?.description).toMatch(/frameId/);
    expect(mc?.description).toMatch(/iframe/);
  });

  it("vortex_observe description mentions iframe support", () => {
    const ob = getAllToolDefs().find((d) => d.name === "vortex_observe");
    expect(ob?.description).toMatch(/iframe/);
    expect(ob?.description).toMatch(/frames/);
  });
});
