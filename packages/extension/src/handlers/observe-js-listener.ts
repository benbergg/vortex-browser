/**
 * getEventListeners 真值交互信号层（任务 T3）
 *
 * 设计：用 CDP Runtime.evaluate + includeCommandLineAPI:true 在页面侧调用
 * `getEventListeners(el)` 收集带 click/mousedown/mouseup/pointerdown/pointerup
 * 监听器的元素，通过已打的 data-vtx-ax 下标关联到 ScannedElement 列表，原地标记
 * `listenerInteractive: true`。
 *
 * 召回零回退铁律：
 *   - 此模块只**新增** listenerInteractive 标记，不删除任何元素，不修改
 *     原有 reactClickable/role/name 等字段。
 *   - CDP 失败 → 静默返回空集，observe 整轮不崩、不丢元素，原启发式保持不变。
 *
 * React 委托注意：React 17+ 将 onClick 委托到 root 容器（#root/document），
 * 单个 `<div onClick>` 元素自身的 getEventListeners 查不到监听器，不会打
 * [listener] 标记。但本信号是**并集增强**（非替换），该元素仍由 cursor:pointer
 * 启发式（reactClickable）照常召回，零漏抓。维护者勿误判为 bug。
 *
 * 参考：browser-use dom/service.py 447-535（同路径：Runtime.evaluate +
 * includeCommandLineAPI + describeNode 批量；本实现用 data-vtx-ax 直接关联
 * 省去 DOM.describeNode，性能更优）。
 */

import type { DebuggerManager } from "../lib/debugger-manager.js";

/**
 * 已打 [data-vtx-ax] 标记元素数上限：超过此值时跳过 getEventListeners 扫描，静默回退。
 * 标记元素数 = observe 候选集大小（通常 ≤ maxElements 默认值 80），远低于全量 DOM 数。
 * 此常量保留与 browser-use 同量级（~10000）以防极端场景（maxElements 被大幅放宽时）。
 */
export const JS_LISTENER_ELEMENT_CAP = 10000;

/**
 * 关注的事件类型：只有包含这些事件的元素才判为有 JS 监听器。
 * 对齐 browser-use 参考实现的 5 类：click / mousedown / mouseup /
 * pointerdown / pointerup 覆盖所有主流点击类监听。
 */
const CLICK_EVENT_TYPES = ["click", "mousedown", "mouseup", "pointerdown", "pointerup"];

/**
 * 通过 CDP Runtime.evaluate（includeCommandLineAPI:true）在页面侧调用
 * `getEventListeners`，返回带 click 类监听器的元素的 data-vtx-ax 索引集合。
 *
 * 机制：
 *   1. 页面侧已打 `data-vtx-ax=<idx>` 标记（observe scan 后、AX overlay 前后均存在）
 *   2. 遍历所有 `[data-vtx-ax]` 元素（O(N)，N = 已收集候选数，通常 ≤ 80）
 *      而非 document.querySelectorAll('*')（O(全量)），避免不必要全量遍历
 *   3. 对每个元素调 getEventListeners，返回 {idx: true} 的扁平映射
 *   4. 标记元素数 > JS_LISTENER_ELEMENT_CAP 时提前 return null → 调用方收空集
 *
 * 返回：Set<number>，含有监听器的 data-vtx-ax 索引；失败时返回空集。
 *
 * @param debuggerMgr  DebuggerManager 实例（已 attach）
 * @param tabId        目标 tab
 * @param _frameId     目标 frame（当前恒在 tab 主 frame 执行；子 frame 暂不支持，
 *                     需改用 CDP executionContextId 路由，保留参数供将来扩展）
 */
