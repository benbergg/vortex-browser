import { describe, expect, it } from "vitest";
import { PUBLIC_TOOLS } from "../src/tools/schemas-public.js";
import { dispatchNewTool } from "../src/tools/dispatch.js";

describe("vortex_browser 工具定义", () => {
  it("出现在公开工具表里", () => {
    const tool = PUBLIC_TOOLS.find((t) => t.name === "vortex_browser");
    expect(tool).toBeDefined();
    expect(tool?.schema.properties).toHaveProperty("browser");
    expect(tool?.schema.required ?? []).toEqual([]);
  });

  it("描述里写明无参即列出清单", () => {
    const tool = PUBLIC_TOOLS.find((t) => t.name === "vortex_browser");
    expect(tool?.description.toLowerCase()).toContain("list");
  });
});

describe("vortex_browser 的 action 映射", () => {
  it("无参映射到 browser.list，带参映射到 browser.select", () => {
    expect(dispatchNewTool("vortex_browser", {})).toEqual({ action: "browser.list", params: {} });
    expect(dispatchNewTool("vortex_browser", { browser: "edge" }))
      .toEqual({ action: "browser.select", params: { browser: "edge" } });
  });

  // 空串/纯空白视同无参，否则会拿一个空 pref 去 select 然后必然报错
  it("空白参数按无参处理", () => {
    expect(dispatchNewTool("vortex_browser", { browser: "   " }))
      .toEqual({ action: "browser.list", params: {} });
  });
});
