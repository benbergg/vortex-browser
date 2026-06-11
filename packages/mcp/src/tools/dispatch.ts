// packages/mcp/src/tools/dispatch.ts
// 新工具名 → extension action + 参数 reshape。
// 与 server.ts 解耦，便于单元测试。

import { VtxErrorCode, vtxError } from "@vortex-browser/shared";

/**
 * MCP client 会把 untyped `value:{}` schema 的「对象/数组」实参序列化成 JSON
 * 字符串（字符串实参则原样透传）。期望结构化 value 的路径——act scroll 的
 * `{container,position,x,y}`、fill 结构化 kind（cascader/checkbox-group/
 * 多选 select/daterange…）——必须先把这种字符串还原，否则下游
 * `typeof value === "object"` / `Array.isArray(value)` 判否，导致参数被静默丢弃。
 *
 * 规则：仅当 value 是 JSON 字符串且 parse 出对象/数组时返回解析值；普通文本
 * （select 单值 "北京"、time "12:30:00"、scroll 非 JSON）原样返回，不误伤。
 * 2026-06-01 ag-grid(scroll) + Element Plus cascader(fill) 真实 client 路径实证。
 */
function parseStructuredValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

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
      const { kind, value, ...rest } = params;
      if (!kind) {
        // 纯文本 fill：value 是字符串数据，原样透传（不 parse，避免误把
        // 形似 JSON 的文本当结构化值）。
        return { action: "dom.fill", params: { value, ...rest } };
      }
      // 结构化 kind：dom.commit driver 期望 cascader=string[] /
      // checkbox-group={values:string[]} / 多选 select=string[] 等结构化值，
      // 但 client 已把它序列化成 JSON 字符串，此处还原。
      return { action: "dom.commit", params: { kind, value: parseStructuredValue(value), ...rest } };
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
      // - fill/select 时 value 是要设置的数据（string/object/array），透传 next.value
      // - type 时 value 是文本，但 dom.type handler 读 args.text → 归到 next.text
      // - hover/click 时 value 通常 undefined
      //
      // scroll 依赖结构化参数；client 已把对象 value 序列化成 JSON 字符串，
      // 故先还原（见 parseStructuredValue）。否则 `typeof === "object"` 判否 →
      // spread+strip 全跳过 → selector 残留 → dom.scroll 走 scrollIntoView 屏蔽
      // container/position，且静默返回 success（2026-06-01 ag-grid dogfood 实证）。
      const scrollValue: unknown =
        actionName === "scroll" ? parseStructuredValue(value) : value;
      if (
        actionName === "scroll" &&
        scrollValue !== null &&
        typeof scrollValue === "object" &&
        !Array.isArray(scrollValue)
      ) {
        Object.assign(next, scrollValue as Record<string, unknown>);
        // server.ts 已把 params.target 翻译成 params.selector（@ref → selector
        // 或 raw selector 直传）；strip selector / target 二者，让 dom.scroll 走
        // position 分支，否则 handler 见 sel 即 scrollIntoView 屏蔽 container/position。
        const v = scrollValue as Record<string, unknown>;
        if ("container" in v || "position" in v || "x" in v || "y" in v) {
          delete next.target;
          delete next.selector;
          delete next.index; // ref 形式翻成 index 时也 strip
        }
      } else if (actionName === "type") {
        if (value !== undefined) next.text = value;
      } else if (actionName === "select") {
        // select 的 value 可能是数组(原生 <select multiple> 多选)。client 已把
        // 数组实参序列化成 JSON 字符串,必须还原,否则 dom.select 收到字符串
        // '["x","z"]' 当单值匹配 → NO_MATCHING_OPTION(2026-06-03 多选 dogfood)。
        // 单值文本("北京"/option label)经 parseStructuredValue 原样透传不误伤。
        if (value !== undefined) next.value = parseStructuredValue(value);
      } else if (value !== undefined) {
        next.value = value;
      }
      // options.timeout / options.force / observeEffect / windowMs 透传
      if (options && typeof options === "object") {
        const o = options as Record<string, unknown>;
        if (o.timeout !== undefined) next.timeout = o.timeout;
        if (o.force !== undefined) next.force = o.force;
        // GAP-G(N0062): click 效果信号采集开关，透传到 dom.ts CLICK handler
        if (o.observeEffect !== undefined) next.observeEffect = o.observeEffect;
        if (o.windowMs !== undefined) next.windowMs = o.windowMs;
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
      // P1: scroll(boolean)随 ...rest 透传到 content.getText（同 selector/tabId/
      // frameId）；handler 读 args.scroll 决定提取前是否 scroll-until-settled。
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
        case "info": {
          // Default to all-tabs summary so the agent sees siblings without an extra call.
          if (next.includeAllTabs === undefined) next.includeAllTabs = true;
          return { action: "page.info", params: next };
        }
        case "custom": {
          // value: a JS expression evaluated repeatedly until truthy or timeout.
          // Use cases idle/element cannot express:
          //   - Alpine.js mount: 'document.body._x_dataStack && _x_dataStack.length > 0'
          //   - Vue/React global ready flag: 'window.__APP_READY__ === true'
          //   - LocalStorage-driven boot: 'JSON.parse(localStorage.user || "null") != null'
          if (typeof value !== "string" || !value.trim()) {
            throw vtxError(
              VtxErrorCode.INVALID_PARAMS,
              "wait_for(mode=custom): value must be a non-empty JS expression string.",
            );
          }
          next.expression = value;
          return { action: "page.waitForExpression", params: next };
        }
        default:
          throw vtxError(
            VtxErrorCode.INVALID_PARAMS,
            `wait_for: mode must be one of element|idle|info|custom, got ${String(mode)}`,
          );
      }
    }
    case "vortex_debug_read": {
      const { source, filter, tail, ...rest } = params;
      const next: Record<string, unknown> = { ...rest };
      // B3-8: network source 必须有 pattern (top-level 或 filter.pattern), 避免 5000 条 dump
      // console source 不受约束 (console.getLogs 无 pattern 概念)
      if (source === "network") {
        const topPattern = typeof rest.pattern === "string" ? rest.pattern.trim() : "";
        const filterPattern =
          filter && typeof filter === "object" && typeof (filter as any).pattern === "string"
            ? ((filter as any).pattern as string).trim()
            : "";
        if (!topPattern && !filterPattern) {
          throw vtxError(
            VtxErrorCode.INVALID_PARAMS,
            "vortex_debug_read source=network: pattern is required " +
              "(pass top-level 'pattern' or 'filter.pattern', e.g. '/api/'). " +
              "Use a substring to avoid the 5000-entry hard cap from blowing the response.",
          );
        }
      }
      if (filter && typeof filter === "object") Object.assign(next, filter);
      if (tail !== undefined) next.limit = tail;
      const action = source === "network" ? "network.getLogs" : "console.getLogs";
      return { action, params: next };
    }
    case "vortex_storage": {
      const { op, key, value, maxLength, ...rest } = params;  // BUG-002: maxLength
      const next: Record<string, unknown> = { ...rest };
      if (key !== undefined) next.key = key;
      if (value !== undefined) next.value = value;
      if (maxLength !== undefined) next.maxLength = maxLength;  // BUG-002
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
        // B3-2 v3.3 (V2):list-keys / list-all 走 storage.getLocalStorage 并带 mode,
        // handler page-side func 内联摘要逻辑(不传 values 体积;list-all 显式 opt-in)。
        // BUG-002:list-all 也传 maxLength 让 caller 控 values 截断上限。
        case "list-keys":
          return { action: "storage.getLocalStorage", params: maxLength !== undefined ? { mode: "keys", maxLength } : { mode: "keys" } };
        case "list-all":
          return { action: "storage.getLocalStorage", params: maxLength !== undefined ? { mode: "all", maxLength } : { mode: "all" } };
        default:
          throw vtxError(
            VtxErrorCode.INVALID_PARAMS,
            `storage: op must be one of get|set|session-get|session-set|cookies-get|list-keys|list-all, got ${String(op)}`,
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