export async function collectJsListenerIndices(
  debuggerMgr: Pick<DebuggerManager, "sendCommand" | "attach">,
  tabId: number,
  _frameId: number,
): Promise<Set<number>> {
  try {
    // 确保 debugger 已 attach（幂等）。enableDomain 不需要——Runtime.evaluate
    // 不依赖 Runtime 域的 enable（它是 CommandLineAPI 特性，attach 即可用）。
    if (typeof (debuggerMgr as DebuggerManager).attach === "function") {
      await (debuggerMgr as DebuggerManager).attach(tabId);
    }

    /**
     * 页面侧注入表达式：
     *   - 仅扫已打 data-vtx-ax 标记的候选元素（observe scan 输出集，通常 ≤ 80），
     *     标记数超 cap 时返回 null（调用方静默回退）。
     *   - 对每个元素调 getEventListeners 检测 5 类点击事件：
     *     click / mousedown / mouseup / pointerdown / pointerup。
     *   - 返回 {vtxIdx: true, ...} 的扁平对象（JSON-serializable）。
     *
     * 不扫 querySelectorAll('*') 的理由：
     *   真正循环的对象是 [data-vtx-ax] 标记元素（候选集），已天然有界；
     *   全量 * 扫在重型页面是纯额外开销且与 cap 保护对象不符。
     */
    const expression = `
      (() => {
        // getEventListeners 仅在 includeCommandLineAPI 开启时可用
        if (typeof getEventListeners !== 'function') return null;

        // 仅扫已打 data-vtx-ax 标记的候选元素（observe scan 输出集）
        const marked = document.querySelectorAll('[data-vtx-ax]');

        // 标记元素数超 cap → 跳过防卡（极端场景：maxElements 被大幅放宽时）
        if (marked.length > ${JS_LISTENER_ELEMENT_CAP}) return null;

        const result = {};
        const CLICK_TYPES = ${JSON.stringify(CLICK_EVENT_TYPES)};
        for (const el of marked) {
          try {
            const listeners = getEventListeners(el);
            const hasClick = CLICK_TYPES.some(t => listeners[t] && listeners[t].length > 0);
            if (hasClick) {
              const idx = parseInt(el.getAttribute('data-vtx-ax'), 10);
              if (!isNaN(idx)) result[idx] = true;
            }
          } catch (e) {
            // 单元素失败跳过，继续
          }
        }
        return result;
      })()
    `;

    const response = (await debuggerMgr.sendCommand(tabId, "Runtime.evaluate", {
      expression,
      includeCommandLineAPI: true, // 启用 getEventListeners()
      returnByValue: true,          // 直接返回 JSON 值，避免 objectId 来回
      awaitPromise: false,
    })) as { result?: { value?: unknown } } | undefined;

    const value = response?.result?.value;
    if (value == null || typeof value !== "object") return new Set();

    // 将 {idx: true} 对象转换为 Set<number>，过滤非数字键
    const indices = new Set<number>();
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const n = Number(key);
      if (Number.isInteger(n) && n >= 0) indices.add(n);
    }
    return indices;
  } catch {
    // CDP 失败（debugger 未 attach / 页面已销毁 / 权限拒绝）→ 静默回退空集
    return new Set();
  }
}

/**
 * 最小可注入元素形：仅需 listenerInteractive 字段可写。
 * 与 ScannedElement 的结构子集对齐，不引入循环依赖。
 */
export interface ListenerAnnotatable {
  listenerInteractive?: true;
  [key: string]: unknown;
}

/**
 * 原地给已扫元素追加 `listenerInteractive: true` 标记。
 *
 * 并集增强语义：
 *   - 只**新增**标记，不删除任何元素，不修改任何现有字段。
 *   - listenerIndices 为空（CDP 失败回退）时函数是 no-op：元素集大小/内容完全不变。
 *   - 越界索引（idx >= elements.length）静默跳过。
 *
 * @param elements       已扫元素数组（原地修改）
 * @param listenerIndices 有 click 类监听器的元素索引集合
 */
export function applyListenerSignal(
  elements: ListenerAnnotatable[],
  listenerIndices: Set<number>,
): void {
  for (const idx of listenerIndices) {
    if (idx >= 0 && idx < elements.length) {
      elements[idx].listenerInteractive = true;
    }
    // 越界索引静默跳过
  }
}
