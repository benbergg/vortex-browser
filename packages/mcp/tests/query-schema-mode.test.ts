/**
 * Author: qingwa
 * Description: vortex_query 公开 schema 对 mode=schema 的契约测试。
 */

import { describe, it, expect } from "vitest";
import { PUBLIC_TOOLS } from "../src/tools/schemas-public.js";

describe("vortex_query 公开 schema 含 mode=schema", () => {
  const query = PUBLIC_TOOLS.find((t) => t.name === "vortex_query")!;
  const mode = (query.schema as any).properties.mode;

  it("mode enum 含 schema", () => {
    expect(mode.enum).toContain("schema");
  });

  it("description 点明是页面作者声明、可能与可见内容不一致", () => {
    expect(mode.description).toMatch(/author|声明/);
  });
});
