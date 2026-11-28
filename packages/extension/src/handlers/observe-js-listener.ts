/**
 * getEventListeners 真值交互**发现**层（任务 T3，2026-06-14 重设计 + live 验证）
 *
 * 定位修正（live dogfood 揭示的架构真相）：
 *   初版把 getEventListeners 当作**事后标注**——只在已收集元素（data-vtx-ax）上跑，
 *   永远发现不了被启发式漏掉的 `<div addEventListener('click')>`（无 cursor:pointer、
 *   无 role、无框架 prop）。这正是 #1 根因族「裸 div onClick 被漏」的核心。
 *
 *   browser-use（dom/service.py 447-484）的做法才是 discovery：getEventListeners
 *   扫全量元素，结果作为**入池信号**（service.py:822 `has_js_click_listener`）。本模块
 *   对齐此思路——在 page-side scan **之前**给带点击类监听器的元素打 `data-vtx-listener`，
 *   scan 把该属性当作与 cursor:pointer/hasFrameworkClick 并列的收集信号 → 真正 DISCOVER。
 *
 * 与 hasFrameworkClick 的分工（observe.ts:1451）：
 *   - hasFrameworkClick 读 React `__reactProps$.onClick` / Vue3 `_vei.onClick`，
 *     **绕开框架事件委托**，覆盖 React/Vue 裸 div（委托到 root，getEventListeners
 *     在 div 自身查不到）。
 *   - 本模块的 getEventListeners 覆盖**纯 addEventListener**（vanilla / jQuery /
 *     其它库直接绑定，非框架委托）的 div。二者并集，互补无重叠盲区。
 *
 * 机制（chrome.debugger 兼容，**唯一可用路径** = DOMDebugger 真协议方法）：
 *   `DOMDebugger.getEventListeners({objectId:<document>, depth:-1, pierce:true})`
 *   一次拿整页（含 shadow / iframe）所有监听器，每条带 backendNodeId；筛点击类
 *   → `DOM.getDocument`（满足 push 的「文档须先请求」前置）→
 *   `DOM.pushNodesByBackendIdsToFrontend` 批量转 nodeId →
 *   `DOM.resolveNode` + `Runtime.callFunctionOn` 在页侧检查 deadline 后打标记。
 *
 *   ⚠️ 为何不用 CommandLineAPI `getEventListeners`（browser-use 同款单评估）：
 *     live 实测 `typeof getEventListeners === 'undefined'`——该函数是 DevTools 前端
 *     注入的 CommandLineAPI，**chrome.debugger 的 Runtime.evaluate 不暴露它**
 *     （browser-use 走原生 CDP WebSocket 才可用）。曾试 includeCommandLineAPI:true
 *     仍 undefined，故移除该路径，避免每次 observe 白付一次评估。
 *
 * 召回零回退铁律：
 *   - 只**新增** data-vtx-listener 入池信号，不删除任何元素、不改任何现有判据。
 *   - CDP 失败 / 页面过重（>cap）→ 标记 0 个，scan 退回现有 cursor:pointer +
 *     hasFrameworkClick 启发式，observe 整轮不崩、不丢元素。
 *
 * 参考：browser-use dom/service.py 438-536（CommandLineAPI getEventListeners 全量扫）。
 */

import type { DebuggerManager } from "../lib/debugger-manager.js";
import type { ListenerRequest } from "./observe-listener-ownership.js";

/** scan 用来识别「有 JS 点击监听器」元素的属性名（pre-scan 打、post-scan 清）。 */
export const LISTENER_MARK_ATTR = "data-vtx-listener";

/**
 * scan 用来识别「拖放投放区(drop target)」元素的属性名（pre-scan 打、post-scan 清）。
 * 与 LISTENER_MARK_ATTR 并列但语义不同:drop 区不是点击目标,渲染为独立 [dropzone] 信号,
 * 供 ref-based vortex_drag 的 endRef 定位投放区(无此信号则仅靠 drop/dragover 监听、无
 * role/无 cursor/非 draggable 的 drop 区对 observe 完全不可见 → 拖放任务无 endRef 可表达)。
 */
export const DROPZONE_MARK_ATTR = "data-vtx-dropzone";

/**
 * 点击监听器元素数上限：超过此值跳过标记，静默回退（召回安全）。
 * 与 browser-use 同量级（10000）——监听器极多的页让位给现有启发式。
 */
export const JS_LISTENER_ELEMENT_CAP = 10000;

/**
 * 关注的事件类型：含这些事件之一即判为有点击类 JS 监听器。
 * 对齐 browser-use 的 5 类：click / mousedown / mouseup / pointerdown / pointerup。
 */
