// packages/extension/src/handlers/query.ts
// vortex_query 零 LLM 探测 handler:text grep 页面可见文本 / css 查询元素。
// 移植自 browser-use service.py 的 _SEARCH_PAGE_JS_BODY 和 _FIND_ELEMENTS_JS_BODY,
// 按 vortex 风格重写:TypeScript + chrome.scripting.executeScript 注入。

import { QueryActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";

// ──────────────────────────────────────────────────────────────────────────────
// page-side JS 常量
//
// 注意:下面的函数字符串通过 chrome.scripting.executeScript 注入到页面 MAIN world,
// 丢失 TypeScript 模块作用域。所有变量必须内联声明在注入函数体内。
// 不能引用外部函数(参考 js.ts 的 expandHost 内联规范)。
// ──────────────────────────────────────────────────────────────────────────────

/**
 * page-side text grep 函数体。
 * 参数通过 args: [pattern, isRegex, caseSensitive, contextChars, maxResults] 注入。
 * 返回 { matches, total, has_more } 或 { error, matches: [], total: 0 }。
 */
export const textSearchFunc = (
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
  contextChars: number,
  maxResults: number,
): { matches: Array<{ match_text: string; context: string; element_path: string; char_position: number }>; total: number; has_more: boolean } | { error: string; matches: never[]; total: number } => {
  try {
    // 获取 DOM 中所有**可见**文本节点(遍历 body 下 text node,连接成一段大字符串)。
    // 裸 SHOW_TEXT 会把 <script>/<style>/<noscript>/<template> 的源码文本与 display:none
    // 隐藏元素的文本一并计入,违背 mode=text 的 "visible text" 契约 → 对内联 <script> 等
    // 产生假匹配(2026-06-14 真实站评测 the-internet/javascript_alerts)。acceptNode 过滤:
    //  ① 标记型不可见容器(script/style/noscript/template)的文本一律剔除;
    //  ② display:none / visibility:hidden / 祖先隐藏 由 Element.checkVisibility() 兜底
    //     (Chrome 105+);老环境无此 API 时跳过该判定,保持向后兼容(不误杀可见文本)。
    const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
    let fullText = "";
    const nodeOffsets: Array<{ offset: number; length: number; node: Node }> = [];
    // 穿 open shadow:每个 root 用 TreeWalker 高效遍历自身 light 文本,再对其内
    // shadow host 递归(深度封顶 8,与 observe querySelectorAllDeep 同语义)。
    // 旧实现仅 createTreeWalker(document.body) 不下降 shadow root → web-component
    // 页面 shadow 内文本被静默漏抓(text total:0,无信号)。closed shadow 的
    // shadowRoot 返 null 天然不穿。顺序:light 文本在前、各 shadow root 文本顺次追加
    // (同 querySelectorAllDeep 的 light-先/shadow-后);grep 上下文与 element_path
    // 按 nodeOffsets 解析,不依赖严格文档序。
    const SHADOW_WALK_MAX_DEPTH = 8;
    const collectRoot = (root: Document | ShadowRoot | Element, depth: number): void => {
      const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
        acceptNode(n: Node): number {
          const parent = (n as Text).parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TEXT_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          const cv = (parent as unknown as { checkVisibility?: () => boolean }).checkVisibility;
          if (typeof cv === "function" && !cv.call(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent;
        if (text && text.trim()) {
          nodeOffsets.push({ offset: fullText.length, length: text.length, node });
          fullText += text;
        }
      }
      if (depth >= SHADOW_WALK_MAX_DEPTH) return;
      for (const host of (root as Document | ShadowRoot).querySelectorAll("*")) {
        const sr = (host as HTMLElement).shadowRoot;
        if (sr) collectRoot(sr, depth + 1);
      }
    };
    collectRoot(document.body, 0);

    let re: RegExp;
    try {
      const flags = caseSensitive ? "g" : "gi";
      if (isRegex) {
        re = new RegExp(pattern, flags);
      } else {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      }
    } catch (e) {
      return { error: "Invalid regex pattern: " + (e instanceof Error ? e.message : String(e)), matches: [], total: 0 };
    }

    // 辅助:取元素 path 描述(如 div#main > p.content)
    const getPath = (el: Element | null): string => {
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.body && current !== (document as unknown as Element)) {
        let desc = current.tagName ? current.tagName.toLowerCase() : "";
        if (!desc) break;
        if (current.id) {
          desc += "#" + current.id;
        } else if (current.className && typeof current.className === "string") {
          const classes = current.className.trim().split(/\s+/).slice(0, 2).join(".");
          if (classes) desc += "." + classes;
        }
        parts.unshift(desc);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };

    const matches: Array<{ match_text: string; context: string; element_path: string; char_position: number }> = [];
    let match: RegExpExecArray | null;
    let totalFound = 0;

    while ((match = re.exec(fullText)) !== null) {
      totalFound++;
      if (matches.length < maxResults) {
        const start = Math.max(0, match.index - contextChars);
        const end = Math.min(fullText.length, match.index + match[0].length + contextChars);
        const ctx = fullText.slice(start, end);
        let elementPath = "";
        for (const no of nodeOffsets) {
          if (no.offset <= match.index && no.offset + no.length > match.index) {
            elementPath = getPath((no.node as Text).parentElement);
            break;
          }
        }
        matches.push({
          match_text: match[0],
          context: (start > 0 ? "..." : "") + ctx + (end < fullText.length ? "..." : ""),
          element_path: elementPath,
          char_position: match.index,
        });
      }
      // 防止零长匹配死循环
      if (match[0].length === 0) re.lastIndex++;
    }

    return { matches, total: totalFound, has_more: totalFound > maxResults };
  } catch (e) {
    return { error: "text search error: " + (e instanceof Error ? e.message : String(e)), matches: [], total: 0 };
  }
};

/**
 * page-side CSS find 函数体。
 * 参数通过 args: [selector, attributes, maxResults, includeText] 注入。
 * 返回 { elements, total, showing } 或 { error, elements: [], total: 0 }。
 */
export const cssQueryFunc = (
  selector: string,
  attributes: string[] | null,
  maxResults: number,
  includeText: boolean,
): {
  elements: Array<{ index: number; tag: string; text?: string; attrs?: Record<string, string>; children_count: number }>;
  total: number;
  showing: number;
} | { error: string; elements: never[]; total: number } => {
  try {
    // 穿 open shadow 深度遍历,与 observe 的 querySelectorAllDeep 同语义(98b61e5):
    // document.querySelectorAll 只查 light DOM,web-component 页面 shadow 内元素被
    // 静默漏计(css total 偏小,无 error 无信号)。closed shadow 的 shadowRoot 返
    // null 天然不穿,与 observe 一致。⚠ 内联副本(注入 page-side 丢模块作用域),
    // 逻辑须与 observe.ts querySelectorAllDeep 保持一致,改一处须同步。
    const SHADOW_WALK_MAX_DEPTH = 8;
    const queryAllDeep = (sel: string, root: Document | ShadowRoot, depth: number): Element[] => {
      const acc: Element[] = Array.from(root.querySelectorAll(sel));
      if (depth >= SHADOW_WALK_MAX_DEPTH) return acc;
      for (const host of root.querySelectorAll("*")) {
        const sr = (host as HTMLElement).shadowRoot;
        if (sr) acc.push(...queryAllDeep(sel, sr, depth + 1));
      }
      return acc;
    };
    let elements: Element[];
    try {
      elements = queryAllDeep(selector, document, 0);
    } catch (e) {
      return { error: "Invalid CSS selector: " + (e instanceof Error ? e.message : String(e)), elements: [], total: 0 };
    }

    const total = elements.length;
    const limit = Math.min(total, maxResults);
    const results: Array<{ index: number; tag: string; text?: string; attrs?: Record<string, string>; children_count: number }> = [];

    for (let i = 0; i < limit; i++) {
      const el = elements[i];
      const item: { index: number; tag: string; text?: string; attrs?: Record<string, string>; children_count: number } = {
        index: i,
        tag: el.tagName.toLowerCase(),
        children_count: el.children.length,
      };

      if (includeText) {
        const text = (el.textContent || "").trim();
        item.text = text.length > 300 ? text.slice(0, 300) + "..." : text;
      }

      if (attributes && attributes.length > 0) {
        item.attrs = {};
        for (const attrName of attributes) {
          let val: string | null;
          // src/href 用 DOM property 取绝对 URL
          if (
            (attrName === "src" || attrName === "href") &&
            typeof (el as HTMLAnchorElement)[attrName as "href"] === "string" &&
            (el as HTMLAnchorElement)[attrName as "href"] !== ""
          ) {
            val = (el as HTMLAnchorElement)[attrName as "href"];
          } else {
            val = el.getAttribute(attrName);
          }
          if (val !== null) {
            item.attrs![attrName] = val.length > 500 ? val.slice(0, 500) + "..." : val;
          }
        }
      }

      results.push(item);
    }

    return { elements: results, total, showing: limit };
  } catch (e) {
    return { error: "css query error: " + (e instanceof Error ? e.message : String(e)), elements: [], total: 0 };
  }
};

/**
 * page-side 组件探测函数体。mode=component 注入到 MAIN world。
 * 参数 args: [selector, componentDepth, maxResults]。
 * 返回 { components, total, showing } 或 { error, components: [], total: 0 }。
 *
 * ⚠ 自包含:注入丢模块作用域,queryAllDeep / safeSerialize 必须内联。
 * queryAllDeep 逻辑须与 cssQueryFunc / observe.ts 保持一致(改一处同步)。
 */
export const componentInspectFunc = (
  selector: string,
  componentDepth: number,
  maxResults: number,
):
  | {
      components: Array<{
        framework: "vue2" | "vue3" | "react" | "unknown";
        chain: Array<{ name: string; data: unknown; props: unknown }>;
        row?: { rowKey: string | number | null; row: unknown; index: number };
      }>;
      total: number;
      showing: number;
    }
  | { error: string; components: never[]; total: number } => {
  try {
    const SHADOW_WALK_MAX_DEPTH = 8;
    const queryAllDeep = (sel: string, root: Document | ShadowRoot, depth: number): Element[] => {
      const acc: Element[] = Array.from(root.querySelectorAll(sel));
      if (depth >= SHADOW_WALK_MAX_DEPTH) return acc;
      for (const host of root.querySelectorAll("*")) {
        const sr = (host as HTMLElement).shadowRoot;
        if (sr) acc.push(...queryAllDeep(sel, sr, depth + 1));
      }
      return acc;
    };

    // 内联 safeSerialize:深度4 / 数组100 / 节点5000 / 剥响应式 / getter兜底。
    const MAX_DEPTH = 4;
    const ARRAY_CAP = 100;
    const NODE_CAP = 5000;
    const safeSerialize = (value: unknown, maxDepth: number): unknown => {
      const seen = new WeakSet<object>();
      let nodes = 0;
      const walk = (v: unknown, depth: number): unknown => {
        if (nodes > NODE_CAP) return "[MaxNodes]";
        nodes++;
        if (v === null || v === undefined) return null;
        const t = typeof v;
        if (t === "function") return "[Function]";
        if (t === "string" || t === "number" || t === "boolean") return v;
        if (t === "bigint") return String(v);
        if (t === "symbol") return "[Symbol]";
        if (typeof Node !== "undefined" && v instanceof Node) return "[Element]";
        if (depth >= maxDepth) return "[MaxDepth]";
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
        try {
          if (Array.isArray(v)) {
            const arr: unknown[] = [];
            const cap = Math.min(v.length, ARRAY_CAP);
            for (let i = 0; i < cap; i++) arr.push(walk(v[i], depth + 1));
            if (v.length > cap) arr.push("[+" + (v.length - cap) + " more]");
            return arr;
          }
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(v as object)) {
            if (key === "__ob__" || key.indexOf("__v_") === 0) continue;
            try {
              out[key] = walk((v as Record<string, unknown>)[key], depth + 1);
            } catch {
              out[key] = "[Unserializable]";
            }
          }
          return out;
        } finally {
          seen.delete(v as object);
        }
      };
      return walk(value, 0);
    };

    // 占位:行探测(Task 2 实现)。本 Task 恒返 undefined。
    const detectRow = (
      _startEl: Element,
      _framework: string,
      _startInstance: unknown,
    ): { rowKey: string | number | null; row: unknown; index: number } | undefined => undefined;

    const reactFiberKey = (el: Element): string | null => {
      for (const k of Object.keys(el)) {
        if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) return k;
      }
      return null;
    };

    // 从命中元素向上找最近的框架实例边界(最多 30 层)。
    const findBoundary = (
      el: Element,
    ): { framework: "vue2" | "vue3" | "react" | "unknown"; instance: unknown } => {
      let cur: Element | null = el;
      let hops = 0;
      while (cur && hops < 30) {
        const anyEl = cur as unknown as Record<string, unknown>;
        if (anyEl.__vue__) return { framework: "vue2", instance: anyEl.__vue__ };
        if (anyEl.__vueParentComponent) return { framework: "vue3", instance: anyEl.__vueParentComponent };
        const fk = reactFiberKey(cur);
        if (fk) return { framework: "react", instance: anyEl[fk] };
        cur = cur.parentElement;
        hops++;
      }
      return { framework: "unknown", instance: null };
    };

    const walkChain = (
      framework: string,
      instance: unknown,
      depth: number,
    ): Array<{ name: string; data: unknown; props: unknown }> => {
      const chain: Array<{ name: string; data: unknown; props: unknown }> = [];
      if (framework === "vue2") {
        let inst = instance as any;
        while (inst && chain.length < depth) {
          chain.push({
            name: (inst.$options && (inst.$options.name || inst.$options._componentTag)) || "(anonymous)",
            data: safeSerialize(inst._data, MAX_DEPTH),
            props: safeSerialize(inst.$props, MAX_DEPTH),
          });
          inst = inst.$parent;
        }
      } else if (framework === "vue3") {
        let vnode = instance as any;
        while (vnode && chain.length < depth) {
          chain.push({
            name: (vnode.type && (vnode.type.name || vnode.type.__name)) || "(anonymous)",
            data: safeSerialize(vnode.setupState, MAX_DEPTH),
            props: safeSerialize(vnode.props, MAX_DEPTH),
          });
          vnode = vnode.parent;
        }
      } else if (framework === "react") {
        let fiber = instance as any;
        while (fiber && chain.length < depth) {
          const ty = fiber.type;
          if (typeof ty === "function") {
            chain.push({
              name: ty.displayName || ty.name || "(anonymous)",
              data: safeSerialize(fiber.memoizedState, MAX_DEPTH),
              props: safeSerialize(fiber.memoizedProps, MAX_DEPTH),
            });
          }
          fiber = fiber.return;
        }
      }
      return chain;
    };

    let matched: Element[];
    try {
      matched = queryAllDeep(selector, document, 0);
    } catch (e) {
      return { error: "Invalid CSS selector: " + (e instanceof Error ? e.message : String(e)), components: [], total: 0 };
    }

    const total = matched.length;
    const limit = Math.min(total, maxResults);
    const components: Array<{
      framework: "vue2" | "vue3" | "react" | "unknown";
      chain: Array<{ name: string; data: unknown; props: unknown }>;
      row?: { rowKey: string | number | null; row: unknown; index: number };
    }> = [];

    for (let i = 0; i < limit; i++) {
      const el = matched[i];
      const { framework, instance } = findBoundary(el);
      const chain = walkChain(framework, instance, componentDepth);
      const entry: {
        framework: "vue2" | "vue3" | "react" | "unknown";
        chain: Array<{ name: string; data: unknown; props: unknown }>;
        row?: { rowKey: string | number | null; row: unknown; index: number };
      } = { framework, chain };
      const row = detectRow(el, framework, instance);
      if (row) entry.row = row;
      components.push(entry);
    }

    return { components, total, showing: limit };
  } catch (e) {
    return { error: "component inspect error: " + (e instanceof Error ? e.message : String(e)), components: [], total: 0 };
  }
};

export function registerQueryHandlers(router: ActionRouter): void {
  router.registerAll({
    [QueryActions.QUERY_PAGE]: async (args, tabId) => {
      const mode = args.mode as string | undefined;
      const pattern = args.pattern as string | undefined;

      // 参数校验
      if (!mode || (mode !== "text" && mode !== "css")) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `vortex_query: mode must be 'text' or 'css', got ${String(mode)}`,
        );
      }
      if (!pattern || typeof pattern !== "string" || !pattern.trim()) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          "vortex_query: pattern is required and must be a non-empty string",
        );
      }

      const tid = await getActiveTabId((args.tabId as number | undefined) ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      if (mode === "text") {
        // text grep 模式
        const isRegex = (args.isRegex as boolean | undefined) ?? false;
        const caseSensitive = (args.caseSensitive as boolean | undefined) ?? false;
        const contextChars = (args.contextChars as number | undefined) ?? 80;
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 10, 50);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: textSearchFunc,
          args: [pattern, isRegex, caseSensitive, contextChars, maxResults],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { matches: unknown[]; total: number; has_more: boolean }
          | { error: string; matches: never[]; total: number }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage text: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage text error: ${res.error}`);
        }
        return res;
      } else {
        // css query 模式
        const attr = args.attr as string | string[] | undefined;
        // attr 可以是单个字符串或数组
        const attributes: string[] | null =
          attr == null
            ? null
            : Array.isArray(attr)
            ? attr
            : [attr];
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 20, 100);
        const includeText = (args.includeText as boolean | undefined) ?? true;

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: cssQueryFunc,
          args: [pattern, attributes, maxResults, includeText],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { elements: unknown[]; total: number; showing: number }
          | { error: string; elements: never[]; total: number }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage css: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage css error: ${res.error}`);
        }
        return res;
      }
    },
  });
}
