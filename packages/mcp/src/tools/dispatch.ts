// packages/mcp/src/tools/dispatch.ts
// 新工具名 → extension action + 参数 reshape。
// 与 server.ts 解耦，便于单元测试。

import { VtxErrorCode, vtxError } from "@bytenew/vortex-shared";

/**
 * 基于新 MCP tool 名，动态决定发哪个 extension action 以及如何 reshape 参数。
 * 返回 null 表示该工具直接使用 toolDef.action，无需特殊处理。
 *
 * 非法 enum / 缺少必要字段时直接 throw VtxError —— 由 server.ts 统一格式化为
 * `Error [CODE]: msg + hint` 返给 LLM，避免 sentinel 字符串泄漏到 sendRequest。
 */
export function dispatchNewTool(
  name: string,
  params: Record<string, unknown>,
): { action: string; params: Record<string, unknown> } | null {
  switch (name) {
    case "vortex_navigate": {
      const { reload, ...rest } = params;
      return { action: reload ? "page.reload" : "page.navigate", params: rest };
    }
    case "vortex_history": {
      const { direction, ...rest } = params;
      return { action: direction === "forward" ? "page.forward" : "page.back", params: rest };
    }
    case "vortex_wait": {
      // target 若是普通 selector（非 @ref），透传为 selector 字段
      const { target, ...rest } = params;
      if (target && typeof target === "string" && !target.startsWith("@")) {
        return { action: "page.wait", params: { selector: target, ...rest } };
      }
      return { action: "page.wait", params: { ...rest } };
    }
    case "vortex_wait_idle": {
      const { kind, idleMs, ...rest } = params;
      const action = kind === "network"
        ? "page.waitForNetworkIdle"
        : kind === "dom"
        ? "dom.waitSettled"
        : "page.waitForXhrIdle";
      // idleMs → idleTime（network/xhr）或 quietMs（dom）
      const idleKey = kind === "dom" ? "quietMs" : "idleTime";
      return { action, params: idleMs != null ? { [idleKey]: idleMs, ...rest } : rest };
    }
    case "vortex_fill": {
      const { kind, ...rest } = params;
      return { action: kind ? "dom.commit" : "dom.fill", params: kind ? { kind, ...rest } : rest };
    }
    case "vortex_evaluate": {
      const { async: isAsync, ...rest } = params;
      return { action: isAsync ? "js.evaluateAsync" : "js.evaluate", params: rest };
    }
    case "vortex_screenshot": {
      // target 已被上层 target-translation 转成 selector/index；存在则截元素
      const hasTarget = params.selector != null || params.index != null;
      return { action: hasTarget ? "capture.element" : "capture.screenshot", params };
    }
    case "vortex_console": {
      const { op, ...rest } = params;
      return { action: op === "clear" ? "console.clear" : "console.getLogs", params: rest };
    }
    case "vortex_network": {
      const { op, filter, ...rest } = params;
      if (op === "clear") return { action: "network.clear", params: rest };
      if (filter) return { action: "network.filter", params: { ...(filter as object), ...rest } };
      return { action: "network.getLogs", params: rest };
    }
    case "vortex_storage_get": {
      const { scope, ...rest } = params;
      const action = scope === "cookie"
        ? "storage.getCookies"
        : scope === "session"
        ? "storage.getSessionStorage"
        : "storage.getLocalStorage";
      return { action, params: rest };
    }
    case "vortex_storage_set": {
      const { scope, op, ...rest } = params;
      if (op === "delete" && scope === "cookie") return { action: "storage.deleteCookie", params: rest };
      const action = scope === "cookie"
        ? "storage.setCookie"
        : scope === "session"
        ? "storage.setSessionStorage"
        : "storage.setLocalStorage";
      return { action, params: rest };
    }
    case "vortex_storage_session": {
      const { op, ...rest } = params;
      return { action: op === "import" ? "storage.importSession" : "storage.exportSession", params: rest };
    }
    case "vortex_file_list_downloads":
      return { action: "file.getDownloads", params };

    // ──────────────────────────────────────────────────────────────────
    // v0.6 L4 public tools (PR #4)
    // act/extract/observe 第一阶段：复用 v0.5 handler；descriptor target +
    // 真 a11y subtree 集成留 v0.6.x follow-up（spec L4 §0.1 deferred）。
    // ──────────────────────────────────────────────────────────────────
    case "vortex_act": {
      const { action: actionName, value, options, target, ...rest } = params;
      const v05Action = ACT_TO_V05[actionName as string];
      if (!v05Action) {
        throw vtxError(
          VtxErrorCode.UNSUPPORTED_ACTION,
          `act: action must be one of ${Object.keys(ACT_TO_V05).join("|")}, got ${String(actionName)}`,
          { extras: { action: actionName } },
        );
      }
      const next: Record<string, unknown> = { target, ...rest };
      // value 语义按 action 分流：
      // - scroll 时 value 是参数对象 {container?, position?, x?, y?} → spread 到 args，
      //   底层 dom.scroll 直接读 args.container / args.position / args.x / args.y
      // - fill/type/select 时 value 是要设置的数据（string/object/array），透传 next.value
      // - hover/click 时 value 通常 undefined
      if (
        actionName === "scroll" &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        Object.assign(next, value as Record<string, unknown>);
        // server.ts 已把 params.target 翻译成 params.selector（@ref → selector
        // 或 raw selector 直传）；strip selector / target 二者，让 dom.scroll 走
        // position 分支，否则 handler 见 sel 即 scrollIntoView 屏蔽 container/position。
        const v = value as Record<string, unknown>;
        if ("container" in v || "position" in v || "x" in v || "y" in v) {
          delete next.target;
          delete next.selector;
          delete next.index; // ref 形式翻成 index 时也 strip
        }
      } else if (value !== undefined) {
        next.value = value;
      }
      // options.timeout / options.force 透传
      if (options && typeof options === "object") {
        const o = options as Record<string, unknown>;
        if (o.timeout !== undefined) next.timeout = o.timeout;
        if (o.force !== undefined) next.force = o.force;
      }
      return { action: v05Action, params: next };
    }
    // vortex_observe is fully handled by the special branch in
    // server.ts (compact rendering + activeSnapshotId tracking + scope/filter
    // reshape live there). That branch returns before dispatchNewTool is
    // called, so a case here would be dead code; the I16 invariant test now
    // guards against re-introducing it (see invariants/I16.dispatch-routing).
    case "vortex_extract": {
      // server.ts 已把 target=@ref 翻成 params.index/snapshotId（删了 params.target），
      // 把 target=selector 翻成 params.selector。v0.8.1 起 content.getText
      // handler 通过 resolveTargetOptional 反查 snapshot store 拿 selector，
      // 不再依赖 a11y subtree —— @ref 与 CSS selector 走同一条 page-side 路径
      // （P0-6, 2026-05-21 用户报告）。
      const { target: _target, depth, include, ...rest } = params;
      const next: Record<string, unknown> = { ...rest };
      if (depth !== undefined) next.maxDepth = depth;
      if (Array.isArray(include)) next.include = include;
      return { action: "content.getText", params: next };
    }
    case "vortex_wait_for": {
      const { mode, value, timeout, ...rest } = params;
      const next: Record<string, unknown> = { ...rest };
      if (timeout !== undefined) next.timeout = timeout;
      switch (mode) {
        case "element": {
          // value 不经 server.ts target translation；@ref 形式手动展开
          if (typeof value === "string" && value.startsWith("@")) {
            throw vtxError(
              VtxErrorCode.INVALID_PARAMS,
              "wait_for(mode=element): @ref form not supported here. Pass a CSS selector as value.",
            );
          }
          if (value !== undefined) next.selector = value;
          return { action: "page.wait", params: next };
        }
        case "idle": {
          // value: 'network' | 'xhr' | 'dom'
          const action = value === "network"
            ? "page.waitForNetworkIdle"
            : value === "dom"
            ? "dom.waitSettled"
            : "page.waitForXhrIdle";
          return { action, params: next };
        }
        case "info":
          return { action: "page.info", params: next };
        default:
          throw vtxError(
            VtxErrorCode.INVALID_PARAMS,
            `wait_for: mode must be one of element|idle|info, got ${String(mode)}`,
          );
      }
    }
    case "vortex_debug_read": {
      const { source, filter, tail, ...rest } = params;
      const next: Record<string, unknown> = { ...rest };
      if (filter && typeof filter === "object") Object.assign(next, filter);
      if (tail !== undefined) next.limit = tail;
      const action = source === "network" ? "network.getLogs" : "console.getLogs";
      return { action, params: next };
    }
    case "vortex_storage": {
      const { op, key, value, ...rest } = params;
      const next: Record<string, unknown> = { ...rest };
      if (key !== undefined) next.key = key;
      if (value !== undefined) next.value = value;
      switch (op) {
        case "get":
          return { action: "storage.getLocalStorage", params: next };
        case "set":
          return { action: "storage.setLocalStorage", params: next };
        case "session-get":
          return { action: "storage.getSessionStorage", params: next };
        case "session-set":
          return { action: "storage.setSessionStorage", params: next };
        case "cookies-get":
          return { action: "storage.getCookies", params: next };
        default:
          throw vtxError(
            VtxErrorCode.INVALID_PARAMS,
            `storage: op must be one of get|set|session-get|session-set|cookies-get, got ${String(op)}`,
          );
      }
    }
    case "vortex_press": {
      // schema 暴露 `key`（与 v0.5 + handler 一致），无需 reshape；这里 case 留空走 toolDef.action 即可
      return null;
    }

    default:
      return null;
  }
}

// vortex_act 的 action enum → v0.5 extension handler action
// 不含 drag —— mouse.drag 需要 fromX/fromY/toX/toY 坐标，act schema 只暴露 target+value
// 无法表达；drag 用例留 v0.6.x（独立工具或扩展 value 形态）。
const ACT_TO_V05: Record<string, string> = {
  click: "dom.click",
  fill: "dom.fill",
  type: "dom.type",
  select: "dom.select",
  scroll: "dom.scroll",
  hover: "dom.hover",
};
