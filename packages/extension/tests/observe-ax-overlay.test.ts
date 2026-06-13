import { describe, it, expect } from "vitest";
import { computeAXOverlay } from "../src/handlers/observe-ax-overlay.js";
import type { CDPAXNode } from "../src/reasoning/types.js";

const ax = (o: Partial<CDPAXNode>): CDPAXNode => ({ nodeId: "x", ...o });

describe("computeAXOverlay", () => {
  it("AX 命中:覆盖 role/name,state checked=mixed,标 nameSource", () => {
    const node = ax({
      role: { value: "checkbox" },
      name: { value: "全选", sources: [{ type: "attribute", attribute: "aria-label" }] },
      properties: [{ name: "checked", value: { value: "mixed" } }],
    });
    const r = computeAXOverlay({ backendId: 10, role: "div", name: "" }, node);
    expect(r.role).toBe("checkbox");
    expect(r.name).toBe("全选");
    expect(r.nameSource).toBe("aria-label");
    expect(r.state?.checked).toBe("mixed");
  });

  it("AX role=generic 不夺启发式交互 role(信召回)", () => {
    const node = ax({ role: { value: "generic" }, name: { value: "更多" } });
    const r = computeAXOverlay({ backendId: 11, role: "button", name: "更多" }, node);
    expect(r.role).toBeUndefined(); // 不覆盖 role
    expect(r.name).toBe("更多");    // name 仍可取
  });

  it("nameSource=placeholder 兜底名标弱名来源", () => {
    const node = ax({
      role: { value: "textbox" },
      name: { value: "请输入", sources: [{ type: "placeholder" }] },
    });
    const r = computeAXOverlay({ backendId: 12, role: "textbox", name: "请输入" }, node);
    expect(r.nameSource).toBe("placeholder");
  });

  it("valuetext 优先于 value", () => {
    const node = ax({
      role: { value: "slider" }, value: { value: "0.5" },
      properties: [{ name: "valuetext", value: { value: "50%" } }],
    });
    const r = computeAXOverlay({ backendId: 13, role: "slider", name: "" }, node);
    expect(r.valueNow).toBe("50%");
  });
});
