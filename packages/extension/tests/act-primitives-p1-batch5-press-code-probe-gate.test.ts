import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ActionRouter } from "../src/lib/router.js";
import {
  registerKeyboardHandlers,
  keyToCode,
} from "../src/handlers/keyboard.js";

/**
 * 回归锁:act 原语白盒审计批次 5 —— 族 G(PRESS CDP 物理码表)+ 族 H(探测/门一致性)。
 *
 * 族 G:CDP Input.dispatchKeyEvent 的 `code` 字段要 KeyboardEvent.code 物理码
 *   (字母 "KeyA"、数字 "Digit1"、修饰键 "MetaLeft"),旧实现 `code: key` 直传 DOM key
 *   值导致依赖 event.code 的站(快捷键库常用)收不到正确物理码(#16/#17);未知多字符
 *   键名(Insert/PrintScreen)旧 fallback `key.charCodeAt(0)` 取首字符得错 VK 码(#36)。
 * 族 H:cdp.ts useRealMouse 探测用 light-DOM querySelectorAll + document.elementFromPoint,
 *   与门(actionability/dom.ts queryAllDeep + deepElementFromPoint)不一致,open-shadow ref
 *   假阴 ELEMENT_NOT_FOUND(#14);探测只判 .disabled 漏 aria-disabled,与门 isEnabled 不一致
 *   (#26/#29)。统一到 __vortexDomResolve.isEnabled(镜像门)。
 * 2026-06-03 act 原语白盒审计。
 */

// ===== 族 G:keyToCode 物理码映射(纯函数真单测) =====
describe("#16/#17 keyToCode — DOM key → KeyboardEvent.code 物理码", () => {
  it("小写字母 → KeyX(大写)", () => {
    expect(keyToCode("a")).toBe("KeyA");
    expect(keyToCode("z")).toBe("KeyZ");
  });
  it("大写字母 → KeyX(物理码与大小写无关)", () => {
    expect(keyToCode("A")).toBe("KeyA");
    expect(keyToCode("S")).toBe("KeyS");
  });
  it("数字 → DigitX", () => {
    expect(keyToCode("0")).toBe("Digit0");
    expect(keyToCode("9")).toBe("Digit9");
  });
  it("修饰键 → 默认左侧物理码", () => {
    expect(keyToCode("Meta")).toBe("MetaLeft");
    expect(keyToCode("Control")).toBe("ControlLeft");
    expect(keyToCode("Ctrl")).toBe("ControlLeft");
    expect(keyToCode("Shift")).toBe("ShiftLeft");
    expect(keyToCode("Alt")).toBe("AltLeft");
  });
  it("命名键 key===code 原样返回", () => {
    expect(keyToCode("Enter")).toBe("Enter");
    expect(keyToCode("Tab")).toBe("Tab");
    expect(keyToCode("Escape")).toBe("Escape");
    expect(keyToCode("ArrowUp")).toBe("ArrowUp");
    expect(keyToCode("F5")).toBe("F5");
    expect(keyToCode("Insert")).toBe("Insert");
    expect(keyToCode("Space")).toBe("Space");
  });
});

// ===== 族 G:PRESS 派发的 code/VK 字段(真 router dispatch) =====
describe("#16/#17/#36 PRESS handler — code/windowsVirtualKeyCode 物理码", () => {
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
    vi.stubGlobal("chrome", { tabs: { query: vi.fn().mockResolvedValue([]) } });
    registerKeyboardHandlers(router, debuggerMgr);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function press(key: string) {
    await router.dispatch({
      type: "tool_request",
      tool: "keyboard.press",
      args: { key },
      requestId: "r",
      tabId: 42,
    });
    return sendCommand.mock.calls;
  }

  it("字母键 'a' 派发 code:KeyA + VK:65(而非旧 code:'a')", async () => {
    const calls = await press("a");
    expect(calls[0][2]).toMatchObject({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
    });
  });

  it("数字键 '1' 派发 code:Digit1 + VK:49", async () => {
    const calls = await press("1");
    expect(calls[0][2]).toMatchObject({ key: "1", code: "Digit1", windowsVirtualKeyCode: 49 });
  });

  it("Meta+a:修饰键 code:MetaLeft,主键 code:KeyA", async () => {
    const calls = await press("Meta+a");
    // Meta down → KeyA down → KeyA up → Meta up
    expect(calls[0][2]).toMatchObject({ type: "keyDown", key: "Meta", code: "MetaLeft" });
    expect(calls[1][2]).toMatchObject({ type: "keyDown", key: "a", code: "KeyA" });
  });

  it("命名键 Enter 仍 code:Enter(key===code 不退化)", async () => {
    const calls = await press("Enter");
    expect(calls[0][2]).toMatchObject({ code: "Enter", windowsVirtualKeyCode: 13 });
  });

  it("#36 多字符键名 Insert:VK 用表(45)而非 charCodeAt('I')=73", async () => {
    const calls = await press("Insert");
    expect(calls[0][2]).toMatchObject({ code: "Insert", windowsVirtualKeyCode: 45 });
  });
});

