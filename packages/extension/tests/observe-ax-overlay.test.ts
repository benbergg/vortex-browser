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

  // B1 回归(2026-06-14 reactflow.dev dogfood):CDP checked 是 tristate 字符串
  // "true"/"false"/"mixed"。旧判据 `checked != null && checked !== false` 对字符串
  // "false" 漏判(字符串 ≠ 布尔 false)→ state.checked = "false"(truthy)→ 渲染层
  // `else if (state.checked)` 误发 [checked]。Radix/Ant/MUI 风格 role=radio/checkbox
  // 的未选中项全中招,agent 误以为全选中。原生 input 走 page-side .checked IDL 不受影响。
  it("AX checked=false(tristate 字符串)不标 checked (B1)", () => {
    const node = ax({
      role: { value: "radio" },
      name: { value: "pyramid" },
      properties: [{ name: "checked", value: { value: "false" } }],
    });
    const r = computeAXOverlay({ backendId: 20, role: "radio", name: "pyramid" }, node);
    expect(r.state?.checked).toBeUndefined();
  });

  it("AX checked=true(tristate 字符串)标 checked=true (B1 正向不回归)", () => {
    const node = ax({
      role: { value: "radio" },
      name: { value: "cube" },
      properties: [{ name: "checked", value: { value: "true" } }],
    });
    const r = computeAXOverlay({ backendId: 21, role: "radio", name: "cube" }, node);
    expect(r.state?.checked).toBe(true);
  });

  it("AX checked=true(布尔)仍标 checked=true (兼容布尔形态)", () => {
    const node = ax({
      role: { value: "checkbox" },
      name: { value: "opt" },
      properties: [{ name: "checked", value: { value: true } }],
    });
    const r = computeAXOverlay({ backendId: 22, role: "checkbox", name: "opt" }, node);
    expect(r.state?.checked).toBe(true);
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

  // 2026-06-23 prosemirror.net dogfood:AX node.value.value 对 contentEditable/textarea
  // 给「全文」(508 字符富文本文档),applyOverlay 无截断覆盖 page-side getValueInfo 已
  // slice(0,200) 的 valueNow → observe 渲染全文,长文档(Notion/工单)token 爆炸 + \n\n
  // 破坏单行输出。AX overlay valueNow 须对齐 page-side 纪律:归一化空白 + 截断 200。
  it("长 value 截断到 200(防长 contentEditable/textarea token 爆炸)", () => {
    const node = ax({ role: { value: "textbox" }, value: { value: "A".repeat(500) } });
    const r = computeAXOverlay({ backendId: 30, role: "textbox", name: "" }, node);
    expect(r.valueNow!.length).toBe(200);
  });

  it("value 含换行/制表归一化为单空格(防破坏单行渲染)", () => {
    const node = ax({ role: { value: "textbox" }, value: { value: "Hello\n\nWorld\ttab" } });
    const r = computeAXOverlay({ backendId: 31, role: "textbox", name: "" }, node);
    expect(r.valueNow).toBe("Hello World tab");
  });

  it("短 valuetext 不受截断/归一化影响(slider 50% 保持)", () => {
    const node = ax({
      role: { value: "slider" },
      properties: [{ name: "valuetext", value: { value: "50%" } }],
    });
    const r = computeAXOverlay({ backendId: 32, role: "slider", name: "" }, node);
    expect(r.valueNow).toBe("50%");
  });

  // CDP UTF-8 双重编码还原(2026-06-23 react-aria DatePicker dogfood):
  // Chrome Accessibility.getFullAXTree 把 value/valuetext 的 UTF-8 字节当 Latin-1 逐字节
  // 映射返回(name 不受影响)。例:DOM aria-valuetext="6 – June"(含 U+2013 en-dash)→
  // CDP 返回 "6 â June" → observe 渲染 mojibake。computeAXOverlay 须还原。
  // mojibake() 复刻 Chrome 的双重编码:UTF-8 编码后每字节当一个 Latin-1 码位。
  const mojibake = (s: string): string =>
    String.fromCharCode(...new TextEncoder().encode(s));

  it("valuetext mojibake(en-dash)还原为原 UTF-8(react-aria spinbutton)", () => {
    const node = ax({
      role: { value: "spinbutton" },
      properties: [{ name: "valuetext", value: { value: mojibake("6 – June") } }],
    });
    const r = computeAXOverlay({ backendId: 40, role: "spinbutton", name: "month" }, node);
    expect(r.valueNow).toBe("6 – June");
  });

  it("valuetext mojibake(CJK+en-dash)还原(slider 弱 – Weak)", () => {
    const node = ax({
      role: { value: "slider" },
      properties: [{ name: "valuetext", value: { value: mojibake("弱 – Weak") } }],
    });
    const r = computeAXOverlay({ backendId: 41, role: "slider", name: "Vol" }, node);
    expect(r.valueNow).toBe("弱 – Weak");
  });

  it("node.value.value mojibake 也还原(value 路径,非 valuetext)", () => {
    const node = ax({ role: { value: "textbox" }, value: { value: mojibake("café — 中文") } });
    const r = computeAXOverlay({ backendId: 42, role: "textbox", name: "" }, node);
    expect(r.valueNow).toBe("café — 中文");
  });

  it("纯 ASCII valuetext 原样返回(无误伤)", () => {
    const node = ax({
      role: { value: "slider" },
      properties: [{ name: "valuetext", value: { value: "6 - June" } }],
    });
    const r = computeAXOverlay({ backendId: 43, role: "slider", name: "" }, node);
    expect(r.valueNow).toBe("6 - June");
  });

  // 真多字节字符(码位 > 0xFF)说明 CDP 这次没有双重编码(或测试桩传入正常 UTF-16),
  // 不应被当 mojibake 再解码——护栏 ① 须原样返回,防把正常中文当字节流二次解码成乱码。
  it("已正常的 UTF-16 valuetext(含真 CJK)不被二次还原(护栏①)", () => {
    const node = ax({
      role: { value: "slider" },
      properties: [{ name: "valuetext", value: { value: "中文 50%" } }],
    });
    const r = computeAXOverlay({ backendId: 44, role: "slider", name: "" }, node);
    expect(r.valueNow).toBe("中文 50%");
  });

  // 合法 Latin-1 文本(孤立高位字节,非合法 UTF-8 序列)fatal 解码失败 → 原样保留(护栏②)。
  it("合法 Latin-1 文本(孤立 0xE9)非 UTF-8 序列时原样保留(护栏②)", () => {
    const node = ax({
      role: { value: "slider" },
      // "café" 直接作为已是 UTF-16 的合法字符串:0xE9 孤立,非完整 UTF-8 多字节序列
      properties: [{ name: "valuetext", value: { value: "café" } }],
    });
    const r = computeAXOverlay({ backendId: 45, role: "slider", name: "" }, node);
    expect(r.valueNow).toBe("café");
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