const CLICK_EVENT_TYPES = ["click", "mousedown", "mouseup", "pointerdown", "pointerup"];

/**
 * 拖放投放区事件类型:含其一即判为 drop target。
 * - `drop`:标准 HTML5 投放处理器(决定性信号)。
 * - `dragenter`/`dragover`:react-dnd / 多数库给投放节点绑的接受信号(其 drop 常在 window
 *   级集中处理,投放节点自身可能只有 dragenter/dragover/dragleave)——纳入以覆盖库模式。
 * 不含 `dragstart`/`drag`/`dragend`(那是**拖源**信号,拖源已由 draggable=true 召回)。
 */
const DROP_TARGET_EVENT_TYPES = ["drop", "dragenter", "dragover"];

/** DOMDebugger.getEventListeners 单条监听器形（只用到 type + backendNodeId）。 */
interface CdpEventListener {
  type?: string;
  backendNodeId?: number;
}

/** 标记结果：命中数 + 实际生效的机制（供诊断 / 测试断言）。 */
export type ListenerMechanism = "domDebugger" | "skipped-heavy" | "error" | "timeout";

export interface ListenerMarkResult {
  /** 打了 data-vtx-listener 的点击类元素数。 */
  count: number;
  /** 打了 data-vtx-dropzone 的投放区元素数。 */
  dropzoneCount: number;
  mechanism: ListenerMechanism;
}

/**
 * **pre-scan**：给主 frame 内带点击类 JS 监听器的元素打 `data-vtx-listener` 属性，
 * 供随后的 page-side scan 当作入池信号（DISCOVER 漏网 addEventListener div）。
 *
 * 须在 page-side scan **之前**调用；标记在真 DOM 上，executeScript 扫描可见。
 * 调用方先按 documentId claim，并在 scan 后/finally retire 自己 token 的标记。
 *
 * @param debuggerMgr DebuggerManager 实例（已 attach）
 * @param tabId       目标 tab（pierce:true 已覆盖子 frame 监听器读取）
 * @returns {count, mechanism}；失败时 count=0，scan 退回现有启发式。
 */
