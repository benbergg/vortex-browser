import { KeyboardActions, VtxErrorCode, vtxError } from "@bytenew/vortex-shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";

// DOM key → windowsVirtualKeyCode 映射
const KEY_CODES: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  Control: 17, Shift: 16, Alt: 18, Meta: 91,
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

// 修饰键名 → CDP modifiers 标志位
const MODIFIERS: Record<string, number> = {
  Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8,
};

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
    modifierKeys.push(m);
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
  const code = KEY_CODES[key] ?? key.charCodeAt(0);

  await debuggerMgr.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code: key,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers,
  });

  await debuggerMgr.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: key,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
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
        const mcode = KEY_CODES[m] ?? 0;
        await debuggerMgr.sendCommand(tid, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: m,
          code: m,
          windowsVirtualKeyCode: mcode,
          modifiers: pressed,
        });
      }
      await dispatchKey(debuggerMgr, tid, key, modifiers);
      for (let i = modifierKeys.length - 1; i >= 0; i--) {
        const m = modifierKeys[i];
        pressed &= ~MODIFIERS[m];
        const mcode = KEY_CODES[m] ?? 0;
        await debuggerMgr.sendCommand(tid, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: m,
          code: m,
          windowsVirtualKeyCode: mcode,
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
          modifierKeys.push(k);
        } else {
          nonModifierKeys.push(k);
        }
      }

      // 按下修饰键
      for (const k of modifierKeys) {
        const code = KEY_CODES[k] ?? 0;
        await debuggerMgr.sendCommand(tid, "Input.dispatchKeyEvent", {
          type: "keyDown", key: k, code: k,
          windowsVirtualKeyCode: code, modifiers,
        });
      }

      // 按下并释放主键
      for (const k of nonModifierKeys) {
        await dispatchKey(debuggerMgr, tid, k, modifiers);
      }

      // 释放修饰键（逆序）
      for (const k of [...modifierKeys].reverse()) {
        const code = KEY_CODES[k] ?? 0;
        await debuggerMgr.sendCommand(tid, "Input.dispatchKeyEvent", {
          type: "keyUp", key: k, code: k,
          windowsVirtualKeyCode: code, modifiers: 0,
        });
      }

      return { success: true, keys };
    },
  });
}
