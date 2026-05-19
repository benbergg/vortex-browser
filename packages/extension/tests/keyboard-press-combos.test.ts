import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import {
  registerKeyboardHandlers,
  parseKeyExpression,
} from "../src/handlers/keyboard.js";

/**
 * vortex_press combo parsing & dispatch contract.
 *
 * The public schema's description has always promised that
 * `vortex_press({ key: "Ctrl+S" })` works — but until the combo-aware
 * PRESS path landed, the handler dispatched a literal "Ctrl+S" key
 * with modifiers=0, which the browser interpreted as a typed 'C' (no
 * modifier flag set). These tests pin the parser AND the CDP dispatch
 * sequence so the description and the implementation stay aligned.
 */
describe("keyboard parseKeyExpression", () => {
  it("single key has zero modifiers", () => {
    expect(parseKeyExpression("Enter")).toEqual({
      key: "Enter",
      modifiers: 0,
      modifierKeys: [],
    });
  });

  it("Ctrl+S parses to Ctrl modifier + S key", () => {
    const r = parseKeyExpression("Ctrl+S");
    expect(r.key).toBe("S");
    expect(r.modifierKeys).toEqual(["Ctrl"]);
    // CDP modifiers flag for Ctrl is 2 per MODIFIERS map.
    expect(r.modifiers).toBe(2);
  });

  it("Shift+Ctrl+ArrowDown combines two modifiers", () => {
    const r = parseKeyExpression("Shift+Ctrl+ArrowDown");
    expect(r.key).toBe("ArrowDown");
    expect(r.modifierKeys).toEqual(["Shift", "Ctrl"]);
    // Shift=8 | Ctrl=2 → 10
    expect(r.modifiers).toBe(10);
  });

  it("Meta+a uses lowercase main key as-is", () => {
    const r = parseKeyExpression("Meta+a");
    expect(r.key).toBe("a");
    expect(r.modifierKeys).toEqual(["Meta"]);
    expect(r.modifiers).toBe(4);
  });

  it("tolerates whitespace around plus signs", () => {
    expect(parseKeyExpression(" Ctrl + S ")).toEqual({
      key: "S",
      modifiers: 2,
      modifierKeys: ["Ctrl"],
    });
  });

  it("unknown modifier throws INVALID_PARAMS", () => {
    expect(() => parseKeyExpression("Hyper+S")).toThrow(/Unknown modifier "Hyper"/);
  });

  it("empty expression throws", () => {
    expect(() => parseKeyExpression("")).toThrow(/empty/);
    expect(() => parseKeyExpression("+")).toThrow(/empty/);
  });
});

describe("keyboard PRESS handler dispatch sequence", () => {
  let router: ActionRouter;
  let sendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = new ActionRouter();
    sendCommand = vi.fn().mockResolvedValue(undefined);

    const debuggerMgr = {
      onEvent: vi.fn(),
      enableDomain: vi.fn().mockResolvedValue(undefined),
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand,
    } as unknown as Parameters<typeof registerKeyboardHandlers>[1];

    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([]),
      },
    });

    registerKeyboardHandlers(router, debuggerMgr);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("single key (Enter) dispatches one keyDown + one keyUp with modifiers=0", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "keyboard.press",
      args: { key: "Enter" },
      requestId: "r-enter",
      tabId: 42,
    });
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand).toHaveBeenNthCalledWith(
      1,
      42,
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyDown", key: "Enter", modifiers: 0 }),
    );
    expect(sendCommand).toHaveBeenNthCalledWith(
      2,
      42,
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyUp", key: "Enter", modifiers: 0 }),
    );
  });

  it("Ctrl+S sends 4 events: Ctrl down → S down → S up → Ctrl up", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "keyboard.press",
      args: { key: "Ctrl+S" },
      requestId: "r-ctrl-s",
      tabId: 42,
    });
    expect(sendCommand).toHaveBeenCalledTimes(4);
    const calls = sendCommand.mock.calls;
    // [tabId, "Input.dispatchKeyEvent", payload]
    expect(calls[0][2]).toMatchObject({ type: "keyDown", key: "Ctrl", modifiers: 2 });
    expect(calls[1][2]).toMatchObject({ type: "keyDown", key: "S", modifiers: 2 });
    expect(calls[2][2]).toMatchObject({ type: "keyUp", key: "S", modifiers: 2 });
    expect(calls[3][2]).toMatchObject({ type: "keyUp", key: "Ctrl", modifiers: 0 });
  });

  it("Shift+Ctrl+ArrowDown holds both modifiers across the main keypress", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "keyboard.press",
      args: { key: "Shift+Ctrl+ArrowDown" },
      requestId: "r-multi",
      tabId: 42,
    });
    // 2 modifiers down + 2 (main key down/up) + 2 modifiers up = 6
    expect(sendCommand).toHaveBeenCalledTimes(6);
    const calls = sendCommand.mock.calls;
    // 1st modifier (Shift, flag=8) pressed alone → modifiers=8
    expect(calls[0][2]).toMatchObject({ type: "keyDown", key: "Shift", modifiers: 8 });
    // 2nd modifier (Ctrl, flag=2) added → modifiers=10
    expect(calls[1][2]).toMatchObject({ type: "keyDown", key: "Ctrl", modifiers: 10 });
    // Main key dispatched with both modifiers in effect
    expect(calls[2][2]).toMatchObject({ type: "keyDown", key: "ArrowDown", modifiers: 10 });
    expect(calls[3][2]).toMatchObject({ type: "keyUp", key: "ArrowDown", modifiers: 10 });
    // Modifiers released in reverse: Ctrl first → leaves Shift=8 active
    expect(calls[4][2]).toMatchObject({ type: "keyUp", key: "Ctrl", modifiers: 8 });
    expect(calls[5][2]).toMatchObject({ type: "keyUp", key: "Shift", modifiers: 0 });
  });

  it("unknown modifier returns INVALID_PARAMS error response (not throw)", async () => {
    const resp = await router.dispatch({
      type: "tool_request",
      tool: "keyboard.press",
      args: { key: "Hyper+S" },
      requestId: "r-bad",
      tabId: 42,
    });
    expect(resp.error?.code).toBe("INVALID_PARAMS");
    expect(resp.error?.message).toMatch(/Unknown modifier "Hyper"/);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