export async function markListenerElements(
  debuggerMgr: Pick<DebuggerManager, "sendCommand" | "attach" | "enableDomain">,
  tabId: number,
  deadline = Infinity,
  paginationSnapshotId?: string,
  requests: ListenerRequest[] = [],
): Promise<ListenerMarkResult> {
  if (requests.length === 0) return { count: 0, dropzoneCount: 0, mechanism: "error" };
  let docObjectId: string | undefined;
  try {
    if (typeof (debuggerMgr as DebuggerManager).attach === "function") {
      await (debuggerMgr as DebuggerManager).attach(tabId);
    }
    if (typeof (debuggerMgr as DebuggerManager).enableDomain === "function") {
      await (debuggerMgr as DebuggerManager).enableDomain(tabId, "DOM");
    }

    // document 的 RemoteObject（getEventListeners 的根 objectId）
    const docResp = (await debuggerMgr.sendCommand(tabId, "Runtime.evaluate", {
      expression: "document",
      returnByValue: false,
    })) as { result?: { objectId?: string } } | undefined;
    docObjectId = docResp?.result?.objectId;
    if (!docObjectId) return { count: 0, dropzoneCount: 0, mechanism: "error" };

    // 一次拿整个文档子树（含 shadow / iframe）所有监听器，每条带 backendNodeId
    const leResp = (await debuggerMgr.sendCommand(tabId, "DOMDebugger.getEventListeners", {
      objectId: docObjectId,
      depth: -1,
      pierce: true,
    })) as { listeners?: CdpEventListener[] } | undefined;
    const listeners = leResp?.listeners ?? [];

    // 同一次 getEventListeners 结果分两类:点击类(→data-vtx-listener)与投放区(→data-vtx-dropzone)。
    const clickIds = new Set<number>();
    const dropIds = new Set<number>();
    for (const l of listeners) {
      if (Date.now() >= deadline) return { count: 0, dropzoneCount: 0, mechanism: "timeout" };
      const t = l.type ?? "";
      if (typeof l.backendNodeId !== "number") continue;
      if (CLICK_EVENT_TYPES.includes(t)) clickIds.add(l.backendNodeId);
      if (DROP_TARGET_EVENT_TYPES.includes(t)) dropIds.add(l.backendNodeId);
    }
    if (clickIds.size === 0 && dropIds.size === 0) {
      return { count: 0, dropzoneCount: 0, mechanism: "domDebugger" };
    }
    if (clickIds.size + dropIds.size > JS_LISTENER_ELEMENT_CAP) {
      return { count: 0, dropzoneCount: 0, mechanism: "skipped-heavy" };
    }

    // pushNodesByBackendIdsToFrontend 要求 DOM agent 已「请求过文档」(否则
    // "Document needs to be requested first")。depth:-1+pierce 确保 shadow/iframe
    // 节点也在 frontend map 内，与 getEventListeners 的 pierce:true 对齐。仅在确有
    // 关注监听器(且 ≤cap)时才付此遍历代价。
    await debuggerMgr.sendCommand(tabId, "DOM.getDocument", { depth: -1, pierce: true });

    // 页侧检查截止时间，避免排队中的 CDP 命令在超时后写入。
    let incomplete = false;
    const markSet = async (ids: Set<number>, attr: string): Promise<number> => {
      if (ids.size === 0) return 0;
      if (Date.now() >= deadline) { incomplete = true; return 0; }
      const pushResp = (await debuggerMgr.sendCommand(tabId, "DOM.pushNodesByBackendIdsToFrontend", {
        backendNodeIds: [...ids],
      })) as { nodeIds?: number[] } | undefined;
      const nodeIds = pushResp?.nodeIds ?? [];
      let n = 0;
      for (const nodeId of nodeIds) {
        if (!nodeId) { incomplete = true; continue; }
        if (Date.now() >= deadline) { incomplete = true; break; }
        let objectId: string | undefined;
        try {
          const resolved = await debuggerMgr.sendCommand(tabId, "DOM.resolveNode", { nodeId }) as { object?: { objectId?: string } };
          objectId = resolved?.object?.objectId;
          if (!objectId) { incomplete = true; continue; }
          if (Date.now() >= deadline) { incomplete = true; break; }
          const response = await debuggerMgr.sendCommand(tabId, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function (name, deadline, token, requests) {
              if (Date.now() >= deadline) return false;
              const doc = this.ownerDocument;
              // Document 节点没有所属文档(ownerDocument 为 null),无法校验归属,跳过且不算缺口。
              if (!doc) return "not-target";
              // pierce also returns child nodes when only the main frame was claimed.
              if (requests.every(r => r.frameId === 0) && doc?.defaultView &&
                  doc.defaultView !== doc.defaultView.top) return "not-target";
              const owner = doc?.__vortexListenerOwner;
              const request = requests.find(r => owner && owner.documentId === r.documentId && owner.frameId === r.frameId &&
                owner.epoch === r.epoch && owner.highWater === r.order && owner.owner === r.token &&
                !owner.retired && owner.deadline === r.deadline && Date.now() < r.deadline);
              if (!request) return false;
              const scan = doc.__vortexScanOwner;
              if (!scan || scan.owner !== request.scanToken || scan.documentId !== request.documentId ||
                  scan.frameId !== request.frameId || scan.retired || Date.now() >= scan.deadline) return false;
              const item = token && doc.defaultView?.__vortexPageSnapshots?.[token];
              if (item) item.marker(this, name, request.token, scan); else this.setAttribute(name, request.token);
              return true;
            }`,
            arguments: [{ value: attr }, { value: Number.isFinite(deadline) ? deadline : Number.MAX_SAFE_INTEGER }, { value: paginationSnapshotId ?? null }, { value: requests }],
            returnByValue: true,
          }) as { result?: { value?: boolean | "not-target" }; exceptionDetails?: unknown };
          if (!response?.exceptionDetails && response?.result?.value === true) n++;
          else if (response?.exceptionDetails || response?.result?.value !== "not-target") incomplete = true;
        } catch {
          incomplete = true;
        } finally {
          if (objectId) {
            try { await debuggerMgr.sendCommand(tabId, "Runtime.releaseObject", { objectId }); }
            catch { incomplete = true; }
          }
        }
      }
      return n;
    };

    // 点击类先标(保序:既有测试断言首个 push 为点击集),投放区后标。
    const count = await markSet(clickIds, LISTENER_MARK_ATTR);
    const dropzoneCount = await markSet(dropIds, DROPZONE_MARK_ATTR);
    return { count, dropzoneCount, mechanism: incomplete ? (Date.now() >= deadline ? "timeout" : "error") : "domDebugger" };
  } catch {
    return { count: 0, dropzoneCount: 0, mechanism: "error" };
  } finally {
    if (docObjectId) {
      try {
        await debuggerMgr.sendCommand(tabId, "Runtime.releaseObject", { objectId: docObjectId });
      } catch {
        /* 释放失败无害 */
      }
    }
  }
}
