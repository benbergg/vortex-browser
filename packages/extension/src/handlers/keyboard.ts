import { KeyboardActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";

// DOM key → windowsVirtualKeyCode 映射
const KEY_CODES: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  Control: 17, Shift: 16, Alt: 18, Meta: 91,
  // 不可打印命名键——补全 VK 码,堵 charCodeAt(0) 对多字符名取首字符的错码(#36)。
  Insert: 45, CapsLock: 20, NumLock: 144, ScrollLock: 145,
  Pause: 19, PrintScreen: 44, ContextMenu: 93,
  // 字母 A-Z
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [String.fromCharCode(65 + i), 65 + i]),
  ),
  // 小写字母 a-z 映射到相同 keyCode
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [String.fromCharCode(97 + i), 65 + i]),
  ),
  // 数字 0-9
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [String(i), 48 + i]),
  ),
  // 功能键 F1-F12
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i]),
  ),
};

// 修饰键名 → 物理码默认左侧变体(CDP code 字段语义)。
const MODIFIER_CODES: Record<string, string> = {
  Control: "ControlLeft", Ctrl: "ControlLeft",
  Shift: "ShiftLeft", Alt: "AltLeft", Meta: "MetaLeft",
};

// 标点/符号 key → KeyboardEvent.code 物理码。CDP code 字段要合法物理码,标点裸字符
// (".")不是合法 code,依赖 event.code 的快捷键库收不到 → 误判(2026-06-04 审计)。
const PUNCT_CODES: Record<string, string> = {
  ".": "Period", ",": "Comma", "/": "Slash", ";": "Semicolon",
  "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  "-": "Minus", "=": "Equal", "`": "Backquote",
};

// 修饰键别名 → 规范 DOM key 名(2026-06-04 审计)。LLM/Mac/Win 用户惯写 Cmd/Command/
// Win/Option 等,旧逻辑只认 Alt/Control/Ctrl/Meta/Shift → throw。归一到规范名,使
// 下游 key/code/vk 正确(既有 Ctrl/Control/Alt/Meta/Shift 不在此表,保留原名不破坏契约)。
const MODIFIER_CANON: Record<string, string> = {
  Cmd: "Meta", Command: "Meta", Win: "Meta", Windows: "Meta", Super: "Meta",
  Option: "Alt", Opt: "Alt",
};

/**
 * DOM key 值 → KeyboardEvent.code 物理码。
 *
 * CDP Input.dispatchKeyEvent 的 `code` 字段要的是物理码(布局无关),不是 key 值:
 * 字母 "a"/"A" → "KeyA"、数字 "1" → "Digit1"、修饰键 "Meta" → "MetaLeft"。
 * 旧实现 `code: key` 直传 key 值,依赖 `event.code` 的站(快捷键库常见)收不到正确
 * 物理码 → 误判/平台错(#16/#17)。命名键(Enter/Tab/ArrowUp/F1/Insert/Space)的
 * key 与 code 同名,原样返回。
 *
 * Exported for unit tests; production callers go through dispatchKey below.
 */
export function keyToCode(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return "Key" + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return "Digit" + key;
  return MODIFIER_CODES[key] ?? PUNCT_CODES[key] ?? key;
}

/** DOM key → windowsVirtualKeyCode。单字符按大写 ASCII 取值,多字符未知名取 0(不再错码)。 */
function keyToVk(key: string): number {
  return KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
}

// 修饰键名 → CDP modifiers 标志位(含常见别名 Cmd/Command/Win/Super→Meta、Option→Alt)。
const MODIFIERS: Record<string, number> = {
  Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8,
  Cmd: 4, Command: 4, Win: 4, Windows: 4, Super: 4, Option: 1, Opt: 1,
};

// 当前浏览器宿主是否 macOS。macOS 的编辑类键盘快捷键(Cmd+A 全选等)经 OS 的
// NSResponder 键绑定层解析成编辑命令,而合成的 CDP Input.dispatchKeyEvent **绕过 OS**
// → 命令不会自动触发(Cmd+A 返回 success 却不全选,2026-06-23 Quill dogfood R15 实证)。
// 须随 keyDown 显式传 `commands` 字段(对齐 Playwright macEditingCommands 做法)。
const IS_MAC: boolean = (() => {
  try {
    const uad = (navigator as unknown as { userAgentData?: { platform?: string } })
      .userAgentData;
    if (uad?.platform) return uad.platform === "macOS";
    return /Mac/i.test(navigator.platform || navigator.userAgent || "");
  } catch {
    return false;
  }
})();

/**
 * macOS 下某 (物理码, 修饰键) 组合对应的编辑命令(CDP `commands` 字段值)。非 macOS 或
 * 非编辑快捷键返回 undefined。仅处理纯 Meta(Cmd)且不叠加 Ctrl/Alt/Shift 的编辑快捷键,
 * 避免误触别的命令。当前仅 Cmd+A→selectAll(R15 实证的静默失败点);此表是后续 mac 编辑
 * 命令(copy/cut/paste/undo 等)的扩展点,新增时须各自实测命令名正确再加。
 *
 * isMac 显式入参(而非直接读 IS_MAC)便于单测;生产调用方传 IS_MAC。
 */
export function editingCommandsForKey(
  code: string,
  modifiers: number,
  isMac: boolean,
): string[] | undefined {
  if (!isMac) return undefined;
  const alt = (modifiers & 1) !== 0;
  const ctrl = (modifiers & 2) !== 0;
  const meta = (modifiers & 4) !== 0;
  const shift = (modifiers & 8) !== 0;
  if (!meta || ctrl || alt || shift) return undefined;
  if (code === "KeyA") return ["selectAll"];
  return undefined;
}

async function getActiveTabId(tabId?: number): Promise<number> {
  if (tabId) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw vtxError(VtxErrorCode.TAB_NOT_FOUND, "No active tab found");
  return tab.id;
}

/**
 * 读主 frame 当前聚焦元素的简短描述。PRESS 是全局 fire-and-forget——按键投递到
 * document.activeElement,而非某个指定 target。焦点不在预期元素时(如 observe 后焦点
 * 仍在 body)按键落空但 handler 仍返回 success,是 silent false-success。回传焦点上下文,
 * 让 agent 知道按键去了哪、不被盲目 success 误导(2026-06-03 act 原语白盒审计族 A,#15)。
 * 读失败(无注入权限等)返回空串,不影响 PRESS 本身。
 */
async function probeFocus(tabId: number): Promise<string> {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const a = document.activeElement;
        if (!a || a === document.body || a === document.documentElement) {
          return "body (no element focused — key may have no effect)";
        }
        const tag = a.tagName.toLowerCase();
        const id = a.id ? "#" + a.id : "";
        const role = a.getAttribute("role");
        const name =
          a.getAttribute("aria-label") ||
          a.getAttribute("name") ||
          a.getAttribute("placeholder") ||
          "";
        return (
          tag + id + (role ? `[role=${role}]` : "") + (name ? ` "${name.slice(0, 40)}"` : "")
        );
      },
    });
    return (res[0]?.result as string | undefined) ?? "";
  } catch {
    return "";
  }
}

/**
 * Parse a key expression like "Enter" / "Ctrl+S" / "Shift+Ctrl+ArrowDown".
 *
 * - parts.length === 1: single key, no modifiers
 * - parts.length > 1: every segment except the last must be a known
 *   modifier name (Alt / Ctrl / Control / Meta / Shift); the last
 *   segment is the main key
 *
 * Exported for unit tests; production callers go through `PRESS` /
 * `SHORTCUT` handlers below.
 */
export function parseKeyExpression(
  expr: string,
): { key: string; modifiers: number; modifierKeys: string[] } {
  const parts = expr
    .split("+")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw vtxError(VtxErrorCode.INVALID_PARAMS, `key expression is empty: "${expr}"`);
  }
  if (parts.length === 1) {
    return { key: parts[0], modifiers: 0, modifierKeys: [] };
  }
  const modifierKeys: string[] = [];
  let modifiers = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i];
    if (!(m in MODIFIERS)) {
      throw vtxError(
        VtxErrorCode.INVALID_PARAMS,
        `Unknown modifier "${m}" in key expression "${expr}". Known: ${Object.keys(MODIFIERS).join(", ")}`,
      );
    }
    // 归一别名到规范 DOM key 名(Cmd→Meta 等),使下游 key/code/vk 正确;
    // 既有规范名(Ctrl/Control/Alt/Meta/Shift)不在 CANON 表,保留原样不破坏契约。
    modifierKeys.push(MODIFIER_CANON[m] ?? m);
    modifiers |= MODIFIERS[m];
  }
  return { key: parts[parts.length - 1], modifiers, modifierKeys };
}

async function dispatchKey(
  debuggerMgr: DebuggerManager,
  tabId: number,
  key: string,
  modifiers: number,
): Promise<void> {
  const vk = keyToVk(key);
  const physicalCode = keyToCode(key);

  // 可打印单字符 + 无修饰键:keyDown 带 text/unmodifiedText,让 Chrome 执行默认
  // "插入字符"动作。缺 text 时 keydown/keyup 事件照发(JS 监听可见)但浏览器不插
  // 字符 → press('a') 返回 success 却 input.value 不变(silent false success)。
  // 对齐 Playwright keyboard.press 对可打印键插字符的行为。命令组合键(Ctrl/Alt/
  // Meta,modifiers≠0)是命令不是文本,不插;非可打印键(Enter/Tab/Arrow,key 多字符)
  // 也不插。Shift-only 等带修饰键的大小写场景仍走 type/fill。(2026-06-13 EP dogfood A3)
  const isPrintable = modifiers === 0 && [...key].length === 1;

  // macOS 编辑快捷键(Cmd+A 等)须随 keyDown 显式传 commands,否则合成事件不触发编辑命令
  // (见 IS_MAC / editingCommandsForKey 注释)。非 macOS / 非编辑快捷键时为 undefined,不附字段。
  const commands = editingCommandsForKey(physicalCode, modifiers, IS_MAC);

  await debuggerMgr.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code: physicalCode,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
    ...(isPrintable ? { text: key, unmodifiedText: key } : {}),
    ...(commands ? { commands } : {}),
  });

  await debuggerMgr.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: physicalCode,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
}

export function registerKeyboardHandlers(
  router: ActionRouter,
  debuggerMgr: DebuggerManager,
): void {
  router.registerAll({
    [KeyboardActions.PRESS]: async (args, tabId) => {
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const expr = args.key as string;
      if (!expr) throw vtxError(VtxErrorCode.INVALID_PARAMS, "key is required");

      const { key, modifiers, modifierKeys } = parseKeyExpression(expr);

      await debuggerMgr.attach(tid);
      // 投递前读焦点——按键将作用于此元素(回传给 agent,避免盲目 success,#15)。
      const focusedElement = await probeFocus(tid);

      // Plain single-key path stays byte-identical to v0.8 behavior.
      if (modifierKeys.length === 0) {
        await dispatchKey(debuggerMgr, tid, key, 0);
        return { success: true, key: expr, focusedElement };
      }

      // Combo path: hold modifiers across main-key dispatch, then
      // release in reverse — same shape SHORTCUT uses, just collapsed
      // into the PRESS path so the public surface honors its own
      // description ("Press key or shortcut, e.g. 'Enter', 'Ctrl+S'").
      let pressed = 0;
      for (const m of modifierKeys) {
        pressed |= MODIFIERS[m];
        await debuggerMgr.sendCommand(tid, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: m,
          code: keyToCode(m),
          windowsVirtualKeyCode: keyToVk(m),
          modifiers: pressed,
        });
      }
      await dispatchKey(debuggerMgr, tid, key, modifiers);
      for (let i = modifierKeys.length - 1; i >= 0; i--) {
        const m = modifierKeys[i];
        pressed &= ~MODIFIERS[m];
        await debuggerMgr.sendCommand(tid, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: m,
          code: keyToCode(m),
          windowsVirtualKeyCode: keyToVk(m),
          modifiers: pressed,
        });
      }
      return { success: true, key: expr, focusedElement };
    },

    [KeyboardActions.SHORTCUT]: async (args, tabId) => {
      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const keys = args.keys as string[];
      if (!keys || keys.length < 2) throw vtxError(VtxErrorCode.INVALID_PARAMS, "keys must be an array of at least 2 keys");

      await debuggerMgr.attach(tid);

      // 计算修饰键标志位
      let modifiers = 0;
      const modifierKeys: string[] = [];
      const nonModifierKeys: string[] = [];
      for (const k of keys) {
        if (k in MODIFIERS) {
          modifiers |= MODIFIERS[k];
          // 归一别名(Cmd→Meta 等),使 keyToCode/keyToVk 取到正确物理码/VK。
          modifierKeys.push(MODIFIER_CANON[k] ?? k);
        } else {
          nonModifierKeys.push(k);
        }
      }

      // 按下修饰键
      for (const k of modifierKeys) {
        await debuggerMgr.sendCommand(tid, "Input.dispatchKeyEvent", {
          type: "keyDown", key: k, code: keyToCode(k),
          windowsVirtualKeyCode: keyToVk(k), modifiers,
        });
      }

      // 按下并释放主键
      for (const k of nonModifierKeys) {
        await dispatchKey(debuggerMgr, tid, k, modifiers);
      }

      // 释放修饰键（逆序）
      for (const k of [...modifierKeys].reverse()) {
        await debuggerMgr.sendCommand(tid, "Input.dispatchKeyEvent", {
          type: "keyUp", key: k, code: keyToCode(k),
          windowsVirtualKeyCode: keyToVk(k), modifiers: 0,
        });
      }

      return { success: true, keys };
    },
  });
}
