import { describe, it, expect } from "vitest";
import { dispatchNewTool } from "../src/tools/dispatch.js";

describe("vortex_act onDialog/promptText 透传", () => {
  it("options.onDialog=accept → params.onDialog='accept'", () => {
    const { params } = dispatchNewTool("vortex_act", {
      action: "click",
      target: "@e1",
      options: { onDialog: "accept" },
    })!;
    expect(params.onDialog).toBe("accept");
  });

  it("options.onDialog=dismiss → params.onDialog='dismiss'", () => {
    const { params } = dispatchNewTool("vortex_act", {
      action: "click",
      target: "@e1",
      options: { onDialog: "dismiss" },
    })!;
    expect(params.onDialog).toBe("dismiss");
  });

  it("options.promptText 透传到 params.promptText", () => {
    const { params } = dispatchNewTool("vortex_act", {
      action: "click",
      target: "@e1",
      options: { onDialog: "accept", promptText: "hi" },
    })!;
    expect(params.onDialog).toBe("accept");
    expect(params.promptText).toBe("hi");
  });

  it("不传 onDialog 时 params 不含 onDialog", () => {
    const { params } = dispatchNewTool("vortex_act", {
      action: "click",
      target: "@e1",
      options: { timeout: 5000 },
    })!;
    expect(params).not.toHaveProperty("onDialog");
  });

  it("不传 options 时 params 不含 onDialog / promptText", () => {
    const { params } = dispatchNewTool("vortex_act", {
      action: "click",
      target: "@e1",
    })!;
    expect(params).not.toHaveProperty("onDialog");
    expect(params).not.toHaveProperty("promptText");
  });
});