// ===== 族 H:source-grep 守护(page-side func 字面量不可 import) =====
const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_SRC = readFileSync(join(__dirname, "../src/adapter/cdp.ts"), "utf8");
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");
const RESOLVE_SRC = readFileSync(
  join(__dirname, "../src/page-side/dom-resolve.ts"),
  "utf8",
);
const SHADOW_SRC = readFileSync(
  join(__dirname, "../src/page-side/shadow-walk.ts"),
  "utf8",
);
const ACTIONABILITY_SRC = readFileSync(
  join(__dirname, "../src/page-side/actionability.ts"),
  "utf8",
);

describe("#26/#29 isEnabled 单一真源 — 门与探测共用 shadow-walk.isEnabledElement", () => {
  it("shadow-walk 导出 isEnabledElement,逻辑含 aria-disabled + .disabled + fieldset[disabled]", () => {
    expect(SHADOW_SRC).toMatch(/export function isEnabledElement/);
    expect(SHADOW_SRC).toMatch(/aria-disabled/);
    expect(SHADOW_SRC).toMatch(/fieldset\[disabled\]/);
  });
  it("__vortexDomResolve.isEnabled 委托 isEnabledElement(不再各持一份)", () => {
    expect(RESOLVE_SRC).toMatch(/isEnabled:.*isEnabledElement\(el\)/);
  });
  it("门 actionability.isEnabled 也委托同一 isEnabledElement(防漂移)", () => {
    expect(ACTIONABILITY_SRC).toMatch(/return isEnabledElement\(el\)/);
  });
});

describe("#14 cdp.ts useRealMouse 探测对齐门(穿 shadow + deep hit-test + isEnabled)", () => {
  it("主路径用 __vortexDomResolve.queryAllDeep 而非旧裸 light-DOM querySelectorAll", () => {
    expect(CDP_SRC).toMatch(/resolve\.queryAllDeep\(sel\)/);
    // 旧主路径 `const els = document.querySelectorAll(sel)` 已移除(仅 resolve 未就绪时
    // 在三元 fallback 里出现,不再是主路径)。
    expect(CDP_SRC).not.toMatch(/const els = document\.querySelectorAll\(sel\)/);
  });
  it("occlusion 用 deepElementFromPoint 穿 shadow", () => {
    expect(CDP_SRC).toMatch(/deepElementFromPoint/);
  });
  it("disabled 判定走 __vortexDomResolve.isEnabled(含 aria-disabled)", () => {
    expect(CDP_SRC).toMatch(/isEnabled/);
  });
});

describe("#14 CLICK handler useRealMouse 前预加载 dom-resolve(保证全局就绪)", () => {
  it("cdpClickElement 调用前 loadPageSideModule dom-resolve", () => {
    // useRealMouse 分支:先加载 dom-resolve 再调 cdpClickElement
    expect(DOM_SRC).toMatch(
      /loadPageSideModule\([^)]*"dom-resolve"\)[\s\S]{0,200}cdpClickElement/,
    );
  });
});

describe("#26 CLICK/TYPE/FILL inline 探测统一 isEnabled(aria-disabled 一致)", () => {
  it("CLICK/TYPE/FILL 探测不再裸判 (el ...).disabled === true,改 isEnabled", () => {
    // 旧三处 `(el as HTMLInputElement).disabled === true` 已被 isEnabled 取代
    const bareDisabledProbes = DOM_SRC.match(
      /if \(\(el as HTMLInputElement\)\.disabled === true\)/g,
    );
    // 仅 SELECT/HOVER 等族 H 范围外路径可保留;CLICK/TYPE/FILL 三处须改完
    expect(DOM_SRC).toMatch(/__vortexDomResolve\.isEnabled\(el\)/);
    // 至少 3 处探测改用 isEnabled
    const isEnabledProbes = DOM_SRC.match(/__vortexDomResolve\.isEnabled\(el\)/g) ?? [];
    expect(isEnabledProbes.length).toBeGreaterThanOrEqual(3);
  });
});
