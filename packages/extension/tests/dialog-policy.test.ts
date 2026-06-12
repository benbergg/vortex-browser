import { describe, it, expect } from "vitest";

// 复刻 content-main.ts override 的纯逻辑(executeScript/content-script 注入丢作用域,
// 用受控 window stub 复刻,对齐 vortex_page_side_func_inline_gotcha)。

interface DialogPolicy {
  armed: boolean; until: number; answer: "accept" | "dismiss";
  promptText: string | null; captured: Array<{ type: string; message: string }>;
}

function makeWindow(policy?: DialogPolicy) {
  const calls: string[] = [];
  const w: any = {
    __vortexDialogPolicy: policy,
    alert: (m: string) => calls.push("orig-alert:" + m),
    confirm: (m: string) => { calls.push("orig-confirm:" + m); return true; },
    prompt: (m: string, d?: string) => { calls.push("orig-prompt:" + m); return d ?? "ORIG"; },
    postMessage: () => {},
    __calls: calls,
  };
  return w;
}

function installOverride(w: any) {
  const POLICY_KEY = "__vortexDialogPolicy";
  function activePolicy(): DialogPolicy | null {
    const p = w[POLICY_KEY];
    if (p && (p.armed || Date.now() < p.until)) return p;
    return null;
  }
  const origAlert = w.alert, origConfirm = w.confirm, origPrompt = w.prompt;
  w.alert = (msg?: unknown) => {
    const text = String(msg ?? ""); const p = activePolicy();
    if (p) { p.captured.push({ type: "alert", message: text }); return; }
    return origAlert.call(w, msg);
  };
  w.confirm = (msg?: unknown) => {
    const text = String(msg ?? ""); const p = activePolicy();
    if (p) { p.captured.push({ type: "confirm", message: text }); return p.answer === "accept"; }
    return origConfirm.call(w, msg);
  };
  w.prompt = (msg?: unknown, def?: unknown) => {
    const text = String(msg ?? ""); const p = activePolicy();
    if (p) {
      p.captured.push({ type: "prompt", message: text });
      if (p.answer !== "accept") return null;
      return p.promptText != null ? p.promptText : def != null ? String(def) : "";
    }
    return origPrompt.call(w, msg, def);
  };
}

describe("dialog override policy decision", () => {
  it("空闲(无 policy):透传原生 confirm,不抑制", () => {
    const w = makeWindow(undefined); installOverride(w);
    expect(w.confirm("delete?")).toBe(true);
    expect(w.__calls).toContain("orig-confirm:delete?");
  });

  it("armed + dismiss:抑制 confirm 返 false,不调原生,记录 captured", () => {
    const policy: DialogPolicy = { armed: true, until: 0, answer: "dismiss", promptText: null, captured: [] };
    const w = makeWindow(policy); installOverride(w);
    expect(w.confirm("submit?")).toBe(false);
    expect(w.__calls).not.toContain("orig-confirm:submit?");
    expect(policy.captured).toEqual([{ type: "confirm", message: "submit?" }]);
  });

  it("armed + accept:confirm 返 true", () => {
    const policy: DialogPolicy = { armed: true, until: 0, answer: "accept", promptText: null, captured: [] };
    const w = makeWindow(policy); installOverride(w);
    expect(w.confirm("ok?")).toBe(true);
  });

  it("armed + accept + promptText:prompt 返 promptText;无 promptText 回退默认值", () => {
    const p1: DialogPolicy = { armed: true, until: 0, answer: "accept", promptText: "hello", captured: [] };
    const w1 = makeWindow(p1); installOverride(w1);
    expect(w1.prompt("name?", "DEF")).toBe("hello");
    const p2: DialogPolicy = { armed: true, until: 0, answer: "accept", promptText: null, captured: [] };
    const w2 = makeWindow(p2); installOverride(w2);
    expect(w2.prompt("name?", "DEF")).toBe("DEF");
  });

  it("armed + dismiss:prompt 返 null", () => {
    const policy: DialogPolicy = { armed: true, until: 0, answer: "dismiss", promptText: null, captured: [] };
    const w = makeWindow(policy); installOverride(w);
    expect(w.prompt("name?", "DEF")).toBeNull();
  });

  it("grace 窗内(armed=false,until 未到):仍抑制", () => {
    const policy: DialogPolicy = { armed: false, until: Date.now() + 5000, answer: "dismiss", promptText: null, captured: [] };
    const w = makeWindow(policy); installOverride(w);
    expect(w.confirm("late?")).toBe(false);
    expect(w.__calls).not.toContain("orig-confirm:late?");
  });

  it("grace 窗外(armed=false,until 已过):透传原生", () => {
    const policy: DialogPolicy = { armed: false, until: Date.now() - 1, answer: "dismiss", promptText: null, captured: [] };
    const w = makeWindow(policy); installOverride(w);
    expect(w.confirm("expired?")).toBe(true);
    expect(w.__calls).toContain("orig-confirm:expired?");
  });

  it("alert 被抑制时不调原生且记录", () => {
    const policy: DialogPolicy = { armed: true, until: 0, answer: "dismiss", promptText: null, captured: [] };
    const w = makeWindow(policy); installOverride(w);
    w.alert("hi");
    expect(w.__calls).not.toContain("orig-alert:hi");
    expect(policy.captured).toEqual([{ type: "alert", message: "hi" }]);
  });
});
