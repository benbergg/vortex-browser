/**
 * Author: qingwa
 * Description: vortex_press 批量键入契约（text 整串一次送完）。
 *   终端类控件只认 keydown,逐键 N 次往返既贵又慢;text 参数把整串一次投递,
 *   页面收到的是一串受信任按键（keyDown/keyUp + text），不是一次 insertText。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KeyboardActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerKeyboardHandlers } from "../src/handlers/keyboard.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: KeyboardActions.PRESS, args, requestId: "r-press-text" } as NmRequest;
}

describe("vortex_press 批量键入", () => {
  let router: ActionRouter;
  let sendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: "textarea#helper" }]) },
    });
    router = new ActionRouter();
    sendCommand = vi.fn().mockResolvedValue(undefined);
    registerKeyboardHandlers(router, {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand,
    } as never);
  });

  const keyDowns = () =>
    sendCommand.mock.calls.filter(
      (c: unknown[]) =>
        c[1] === "Input.dispatchKeyEvent" && (c[2] as { type?: string })?.type === "keyDown",
    ) as unknown as [number, string, { key: string; code: string; text?: string }][];

  it("整串文本逐字符送成受信任按键，一次调用送完", async () => {
    const resp = await router.dispatch(mkReq({ text: "ls" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, typed: 2, path: "cdp-keys" });
    // 两个字符 = 两个 keyDown，各自带 text（页面收到的是真按键输入，不是 insertText）
    expect(keyDowns().map((c) => c[2].text)).toEqual(["l", "s"]);
    expect(keyDowns().map((c) => c[2].code)).toEqual(["KeyL", "KeyS"]);
    // 每次按键都有 keyUp 配对
    const keyUps = sendCommand.mock.calls.filter(
      (c: unknown[]) =>
        c[1] === "Input.dispatchKeyEvent" && (c[2] as { type?: string })?.type === "keyUp",
    );
    expect(keyUps).toHaveLength(2);
  });

  it("换行送成 Enter，制表送成 Tab", async () => {
    await router.dispatch(mkReq({ text: "a\nb\tc" }));
    const downs = keyDowns();
    expect(downs.map((c) => c[2].key)).toEqual(["a", "Enter", "b", "Tab", "c"]);
  });

  it("CRLF、CR、LF 各触发一次 Enter", async () => {
    await router.dispatch(mkReq({ text: "a\r\nb\rc\nd" }));
    expect(keyDowns().map(c => c[2].key)).toEqual(["a", "Enter", "b", "Enter", "c", "Enter", "d"]);
  });

  it("空格的 DOM key 是 ' '、物理码是 Space", async () => {
    await router.dispatch(mkReq({ text: " " }));
    const down = keyDowns()[0];
    expect(down[2].key).toBe(" ");
    expect(down[2].code).toBe("Space");
    expect(down[2].text).toBe(" ");
  });

  it("shift 变体符号送对应物理码（| 走 Backslash）", async () => {
    await router.dispatch(mkReq({ text: "|" }));
    const down = keyDowns()[0];
    expect(down[2].code).toBe("Backslash");
    expect(down[2].text).toBe("|");
  });

  it("标点的虚拟键码用真实 OEM 码，不撞 DOM 传统命名键（45=Insert / 46=Delete）", async () => {
    // ASCII 当 VK 用时 "-"→45、"."→46，正好是 DOM 传统 keyCode 的 Insert/Delete，
    // xterm.js 按 keyCode 判键会把这俩当命名键丢掉（真机实测：终端里 "ls -lt" 打成
    // "ls lt"）。字母/数字的 ASCII 恰好等于 VK，不受影响。
    await router.dispatch(mkReq({ text: "a-b.c" }));
    const vks = keyDowns().map(
      (c) => (c[2] as unknown as { windowsVirtualKeyCode?: number }).windowsVirtualKeyCode,
    );
    expect(vks).toEqual([65, 189, 66, 190, 67]);
  });

  it("key 与 text 同时给 → INVALID_PARAMS", async () => {
    const resp = await router.dispatch(mkReq({ key: "Enter", text: "ls" }));
    expect((resp.error as { code: string }).code).toBe("INVALID_PARAMS");
  });

  it("text 为空串也算批量键入（不落到 key 必填校验）", async () => {
    const resp = await router.dispatch(mkReq({ text: "" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, typed: 0, path: "cdp-keys" });
  });
});
