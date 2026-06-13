import { describe, it, expect } from "vitest";
import { computeAXOverlay, extractCompound, applyOverlay } from "../src/handlers/observe-ax-overlay.js";
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

describe("extractCompound", () => {
  it("combobox/listbox: 取前4 option 文本 + count", () => {
    const byNodeId = new Map<string, CDPAXNode>([
      ["sel", ax({ nodeId: "sel", role: { value: "combobox" }, childIds: ["lb"] })],
      ["lb", ax({ nodeId: "lb", role: { value: "listbox" }, childIds: ["o1","o2","o3","o4","o5"] })],
      ...["中国","美国","日本","英国","德国"].map((t, i) =>
        [`o${i+1}`, ax({ nodeId: `o${i+1}`, role: { value: "option" }, name: { value: t } })] as const),
    ]);
    const c = extractCompound(byNodeId.get("sel")!, byNodeId);
    expect(c?.role).toBe("listbox");
    expect(c?.count).toBe(5);
    expect(c?.options).toEqual(["中国","美国","日本","英国"]);
  });

  it("非复合控件返回 undefined", () => {
    const c = extractCompound(ax({ role: { value: "button" } }), new Map());
    expect(c).toBeUndefined();
  });
});

describe("applyOverlay 召回安全 + 回退", () => {
  it("AX map 为空:全部标 heuristic,role/name 不变,元素集大小恒定", () => {
    const els = [
      { role: "button", name: "保存" },
      { role: "div", name: "x", reactClickable: true as const },
    ];
    applyOverlay(els as any, new Map([[0, 100], [1, 200]]), new Map(), new Map());
    expect(els.length).toBe(2);             // 召回铁律:元素集大小不变
    expect(els[0].role).toBe("button");     // 漏命中保留启发式
    expect(els[1].role).toBe("div");
    expect((els[0] as any).nameSource).toBe("heuristic");
    expect((els[1] as any).nameSource).toBe("heuristic");
  });

  it("indexToBackend 失配(标记丢失):不抛,元素回退 heuristic", () => {
    const els = [{ role: "a", name: "" }];
    expect(() => applyOverlay(els as any, new Map(), new Map(), new Map())).not.toThrow();
    expect((els[0] as any).nameSource).toBe("heuristic");
    expect(els.length).toBe(1);
  });

  it("AX role=generic 不夺启发式交互 role(信召回);name 仍取 AX", () => {
    const els = [{ role: "button", name: "更多", reactClickable: true as const }];
    const byBackend = new Map<number, CDPAXNode>([
      [100, ax({ role: { value: "generic" }, name: { value: "更多按钮" } })],
    ]);
    applyOverlay(els as any, new Map([[0, 100]]), byBackend, new Map());
    expect(els[0].role).toBe("button");      // generic 不覆盖
    expect(els[0].name).toBe("更多按钮");     // name 仍取 AX
  });

  it("compound 经 applyOverlay 端到端写入 el.compound + 覆盖 role", () => {
    const byNodeId = new Map<string, CDPAXNode>([
      ["sel", ax({ nodeId: "sel", role: { value: "combobox" }, childIds: ["lb"] })],
      ["lb", ax({ nodeId: "lb", role: { value: "listbox" }, childIds: ["o1", "o2"] })],
      ["o1", ax({ nodeId: "o1", role: { value: "option" }, name: { value: "A" } })],
      ["o2", ax({ nodeId: "o2", role: { value: "option" }, name: { value: "B" } })],
    ]);
    const byBackend = new Map<number, CDPAXNode>([[100, byNodeId.get("sel")!]]);
    const els = [{ role: "div", name: "下拉" }];
    applyOverlay(els as any, new Map([[0, 100]]), byBackend, byNodeId);
    expect((els[0] as any).compound).toEqual({ role: "listbox", count: 2, options: ["A", "B"] });
    expect(els[0].role).toBe("combobox");
  });

  it("errorMessage 经 applyOverlay 写入(invalid 字段场景)", () => {
    const byBackend = new Map<number, CDPAXNode>([
      [100, ax({ role: { value: "textbox" }, name: { value: "邮箱" },
        properties: [
          { name: "invalid", value: { value: true } },
          { name: "errormessage", value: { relatedNodes: [{ text: "邮箱格式不正确" }] } },
        ] })],
    ]);
    const els = [{ role: "textbox", name: "邮箱" }];
    applyOverlay(els as any, new Map([[0, 100]]), byBackend, new Map());
    expect((els[0] as any).errorMessage).toBe("邮箱格式不正确");
    expect((els[0] as any).state?.invalid).toBe(true);
  });
});

describe("computeAXOverlay LabelText 不夺 role", () => {
  it("AX role=LabelText 不覆盖启发式 label(保留更清晰角色),name 仍取 AX", () => {
    const node = ax({ role: { value: "LabelText" }, name: { value: "好评" } });
    const r = computeAXOverlay({ backendId: 1, role: "label", name: "好评" }, node);
    expect(r.role).toBeUndefined(); // LabelText 不夺,启发式 label 保留
    expect(r.name).toBe("好评");
  });
});
