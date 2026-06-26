import { describe, it, expect } from "vitest";
import { dispatchNewTool } from "../src/tools/dispatch.js";
import { getToolDefs } from "../src/tools/registry.js";

describe("vortex_paste 公开工具", () => {
  it("出现在 tools/list", () => {
    const def = getToolDefs().find((d) => d.name === "vortex_paste");
    expect(def).toBeDefined();
    expect(def!.description.length).toBeLessThanOrEqual(60);
  });
  it("schema 含 target + text(必填) + html(可选)", () => {
    const def = getToolDefs().find((d) => d.name === "vortex_paste")!;
    const props = (def.schema as any).properties;
    expect(props.target).toBeDefined();
    expect(props.text).toBeDefined();
    expect(props.html).toBeDefined();
    expect((def.schema as any).required).toEqual(expect.arrayContaining(["target", "text"]));
  });
  it("dispatch 路由到 dom.paste", () => {
    const result = dispatchNewTool("vortex_paste", { selector: "#ed", text: "# t" });
    expect(result?.action).toBe("dom.paste");
  });
});
