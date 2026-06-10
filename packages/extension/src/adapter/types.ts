// L1 Adapter 层接口定义。
// 设计原则：CDP 不外泄到 L2/L3/L4。L2/L3/L4 只 import NativeAdapter / CapabilityDetector，
// 不能 import cdp.ts。depcruise 静态强制（见 .dependency-cruiser.cjs）。

import type { DebuggerManager } from "../lib/debugger-manager.js";

/** chrome.scripting 包装，page-side func 由调用方提供。 */
export interface NativeAdapter {
  /** 在 tab+frame 内执行 page-side 函数，取 r[0]?.result。world 默认 MAIN（与 dom.ts 现有 driver 一致）。 */
  pageQuery<T>(
    tabId: number,
    frameId: number | undefined,
    fn: (...args: unknown[]) => T,
    args?: unknown[],
  ): Promise<T>;
}

/** chrome.debugger.* 包装。CDP-only 能力（trusted event / 真鼠标 click）。 */
export interface CdpAdapter {
  /** 真鼠标 click at page-coords (x, y)；调用方自行加 iframe offset。dispatchMouseEvent×3。 */
  clickBBox(
    tabId: number,
    x: number,
    y: number,
  ): Promise<void>;
  /** click 元素中心点（含探测 + scrollIntoView + occlusion + clickBBox）。供 CLICK useRealMouse 分支用。 */
  cdpClickElement(
    tabId: number,
    frameId: number | undefined,
    selector: string,
  ): Promise<{
    success: true;
    element: { tag: string; text?: string };
    x: number;
    y: number;
    mode: "realMouse";
  }>;
}

/** 容量探测：决定走 native 还是 cdp 路径。 */
export interface CapabilityDetector {
  /**
   * 当前 tab 能否 attach chrome.debugger（mock 失败时返回 false）。
   * 传 debuggerMgr 时为 try-attach 留驻模式（探测成功保持 attached，经 manager 记账复用）；
   * 不传为 legacy 纯探测（attach→立即 detach）。
   */
  canUseCDP(tabId: number, debuggerMgr?: DebuggerManager): Promise<boolean>;
  /** 操作是否要求 trusted event（如 drag / 部分 element-plus 组件）。 */
  needsTrustedEvent(action: "click" | "fill" | "type" | "drag", elementHint?: { tagName?: string }): boolean;
}

/** factory 入参：闭包共享的 debuggerMgr 注入点。 */
export interface AdapterDeps {
  debuggerMgr: DebuggerManager;
}
