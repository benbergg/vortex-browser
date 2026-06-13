/**
 * getEventListeners 真值交互信号层（任务 T3）
 *
 * 设计：用 CDP Runtime.evaluate + includeCommandLineAPI:true 在页面侧调用
 * `getEventListeners(el)` 收集带 click/mousedown/pointerdown 监听器的元素，
 * 通过已打的 data-vtx-ax 下标关联到 ScannedElement 列表，原地标记
 * `listenerInteractive: true`。
 *
 * 召回零回退铁律：
 *   - 此模块只**新增** listenerInteractive 标记，不删除任何元素，不修改
 *     原有 reactClickable/role/name 等字段。
 *   - CDP 失败 / 元素总数 > JS_LISTENER_ELEMENT_CAP → 静默返回空集，
 *     observe 整轮不崩、不丢元素，原启发式保持不变。
 *
 * 参考：browser-use dom/service.py 447-535（同路径：Runtime.evaluate +
 * includeCommandLineAPI + describeNode 批量；本实现用 data-vtx-ax 直接关联
 * 省去 DOM.describeNode，性能更优）。
 */

import type { DebuggerManager } from "../lib/debugger-manager.js";

/**
 * 页面元素总数上限：超过此值时跳过 getEventListeners 扫描，静默回退。
 * 与 browser-use 保持一致（~10000），防止超重型页面卡死。
 */
export const JS_LISTENER_ELEMENT_CAP = 10000;

/**
 * 关注的事件类型：只有包含这些事件的元素才判为有 JS 监听器。
 * click / mousedown / pointerdown 覆盖所有主流点击类监听。
 */
const CLICK_EVENT_TYPES = ["click", "mousedown", "pointerdown"];

/**
 * 通过 CDP Runtime.evaluate（includeCommandLineAPI:true）在页面侧调用
 * `getEventListeners`，返回带 click 类监听器的元素的 data-vtx-ax 索引集合。
 *
 * 机制：
 *   1. 页面侧已打 `data-vtx-ax=<idx>` 标记（observe scan 后、AX overlay 前后均存在）
 *   2. 遍历所有 `[data-vtx-ax]` 元素（O(N)，N = 已收集候选数，通常 ≤ 80）
 *      而非 document.querySelectorAll('*')（O(全量），避免不必要全量遍历）
 *   3. 对每个元素调 getEventListeners，返回 {idx: true} 的扁平映射
 *   4. 全量页面元素 > JS_LISTENER_ELEMENT_CAP 时提前 return null → 调用方收空集
 *
 * 返回：Set<number>，含有监听器的 data-vtx-ax 索引；失败时返回空集。
 *
 * @param debuggerMgr  DebuggerManager 实例（已 attach）
 * @param tabId        目标 tab
 * @param frameId      目标 frame（仅主 frame 0，子 frame 暂不支持）
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
     *   - 先统计全量元素数，超 cap 返回 null（让调用方静默回退）。
     *   - 遍历已打 data-vtx-ax 标记的元素（候选集，通常 ≤ 80），
     *     对每个调 getEventListeners 检测 click/mousedown/pointerdown。
     *   - 返回 {vtxIdx: true, ...} 的扁平对象（JSON-serializable）。
     *
     * 为什么只扫 [data-vtx-ax] 而非 querySelectorAll('*')：
     *   候选数通常 ≤ 80（maxElements 默认值），全量可能 10000+；
     *   只关心已收集元素的监听信号，扫全量既慢又无用。
     */
    const expression = `
      (() => {
        // getEventListeners 仅在 includeCommandLineAPI 开启时可用
        if (typeof getEventListeners !== 'function') return null;

        // 全量元素超 cap → 跳过防卡（与 browser-use 一致）
        const allEls = document.querySelectorAll('*');
        if (allEls.length > ${JS_LISTENER_ELEMENT_CAP}) return null;

        // 仅扫已打 data-vtx-ax 标记的候选元素（observe scan 输出集）
        const marked = document.querySelectorAll('[data-vtx-ax]');
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
