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
const textSearchFunc = (
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
  contextChars: number,
  maxResults: number,
): { matches: Array<{ match_text: string; context: string; element_path: string; char_position: number }>; total: number; has_more: boolean } | { error: string; matches: never[]; total: number } => {
  try {
    // 获取 DOM 中所有可见文本节点(遍历 body 下全部 text node,连接成一段大字符串)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let fullText = "";
    const nodeOffsets: Array<{ offset: number; length: number; node: Node }> = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent;
      if (text && text.trim()) {
        nodeOffsets.push({ offset: fullText.length, length: text.length, node });
        fullText += text;
      }
    }

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
const cssQueryFunc = (
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
    let elements: NodeListOf<Element>;
    try {
      elements = document.querySelectorAll(selector);
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
