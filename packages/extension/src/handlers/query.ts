// packages/extension/src/handlers/query.ts
// vortex_query 零 LLM 探测 handler:text grep 页面可见文本 / css 查询元素。
// 移植自 browser-use service.py 的 _SEARCH_PAGE_JS_BODY 和 _FIND_ELEMENTS_JS_BODY,
// 按 vortex 风格重写:TypeScript + chrome.scripting.executeScript 注入。

import { QUERY_SELECTOR_MODES, QueryActions, VtxErrorCode, vtxError, withDiagnosis } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";
import { diagnoseEmptyQueryText, diagnoseEmptyQueryCss, diagnoseEmptySchema } from "../lib/empty-diagnosis.js";
import { resolveTargetOptional } from "../lib/resolve-target.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { fetchPlatformFonts } from "../lib/platform-fonts.js";
import { aggregateFontFaces, buildFontEvidence, isPseudoRendered } from "../lib/style-evidence.js";

type TextScan = { chars: number; nodes: number; shadowRoots: number; iframes: number };
type CssScan = { elements: number; shadowRoots: number; iframes: number };

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
): { matches: Array<{ match_text: string; context: string; element_path: string; char_position: number }>; total: number; has_more: boolean; scanned: { chars: number; nodes: number; shadowRoots: number; iframes: number } } | { error: string; matches: never[]; total: number } => {
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
    // 零命中时调用方需要知道"搜了多大范围"才能判断该换 pattern 还是换 frame。
    let shadowRootsSeen = 0;
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
        if (sr) {
          shadowRootsSeen++;
          collectRoot(sr, depth + 1);
        }
      }
    };
    collectRoot(document.body, 0);
    // executeScript 不带 frameIds 时只跑顶层 frame(allFrames 默认 false),
    // 同页 iframe 的文本静默不在搜索范围内 —— 这是零命中最常见的隐形原因。
    const scanned = {
      chars: fullText.length,
      nodes: nodeOffsets.length,
      shadowRoots: shadowRootsSeen,
      iframes: document.querySelectorAll("iframe,frame").length,
    };

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

    return { matches, total: totalFound, has_more: totalFound > maxResults, scanned };
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
  scanned: { elements: number; shadowRoots: number; iframes: number };
} | { error: string; elements: never[]; total: number } => {
  try {
    // 穿 open shadow 深度遍历,与 observe 的 querySelectorAllDeep 同语义(98b61e5):
    // document.querySelectorAll 只查 light DOM,web-component 页面 shadow 内元素被
    // 静默漏计(css total 偏小,无 error 无信号)。closed shadow 的 shadowRoot 返
    // null 天然不穿,与 observe 一致。⚠ 内联副本(注入 page-side 丢模块作用域),
    // 逻辑须与 observe.ts querySelectorAllDeep 保持一致,改一处须同步。
    const SHADOW_WALK_MAX_DEPTH = 8;
    // 零命中时自报扫描规模,顺带数下没被搜到的同页 iframe(executeScript 只跑顶层 frame)。
    let scannedElements = 0;
    let shadowRootsSeen = 0;
    const queryAllDeep = (sel: string, root: Document | ShadowRoot, depth: number): Element[] => {
      const acc: Element[] = Array.from(root.querySelectorAll(sel));
      if (depth >= SHADOW_WALK_MAX_DEPTH) return acc;
      const all = root.querySelectorAll("*");
      scannedElements += all.length;
      for (const host of all) {
        const sr = (host as HTMLElement).shadowRoot;
        if (sr) {
          shadowRootsSeen++;
          acc.push(...queryAllDeep(sel, sr, depth + 1));
        }
      }
      return acc;
    };
    let elements: Element[];
    try {
      elements = queryAllDeep(selector, document, 0);
    } catch (e) {
      return { error: "Invalid CSS selector: " + (e instanceof Error ? e.message : String(e)), elements: [], total: 0 };
    }
    const scanned = {
      elements: scannedElements,
      shadowRoots: shadowRootsSeen,
      iframes: document.querySelectorAll("iframe,frame").length,
    };

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
          } else if (
            // value/checked/selected 是 form 控件的 live DOM property,用户输入/JS 赋值不反射为
            // HTML attribute → getAttribute 常返 null(实测 log.bytenew.com 日期/关键词框读空)。
            // 对 input/textarea/select/option 优先读 property(布尔 → "true"/"false"),回退 attribute。
            (attrName === "value" || attrName === "checked" || attrName === "selected") &&
            /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)
          ) {
            const prop = (el as unknown as Record<string, unknown>)[attrName];
            val =
              typeof prop === "boolean"
                ? String(prop)
                : typeof prop === "string"
                  ? prop
                  : el.getAttribute(attrName);
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

    return { elements: results, total, showing: limit, scanned };
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

    // 内联序列化:深度3 / 数组40 / 剥响应式 / getter兜底。
    // makeSerializer 工厂:每个 serializer 各带 per-call 上限,且共享一个全局节点预算
    // (globalBudget),容器循环内命中预算即 break。杜绝在真实应用上展开庞大组件 _data
    // 导致输出爆炸(实机 spike:vxe-table cell 曾吐 10万字符超 token 限)。
    const MAX_DEPTH = 3;
    const ARRAY_CAP = 40;
    const globalBudget = { n: 0, cap: 3000 };
    const makeSerializer = (perCallCap: number): ((value: unknown) => unknown) => {
      const seen = new WeakSet<object>();
      let local = 0;
      const over = (): boolean => globalBudget.n >= globalBudget.cap || local >= perCallCap;
      const walk = (v: unknown, depth: number): unknown => {
        if (over()) return "[Budget]";
        globalBudget.n++; local++;
        if (v === null || v === undefined) return null;
        const t = typeof v;
        if (t === "function") return "[Function]";
        if (t === "string" || t === "number" || t === "boolean") return v;
        if (t === "bigint") return String(v);
        if (t === "symbol") return "[Symbol]";
        if (typeof Node !== "undefined" && v instanceof Node) return "[Element]";
        if (depth >= MAX_DEPTH) return "[MaxDepth]";
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
        try {
          if (Array.isArray(v)) {
            const arr: unknown[] = [];
            const cap = Math.min(v.length, ARRAY_CAP);
            for (let i = 0; i < cap; i++) {
              if (over()) { arr.push("[Budget]"); break; }
              arr.push(walk(v[i], depth + 1));
            }
            if (v.length > cap) arr.push("[+" + (v.length - cap) + " more]");
            return arr;
          }
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(v as object)) {
            if (over()) { out.__vtxTruncated__ = "[Budget]"; break; }
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
      return (value: unknown): unknown => walk(value, 0);
    };

    // 行探测:vxe-table(VxeTable.getRowById,实机确认 ipaas 用 vxe 非 el-table) /
    // el-table(Vue2 读 store.states.data + DOM tr 索引) / antd Table(React fiber memoizedProps.record)。
    // vxe:tr[rowid] + getRowById 抗虚拟滚动/固定列(不依赖 DOM 索引,实机 2026-06-26 验证)。
    // el-table 固定列会复制 tr,DOM 索引法对带 fixed 列的表可能偏移。
    const detectRow = (
      startEl: Element,
      framework: string,
      startInstance: unknown,
      ser: (v: unknown) => unknown,
    ): { rowKey: string | number | null; row: unknown; index: number } | undefined => {
      try {
        if (framework === "vue2") {
          // ① vxe-table:上溯找 VxeTable 实例,用 tr[rowid] + getRowById 取行
          let vxe: any = startInstance;
          let vg = 0;
          while (vxe && vg < 50) {
            const nm = vxe.$options && (vxe.$options.name || vxe.$options._componentTag);
            if (nm === "VxeTable") break;
            vxe = vxe.$parent;
            vg++;
          }
          if (vxe && typeof vxe.getRowById === "function") {
            const tr = (startEl as Element).closest ? (startEl as Element).closest("tr[rowid]") : null;
            const rowid = tr ? tr.getAttribute("rowid") : null;
            if (rowid != null) {
              const rowObj = vxe.getRowById(rowid);
              if (rowObj && typeof rowObj === "object") {
                let index = -1;
                try { if (typeof vxe.getRowIndex === "function") index = vxe.getRowIndex(rowObj); } catch { /* ignore */ }
                return { rowKey: rowid, row: ser(rowObj), index };
              }
            }
          }
          // ② el-table(best-effort,非硬保证):上溯找 ElTable,读 store.states.data + DOM tr 索引。
          // ⚠ 仅单 tbody 理想化 mock 测过,未经真实「固定列」el-table 实机验证——固定列会渲染
          // 独立 table/tbody,closest("tr")+同级 TR 索引在多 body 场景可能取错行(错行比缺省更糟)。
          // 真实硬保证目标是 vxe(getRowById,不依赖 DOM 索引);el-table 站点须实机校准后才可信。
          let inst = startInstance as any;
          let table: any = null;
          let guard = 0;
          while (inst && guard < 50) {
            const nm = inst.$options && (inst.$options.name || inst.$options._componentTag);
            if (nm === "ElTable") { table = inst; break; }
            inst = inst.$parent;
            guard++;
          }
          if (!table || !table.store || !table.store.states || !Array.isArray(table.store.states.data)) return undefined;
          const data = table.store.states.data as unknown[];
          const tr = (startEl as Element).closest ? (startEl as Element).closest("tr") : null;
          if (!tr || !tr.parentElement) return undefined;
          const rows = Array.prototype.filter.call(tr.parentElement.children, (c: Element) => c.tagName === "TR") as Element[];
          const index = rows.indexOf(tr);
          if (index < 0 || index >= data.length) return undefined;
          const rowObj = data[index];
          const rowKeyProp = (table.rowKey || (table.$props && table.$props.rowKey)) as string | undefined;
          let rowKey: string | number | null = null;
          if (typeof rowKeyProp === "string" && rowObj && typeof rowObj === "object") {
            const v = (rowObj as Record<string, unknown>)[rowKeyProp];
            if (typeof v === "string" || typeof v === "number") rowKey = v;
          }
          return { rowKey, row: ser(rowObj), index };
        }
        if (framework === "react") {
          // best-effort:沿 fiber.return 上溯找带 record/row/rowData 的祖先即视为行。
          // ⚠ 误报边界:非表格上下文(如 <DetailCard record={...}/>)也可能产出伪 row;
          // 由「最近命中优先 + 表格语义字段名」缓解,但不保证 100% 准。
          let fiber = startInstance as any;
          let hops = 0;
          while (fiber && hops < 40) {
            const p = fiber.memoizedProps;
            if (p && typeof p === "object") {
              const rec = p.record !== undefined ? p.record : (p.row !== undefined ? p.row : p.rowData);
              if (rec !== undefined && rec !== null && typeof rec === "object") {
                // rowKey: 优先 fiber props,再回退 record 自带 key/id。实机(antd)发现
                // record 在 cell fiber 而 rowKey 在上层 row fiber,故 cell 命中时 props
                // 无 rowKey → 回退 record.key(antd 行键惯例)/record.id。
                const r = rec as Record<string, unknown>;
                let rowKey: string | number | null = null;
                if (typeof p.rowKey === "string" || typeof p.rowKey === "number") rowKey = p.rowKey;
                else if (typeof p["data-row-key"] === "string" || typeof p["data-row-key"] === "number") rowKey = p["data-row-key"];
                else if (typeof r.key === "string" || typeof r.key === "number") rowKey = r.key as string | number;
                else if (typeof r.id === "string" || typeof r.id === "number") rowKey = r.id as string | number;
                const index = typeof p.index === "number" ? p.index : -1;
                return { rowKey, row: ser(rec), index };
              }
            }
            fiber = fiber.return;
            hops++;
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    };

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
      ser: (v: unknown) => unknown,
    ): Array<{ name: string; data: unknown; props: unknown }> => {
      const chain: Array<{ name: string; data: unknown; props: unknown }> = [];
      if (framework === "vue2") {
        let inst = instance as any;
        while (inst && chain.length < depth) {
          chain.push({
            name: (inst.$options && (inst.$options.name || inst.$options._componentTag)) || "(anonymous)",
            data: ser(inst._data),
            props: ser(inst.$props),
          });
          inst = inst.$parent;
        }
      } else if (framework === "vue3") {
        let vnode = instance as any;
        while (vnode && chain.length < depth) {
          chain.push({
            name: (vnode.type && (vnode.type.name || vnode.type.__name)) || "(anonymous)",
            data: ser(vnode.setupState),
            props: ser(vnode.props),
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
              // data 为 React hook 链表原始结构(memoizedState/next/queue),首发只取浅层
              // (深度3+预算有界),语义噪声较大;深度解析 hooks 留 backlog。
              data: ser(fiber.memoizedState),
              props: ser(fiber.memoizedProps),
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

    // 边界只解析一次。
    const boundaries: Array<{ el: Element; framework: "vue2" | "vue3" | "react" | "unknown"; instance: unknown }> = [];
    for (let i = 0; i < limit; i++) {
      const el = matched[i];
      boundaries.push({ el, ...findBoundary(el) });
    }
    // 两遍共享同一 globalBudget:① 所有元素的 row 先序列化(row 是首要交付物,优先吃预算,
    // 行对象小、全部能进);② 再 chain(次要)吃余额。避免单遍时靠后元素的 row 被前面元素的
    // 重组件 chain 把全局预算耗尽而静默饿死(I-2)。
    const rows = boundaries.map((b) => detectRow(b.el, b.framework, b.instance, makeSerializer(800)));
    const components: Array<{
      framework: "vue2" | "vue3" | "react" | "unknown";
      chain: Array<{ name: string; data: unknown; props: unknown }>;
      row?: { rowKey: string | number | null; row: unknown; index: number };
    }> = boundaries.map((b, i) => {
      const chain = walkChain(b.framework, b.instance, componentDepth, makeSerializer(400));
      const entry: {
        framework: "vue2" | "vue3" | "react" | "unknown";
        chain: Array<{ name: string; data: unknown; props: unknown }>;
        row?: { rowKey: string | number | null; row: unknown; index: number };
      } = { framework: b.framework, chain };
      if (rows[i]) entry.row = rows[i];
      return entry;
    });

    return { components, total, showing: limit };
  } catch (e) {
    return { error: "component inspect error: " + (e instanceof Error ? e.message : String(e)), components: [], total: 0 };
  }
};

/**
 * page-side 几何探测函数体。mode=geometry 注入 MAIN world。
 * 回答「看似视觉、实可几何化」的布局问题(① 实证:observe 给 ref 不给 bbox/视口/遮挡):
 *  - bbox / inViewport(完整在视口内)
 *  - occluded(中心点 elementFromPoint 命中非自身/后代 → 被浮层遮挡)+ occludedBy
 *  - textClipped(scrollWidth>clientWidth → 文字 ellipsis)vs clippedByAncestor(超出 overflow 祖先可视框 → 布局裁剪)
 *    —— 区分「列被容器裁剪」与「仅文字省略」(截图会把二者混为一谈,① 实证)
 *  - pair(命中前两个元素时):overlap / 上下左右关系 / 六类对齐(左右上下+水平/垂直居中)
 * 参数 args: [selector, maxResults]。⚠ 自包含:注入丢模块作用域,queryAllDeep 必须内联。
 */
export const geometryProbeFunc = (
  selector: string,
  maxResults: number,
):
  | {
      viewport: { w: number; h: number };
      elements: Array<{
        index: number;
        tag: string;
        bbox: [number, number, number, number];
        inViewport: boolean;
        occluded: boolean;
        occludedBy?: string;
        textClipped: boolean;
        clippedByAncestor: boolean;
      }>;
      pair?: {
        overlap: boolean;
        aAboveB: boolean;
        aBelowB: boolean;
        aLeftOfB: boolean;
        aRightOfB: boolean;
        sameLeft: boolean;
        sameTop: boolean;
        sameRight: boolean;
        sameBottom: boolean;
        sameHCenter: boolean;
        sameVCenter: boolean;
      };
      total: number;
      showing: number;
    }
  | { error: string } => {
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

    let matched: Element[];
    try {
      matched = queryAllDeep(selector, document, 0);
    } catch (e) {
      return { error: "Invalid CSS selector: " + (e instanceof Error ? e.message : String(e)) };
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const R = (n: number): number => Math.round(n);
    const TOL = 2; // 对齐/越界容差(px)

    const desc = (el: Element | null): string => {
      if (!el) return "?";
      let s = el.tagName ? el.tagName.toLowerCase() : "?";
      if ((el as HTMLElement).id) s += "#" + (el as HTMLElement).id;
      else if (typeof (el as HTMLElement).className === "string" && (el as HTMLElement).className.trim()) {
        s += "." + (el as HTMLElement).className.trim().split(/\s+/)[0];
      }
      return s;
    };

    const total = matched.length;
    const limit = Math.min(total, maxResults);
    const rects: DOMRect[] = [];
    const elements = [];
    for (let i = 0; i < limit; i++) {
      const el = matched[i] as HTMLElement;
      const r = el.getBoundingClientRect();
      rects.push(r);
      const inViewport = r.left >= -TOL && r.top >= -TOL && r.right <= vw + TOL && r.bottom <= vh + TOL;

      // 遮挡:中心点 elementFromPoint 命中非自身/非后代 → 被压在上面。
      let occluded = false;
      let occludedBy: string | undefined;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const top = typeof document.elementFromPoint === "function" ? document.elementFromPoint(cx, cy) : null;
      if (top && top !== el && !el.contains(top)) {
        occluded = true;
        occludedBy = desc(top);
      }

      // 文字 ellipsis:内容宽超过可视宽(非布局裁剪,只是文字省略号)。
      const textClipped = el.scrollWidth > el.clientWidth + TOL;

      // 布局裁剪:元素被最近 overflow(hidden/auto/scroll)祖先的可视框切掉。
      let clippedByAncestor = false;
      for (let a: HTMLElement | null = el.parentElement, j = 0; a && j < 12; j++, a = a.parentElement) {
        const ov = (() => {
          try {
            const cs = getComputedStyle(a);
            return cs.overflow + " " + cs.overflowX + " " + cs.overflowY;
          } catch {
            return "";
          }
        })();
        if (/hidden|auto|scroll|clip/.test(ov)) {
          const ar = a.getBoundingClientRect();
          if (r.right > ar.right + TOL || r.bottom > ar.bottom + TOL || r.left < ar.left - TOL || r.top < ar.top - TOL) {
            clippedByAncestor = true;
          }
          break; // 只看最近的裁剪祖先
        }
      }

      elements.push({
        index: i,
        tag: el.tagName.toLowerCase(),
        bbox: [R(r.left), R(r.top), R(r.width), R(r.height)] as [number, number, number, number],
        inViewport,
        occluded,
        ...(occludedBy ? { occludedBy } : {}),
        textClipped,
        clippedByAncestor,
      });
    }

    const out: {
      viewport: { w: number; h: number };
      elements: typeof elements;
      pair?: {
        overlap: boolean;
        aAboveB: boolean;
        aBelowB: boolean;
        aLeftOfB: boolean;
        aRightOfB: boolean;
        sameLeft: boolean;
        sameTop: boolean;
        sameRight: boolean;
        sameBottom: boolean;
        sameHCenter: boolean;
        sameVCenter: boolean;
      };
      total: number;
      showing: number;
    } = { viewport: { w: vw, h: vh }, elements, total, showing: limit };

    if (rects.length >= 2) {
      const a = rects[0];
      const b = rects[1];
      const near = (x: number, y: number): boolean => Math.abs(x - y) <= TOL;
      out.pair = {
        overlap: !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom),
        aAboveB: a.bottom <= b.top + TOL,
        aBelowB: a.top >= b.bottom - TOL,
        aLeftOfB: a.right <= b.left + TOL,
        aRightOfB: a.left >= b.right - TOL,
        sameLeft: near(a.left, b.left),
        sameTop: near(a.top, b.top),
        sameRight: near(a.right, b.right),
        sameBottom: near(a.bottom, b.bottom),
        sameHCenter: near(a.left + a.width / 2, b.left + b.width / 2),
        sameVCenter: near(a.top + a.height / 2, b.top + b.height / 2),
      };
    }
    return out;
  } catch (e) {
    return { error: "geometry probe error: " + (e instanceof Error ? e.message : String(e)) };
  }
};

/** 对比度为何可判定/不可判定的唯一判据。wcagAA/AAA 只是它的派生。 */
type ContrastStatus =
  | "ok"
  | "no-painted-background"
  | "background-image"
  | "translucent"
  | "unsupported-color";

/**
 * page-side 配色/视觉态探测函数体。mode=style 注入 MAIN world。
 * 回答「配色/对比度对不对」(⑦ 实证:observe 完全不给颜色;getComputedStyle 可读但 agent 难自算——
 * 徽章背景常在祖先/伪元素、WCAG 公式易错)。每元素:color / background(透明则上溯祖先 painted bg,
 * bgFromAncestor 标记)/ fontWeight / fontSize / contrastRatio(WCAG 相对亮度比)/ wcagAA(≥4.5)/ wcagAAA(≥7)。
 * 参数 args: [selector, maxResults]。⚠ 自包含:注入丢模块作用域,queryAllDeep 必须内联。
 */
export const styleProbeFunc = (
  selector: string,
  maxResults: number,
  groups?: string[],
):
  | {
      elements: Array<{
        index: number;
        tag: string;
        color: string;
        background: string;
        backgroundImage: string;
        bgFromAncestor: boolean;
        fontWeight: string;
        fontSize: string;
        contrastRatio: number | null;
        contrastStatus: ContrastStatus;
        wcagAA: boolean | null;
        wcagAAA: boolean | null;
        typography?: Record<string, string>;
        box?: Record<string, string>;
        paint?: Record<string, string>;
        motion?: Record<string, string>;
        pseudoRaw?: Record<string, Record<string, string>>;
        declaredFont?: string;
      }>;
      total: number;
      showing: number;
      fontFaces?: Array<Record<string, string>>;
      fontFacesPartial?: boolean;
    }
  | { error: string } => {
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

    // @font-face 只能从 CSSOM 读,跨域样式表访问 cssRules 抛 SecurityError → 标 partial 而非当没有
    const collectFontFaces = (): { rules: Array<Record<string, string>>; partial: boolean } => {
      const FACE_PROPS = ["font-family", "src", "font-weight", "font-style", "font-display", "unicode-range"];
      const rules: Array<Record<string, string>> = [];
      let partial = false;
      for (const sheet of Array.from(document.styleSheets)) {
        let list: CSSRuleList | null = null;
        try {
          list = sheet.cssRules;
        } catch {
          partial = true;
          continue;
        }
        for (const rule of Array.from(list ?? [])) {
          if (rule.constructor.name !== "CSSFontFaceRule" && (rule as CSSRule).type !== 5) continue;
          const st = (rule as unknown as { style: CSSStyleDeclaration }).style;
          const o: Record<string, string> = {};
          for (const prop of FACE_PROPS) {
            const v = st.getPropertyValue(prop);
            if (v) o[prop] = v;
          }
          if (o["font-family"]) rules.push(o);
        }
      }
      return { rules, partial };
    };

    // 解析 rgb/rgba → [r,g,b,a];无法解析返 null。
    const parse = (c: string): [number, number, number, number] | null => {
      if (!c) return null;
      const m = c.match(/-?[\d.]+/g);
      if (!m || m.length < 3) return null;
      const n = m.map(Number);
      return [n[0], n[1], n[2], n.length >= 4 ? n[3] : 1];
    };
    // 取不到 opacity 时按 1:Number("") 是 0,会把所有元素误判成半透明
    const opacityOf = (d: CSSStyleDeclaration): number => {
      const v = parseFloat(d.opacity);
      return Number.isFinite(v) ? v : 1;
    };
    // 只认完整的 rgb/rgba 数值形态:百分比与 oklch/lab 抓数字会算出胡说八道的亮度
    const RGB_RE =
      /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i;
    const parseStrict = (c: string): [number, number, number, number] | null => {
      const m = RGB_RE.exec((c || "").trim());
      if (!m) return null;
      const ch = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (ch.some((v) => v > 255)) return null;
      const a = m[4] === undefined ? 1 : Number(m[4]);
      if (!(a >= 0 && a <= 1)) return null;
      return [ch[0], ch[1], ch[2], a];
    };
    // 透明判定:无背景 / transparent / alpha=0。
    const isTransparent = (c: string): boolean => {
      if (!c || c === "transparent") return true;
      const p = parse(c);
      return p ? p[3] === 0 : true;
    };
    // WCAG 相对亮度。
    const lum = (rgb: [number, number, number, number]): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };

    let matched: Element[];
    try {
      matched = queryAllDeep(selector, document, 0);
    } catch (e) {
      return { error: "Invalid CSS selector: " + (e instanceof Error ? e.message : String(e)) };
    }

    const total = matched.length;
    const limit = Math.min(total, maxResults);
    const elements = [];
    for (let i = 0; i < limit; i++) {
      const el = matched[i] as HTMLElement;
      const cs = getComputedStyle(el);
      const color = cs.color;
      let background = cs.backgroundColor;
      let backgroundImage = cs.backgroundImage;
      let bgFromAncestor = false;
      let hasImage = backgroundImage !== "none";
      // 独立累计:被背景图分支覆盖掉就说不清真正的不可判定原因
      let translucent = opacityOf(cs) < 1;

      // 自身已绘制就不上溯:再往上的层被它盖住,不是实际背景
      if (!hasImage && isTransparent(background)) {
        // 不设层数上限:真站 painted 背景可在第 10 层,任何魔数都会漏
        for (let a: HTMLElement | null = el.parentElement; a; a = a.parentElement) {
          const acs = getComputedStyle(a);
          if (opacityOf(acs) < 1) translucent = true;
          // 第一层产生绘制的祖先就是背景层,图和色都在这层取,取完即停
          if (acs.backgroundImage !== "none") {
            backgroundImage = acs.backgroundImage;
            background = acs.backgroundColor;
            bgFromAncestor = true;
            hasImage = true;
            break;
          }
          if (!isTransparent(acs.backgroundColor)) {
            background = acs.backgroundColor;
            bgFromAncestor = true;
            break;
          }
        }
      }

      const fg = parseStrict(color);
      const bg = parseStrict(background);
      const bgTransparent = isTransparent(background);
      // alpha=0 是"没有背景"而不是"半透明",只有 0<alpha<1 才算合成
      if (fg && fg[3] > 0 && fg[3] < 1) translucent = true;
      if (bg && !bgTransparent && bg[3] < 1) translucent = true;

      let contrastStatus: ContrastStatus;
      let contrastRatio: number | null = null;
      // 优先级固定:合成 > 背景图 > 无背景 > 认不出的颜色
      if (bgTransparent && !hasImage) contrastStatus = "no-painted-background";
      else if (translucent) contrastStatus = "translucent";
      else if (hasImage) contrastStatus = "background-image";
      else if (!fg || !bg) contrastStatus = "unsupported-color";
      else {
        const L1 = lum(fg) + 0.05;
        const L2 = lum(bg) + 0.05;
        contrastRatio = Math.round((Math.max(L1, L2) / Math.min(L1, L2)) * 100) / 100;
        contrastStatus = "ok";
      }
      // null 而非 "unknown":JSON 里字符串是 truthy,外部 if(wcagAA) 会误读成通过
      const verdict = (min: number): boolean | null =>
        contrastRatio == null ? null : contrastRatio >= min;

      // 缺省=全开,空数组=一组都不要;两者不能混为一谈
      const active = groups ?? ["typography", "box", "paint", "motion", "pseudo", "font"];
      const want = (g: string): boolean => active.indexOf(g) !== -1;
      const pick = (props: string[]): Record<string, string> => {
        const o: Record<string, string> = {};
        for (const prop of props) {
          o[prop] = cs.getPropertyValue(prop.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()));
        }
        return o;
      };
      const typography = want("typography")
        ? pick(["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "textTransform"])
        : undefined;
      const box = want("box")
        ? pick(["display", "padding", "margin", "borderRadius", "borderWidth", "borderStyle", "borderColor", "width", "height"])
        : undefined;
      const paint = want("paint")
        ? pick(["backgroundColor", "backgroundImage", "boxShadow", "opacity", "outline", "filter"])
        : undefined;
      const motion = want("motion") ? pick(["transition", "transform", "animation"]) : undefined;

      // 只按 content 粗筛(能砍掉 ~98%),渲染判定在 handler 侧纯函数里,别在注入代码里分裂
      const PSEUDO_PROPS = ["content", "font-family", "color", "display", "visibility",
        "opacity", "background-image", "width", "height"];
      let pseudoRaw: Record<string, Record<string, string>> | undefined;
      if (want("pseudo")) {
        for (const which of ["::before", "::after"]) {
          const pcs = getComputedStyle(el, which);
          const c = pcs.getPropertyValue("content");
          if (c === "none" || c === "normal" || c === "") continue;
          const o: Record<string, string> = {};
          for (const prop of PSEUDO_PROPS) o[prop] = pcs.getPropertyValue(prop);
          (pseudoRaw ??= {})[which.slice(2)] = o;
        }
      }
      const declaredFont = want("font") ? cs.getPropertyValue("font-family") : undefined;

      elements.push({
        index: i,
        tag: el.tagName.toLowerCase(),
        color,
        background,
        bgFromAncestor,
        fontWeight: cs.fontWeight,
        fontSize: cs.fontSize,
        contrastRatio,
        backgroundImage,
        contrastStatus,
        wcagAA: verdict(4.5),
        wcagAAA: verdict(7),
        ...(typography ? { typography } : {}),
        ...(box ? { box } : {}),
        ...(paint ? { paint } : {}),
        ...(motion ? { motion } : {}),
        ...(pseudoRaw ? { pseudoRaw } : {}),
        ...(declaredFont !== undefined ? { declaredFont } : {}),
      });
    }

    const wantFont = (groups ?? ["typography", "box", "paint", "motion", "pseudo", "font"]).indexOf("font") !== -1;
    const faces = wantFont ? collectFontFaces() : undefined;
    return {
      elements,
      total,
      showing: limit,
      ...(faces ? { fontFaces: faces.rules, fontFacesPartial: faces.partial } : {}),
    };
  } catch (e) {
    return { error: "style probe error: " + (e instanceof Error ? e.message : String(e)) };
  }
};

/**
 * page-side 表格 readback 函数体。mode=sheet 注入 MAIN world。
 * 参数 args: [pattern(sheet 选择器), format(markdown|csv|json), maxRows]。
 * 返回 { text } 或 { error }。优先读语雀 Lake Sheet 内存模型;非语雀时 fallback 到
 * 钉钉 spreadsheetv2 检测 + activeCell(纯 canvas 表格,仅检测+地址框)。
 * ⚠ [inline sheet-readback] + [inline dingtalk-sheet]:注入丢模块作用域,locate/read/
 * serialize 必须内联;逻辑须与 src/page-side/sheet-readback.ts 真源一致(改一处须改两处),
 * query-sheet-parity.test.ts 校验。纯读,不碰 kernel.command/history/ot(只读安全)。
 */
export const sheetProbeFunc = (
  pattern: string,
  format: string,
  maxRows: number,
): { text: string } | { error: string } => {
  try {
    const doc = document;
    const container =
      doc.querySelector(".lake-sheet-canvas-container") || doc.querySelector(".lake-sheet-editor");
    if (!container) {
      // [inline dingtalk-sheet] fallback:钉钉 spreadsheetv2 是纯 canvas 表格(无 DOM 单元格),
      // 与语雀 fiber 模型不同。仅检测 + 读 activeCell(地址框 .m-formular-bar-inner,同源 iframe
      // 下钻),单元格网格读回需 collab-engine 模型尚未 live 验证 → 不臆造。逻辑须与真源
      // src/page-side/sheet-readback.ts 的 resolveDingtalkSheetDoc/readDingtalkActiveCell 一致。
      let dtDoc: Document | null = doc.querySelector(".m-formular-bar-inner") ? doc : null;
      if (!dtDoc) {
        const fr = doc.querySelector("#wiki-new-sheet-iframe") as HTMLIFrameElement | null;
        try {
          const idoc = fr && fr.contentDocument;
          if (idoc && idoc.querySelector(".m-formular-bar-inner")) dtDoc = idoc;
        } catch { /* cross-origin */ }
      }
      if (dtDoc) {
        let activeCell: string | null = null;
        const bar = dtDoc.querySelector(".m-formular-bar-inner");
        if (bar) {
          for (const el of Array.from(bar.querySelectorAll("*"))) {
            if (el.children.length === 0) {
              const t = ((el.textContent as string) || "").trim();
              if (/^[A-Z]{1,3}[0-9]{1,7}$/.test(t)) { activeCell = t; break; }
            }
          }
        }
        return { text:
          `> 检测到钉钉 canvas 电子表格(spreadsheetv2)。活动单元格: ${activeCell ?? "未知"}。\n` +
          `> 该表格纯 canvas 渲染,无 DOM 单元格模型可读回;请用 vortex_screenshot 看内容、` +
          `vortex_mouse_click 按像素点选单元格(配合 vortex_query mode=geometry 取 bbox)导航。`,
        };
      }
      return { error: "no lake-sheet on page (未找到语雀数据表；若确在表格页请等待加载，或用 vortex_screenshot)" };
    }
    const fk = Object.keys(container).find(
      (k) => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber"),
    );
    if (!fk) return { error: "lake-sheet found but no react fiber (未加载完成，稍后重试或 vortex_screenshot)" };
    let fiber: any = (container as any)[fk];
    let depth = 0;
    let kernel: any = null;
    while (fiber && depth < 40) {
      const st = fiber.memoizedState;
      if (st && st.sheet && (st.sheet.doc || st.sheet.model)) { kernel = st.sheet; break; }
      fiber = fiber.return; depth++;
    }
    if (!kernel) return { error: "lake-sheet kernel not found (fiber 走访失败，稍后重试或 vortex_screenshot)" };

    const m = kernel.model, d = m && m.data, table = m && m.table;
    if (!d || !Array.isArray(table)) return { error: "lake-sheet model empty" };
    const colCount = typeof d.colCount === "number" ? d.colCount : (table[0] ? table[0].length : 0);
    const cellText = (c: any): string => {
      if (c == null) return "";
      const v = typeof c === "object" ? c.value : c;
      if (v == null) return "";
      if (typeof v === "object") {
        // 富单元格:语雀内联图片 {class:"image",src,name} → markdown 图片;其他对象取 .text 或 JSON 片段(不吐 [object Object])。
        if (v.class === "image" && typeof v.src === "string") return `![${v.name || "image"}](${v.src})`;
        if (typeof v.text === "string") return v.text;
        try { return JSON.stringify(v).slice(0, 100); } catch { return ""; }
      }
      return String(v);
    };
    const cells: string[][] = table.map((row: any[]) => {
      const out: string[] = [];
      for (let c = 0; c < colCount; c++) out.push(cellText(row && row[c]));
      return out;
    });
    const merges: Array<{ row: number; col: number; rowCount: number; colCount: number }> = [];
    const mc = d.mergeCells;
    if (mc && typeof mc === "object") {
      for (const k of Object.keys(mc)) {
        const v = mc[k];
        if (v && typeof v === "object" && typeof v.row === "number" && typeof v.col === "number") {
          merges.push({ row: v.row, col: v.col, rowCount: v.rowCount ?? 1, colCount: v.colCount ?? 1 });
        }
      }
    }
    // 去尾部全空行/列(语雀分配 rowCount/colCount 常远大于真实内容,避免吐大量空行空列)。
    let lastRow = -1, lastCol = -1;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < colCount; c++) {
        if (cells[r][c] !== "") { if (r > lastRow) lastRow = r; if (c > lastCol) lastCol = c; }
      }
    }
    const nRows = lastRow + 1, nCols = lastCol + 1;
    // 工作簿页签(内联 readWorksheetTabs,parity):让模型知道有哪些 sheet 及怎么切换。
    const worksheets: Array<{ name: string; active: boolean }> = [];
    for (const t of Array.from(document.querySelectorAll(".lake-sheet-tab-item"))) {
      const nameEl = t.querySelector(".sheet-name-container");
      const wname = ((nameEl && nameEl.textContent) || t.textContent || "").trim();
      if (wname) worksheets.push({ name: wname, active: t.classList.contains("lake-sheet-tab-item-active") });
    }
    const sheet = {
      name: typeof d.name === "string" ? d.name : "",
      rowCount: nRows,
      colCount: nCols,
      cells: cells.slice(0, nRows).map((row) => row.slice(0, nCols)),
      merges: merges.filter((mg) => mg.row < nRows && mg.col < nCols),
      worksheets,
    };

    // —— serialize(内联真源 serializeSheet)——
    const escMd = (s: string): string => String(s ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
    const escCsv = (s: string): string => {
      const v = String(s ?? "");
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const applyMergeFill = (cs: string[][], ms: typeof merges): string[][] => {
      const grid = cs.map((r) => r.slice());
      for (const m of ms) {
        if (m.colCount === 1 && m.rowCount > 1) {
          const anchor = grid[m.row]?.[m.col] ?? "";
          for (let r = m.row + 1; r < m.row + m.rowCount; r++) {
            if (grid[r] && grid[r][m.col] === "") grid[r][m.col] = anchor;
          }
        }
      }
      return grid;
    };
    const fmt = format === "csv" || format === "json" ? format : "markdown";
    const total = sheet.cells.length;
    const shown = Math.min(total, Math.max(1, maxRows));
    const truncated = total > shown;
    if (fmt === "json") {
      return { text: JSON.stringify({ sheet: sheet.name, rowCount: sheet.rowCount, colCount: sheet.colCount, rows: sheet.cells.slice(0, shown), merges: sheet.merges, worksheets: sheet.worksheets, truncated }) };
    }
    const filled = applyMergeFill(sheet.cells, sheet.merges).slice(0, shown);
    if (filled.length === 0) return { text: `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，空表（sheet: ${sheet.name}）` };
    const lines: string[] = [];
    if (fmt === "csv") {
      for (const row of filled) lines.push(row.map(escCsv).join(","));
    } else {
      const header = filled[0];
      lines.push("| " + header.map(escMd).join(" | ") + " |");
      lines.push("| " + header.map(() => "---").join(" | ") + " |");
      for (let i = 1; i < filled.length; i++) lines.push("| " + filled[i].map(escMd).join(" | ") + " |");
    }
    lines.push(truncated
      ? `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，显示 1–${shown} / 共 ${total} 行，提高 maxResults 取更多（sheet: ${sheet.name}）`
      : `> ${sheet.rowCount} 行 × ${sheet.colCount} 列，显示 1–${shown}（sheet: ${sheet.name}）`);
    if (sheet.worksheets && sheet.worksheets.length > 1) {
      const wnames = sheet.worksheets.map((w) => (w.active ? `*${w.name}` : w.name)).join(" | ");
      lines.push(`> 工作簿(${sheet.worksheets.length}): ${wnames} — 切换其他 sheet: vortex_act 点对应页签(见 observe)后再 vortex_query mode=sheet`);
    }
    return { text: lines.join("\n") };
  } catch (e) {
    return { error: "sheet readback error: " + (e instanceof Error ? e.message : String(e)) };
  }
};

/**
 * page-side 图表 readback 函数体。mode=chart 注入 MAIN world。
 * 参数 args: [pattern(预留), format(summary|json), maxPoints(每系列点上限)]。
 * 返回 { text } 或 { error }。⚠ [inline chart-readback]:注入丢模块作用域,normalize/
 * serialize/echarts adapter 必须内联;逻辑须与 src/page-side/chart-readback.ts 真源一致
 * (改一处须改两处),query-chart-parity.test.ts 校验。纯读,不调用图表实例写方法(只读安全)。
 * MVP:echarts adapter(window.echarts.getInstanceByDom → getOption)。
 */
export const chartProbeFunc = (
  _pattern: string,
  format: string,
  maxPoints: number,
): { text: string } | { error: string } => {
  try {
    const doc = document;
    const win = window as unknown as {
      echarts?: {
        getInstanceByDom?: (el: Element) => { getOption?: () => Record<string, unknown> } | null | undefined;
        getInstanceById?: (id: string) => { getOption?: () => Record<string, unknown> } | null | undefined;
      };
    };
    const ec = win.echarts;
    const NO_CHART = "no chart on page (未检测到图表；仅支持 echarts，若确在图表页请等待加载，或用 vortex_screenshot)";
    if (!ec || typeof ec.getInstanceByDom !== "function" || !doc.querySelector("[_echarts_instance_]")) {
      return { error: NO_CHART };
    }
    const cap = maxPoints > 0 ? maxPoints : 200;

    interface ChartSeries { name?: string; type: string; data: unknown[]; truncated?: number; }
    interface ChartAxis { type?: string; name?: string; data?: unknown[]; }
    interface ChartData { title?: string; chartType: string; series: ChartSeries[]; xAxis?: ChartAxis[]; yAxis?: ChartAxis[]; legend?: string[]; }

    const normAxis = (ax: unknown): ChartAxis[] | undefined => {
      if (ax == null) return undefined;
      const arr = Array.isArray(ax) ? ax : [ax];
      const out = arr.filter((a) => a && typeof a === "object").map((a) => {
        const o = a as Record<string, unknown>;
        const r: ChartAxis = {};
        if (typeof o.type === "string") r.type = o.type;
        if (typeof o.name === "string") r.name = o.name;
        if (Array.isArray(o.data)) r.data = o.data;
        return r;
      });
      return out.length ? out : undefined;
    };
    const normLegend = (legend: unknown): string[] | undefined => {
      if (legend == null) return undefined;
      const arr = Array.isArray(legend) ? legend : [legend];
      for (const l of arr) {
        if (l && typeof l === "object" && Array.isArray((l as Record<string, unknown>).data)) {
          return ((l as Record<string, unknown>).data as unknown[]).map((x) =>
            typeof x === "string" ? x : x && typeof x === "object" && "name" in (x as object) ? String((x as Record<string, unknown>).name) : String(x));
        }
      }
      return undefined;
    };
    const normTitle = (title: unknown): string | undefined => {
      if (title == null) return undefined;
      const arr = Array.isArray(title) ? title : [title];
      for (const t of arr) {
        if (t && typeof t === "object") {
          const o = t as Record<string, unknown>;
          const txt = (o.text as string) || (o.subtext as string);
          if (txt) return String(txt);
        }
      }
      return undefined;
    };
    const normalizeEchartsOption = (opt: Record<string, unknown>, maxP: number): ChartData => {
      const rawSeries = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : [];
      const series: ChartSeries[] = rawSeries.filter((s) => s && typeof s === "object").map((s) => {
        const o = s as Record<string, unknown>;
        const data = Array.isArray(o.data) ? o.data : [];
        const cs: ChartSeries = { type: String(o.type ?? "unknown"), data: data.slice(0, maxP) };
        if (typeof o.name === "string") cs.name = o.name;
        if (data.length > maxP) cs.truncated = data.length;
        return cs;
      });
      const cd: ChartData = { chartType: series[0]?.type ?? "unknown", series };
      const title = normTitle(opt.title); if (title) cd.title = title;
      const xAxis = normAxis(opt.xAxis); if (xAxis) cd.xAxis = xAxis;
      const yAxis = normAxis(opt.yAxis); if (yAxis) cd.yAxis = yAxis;
      const legend = normLegend(opt.legend); if (legend) cd.legend = legend;
      return cd;
    };
    const fmtVals = (data: unknown[], truncated?: number): string => {
      const shown = data.slice(0, 12).map((d) => {
        if (d && typeof d === "object") {
          const o = d as Record<string, unknown>;
          if ("value" in o) return o.name != null ? `${o.name}:${o.value}` : String(o.value);
          return JSON.stringify(o);
        }
        return String(d);
      }).join(", ");
      const more = truncated ? ` …共${truncated}点` : data.length > 12 ? ` …共${data.length}点` : "";
      return `[${shown}${more}]`;
    };
    const renderSummary = (charts: ChartData[]): string => {
      const lines: string[] = [`检测到 ${charts.length} 个图表(echarts):`];
      charts.forEach((c, i) => {
        lines.push(`\n[图表${i + 1}] ${c.title ?? "(无标题)"} — 类型 ${c.chartType}，${c.series.length} 系列`);
        if (c.xAxis?.[0]?.data) lines.push(`  x轴(${c.xAxis[0].type ?? "?"}): ${fmtVals(c.xAxis[0].data)}`);
        if (c.legend) lines.push(`  图例: [${c.legend.join(", ")}]`);
        for (const s of c.series) lines.push(`  系列 ${s.name ?? "(无名)"}(${s.type}): ${fmtVals(s.data, s.truncated)}`);
      });
      return lines.join("\n");
    };
    const serializeChart = (charts: ChartData[], fmt: string): string =>
      fmt === "json" ? JSON.stringify({ charts }) : `${renderSummary(charts)}\n\n结构数据:\n${JSON.stringify({ charts })}`;

    // echarts adapter read(内联真源 echartsAdapter.read)
    const divs = Array.from(doc.querySelectorAll("[_echarts_instance_]"));
    const charts: ChartData[] = [];
    for (const div of divs) {
      let inst = ec.getInstanceByDom ? ec.getInstanceByDom(div) : null;
      if (!inst && ec.getInstanceById) {
        const id = div.getAttribute("_echarts_instance_");
        if (id) inst = ec.getInstanceById(id);
      }
      if (inst && typeof inst.getOption === "function") {
        try { charts.push(normalizeEchartsOption(inst.getOption(), cap)); } catch { /* 单图表失败不阻断 */ }
      }
    }
    if (!charts.length) return { error: NO_CHART };
    return { text: serializeChart(charts, format) };
  } catch (e) {
    return { error: "chart readback error: " + (e instanceof Error ? e.message : String(e)) };
  }
};

/**
 * page-side 流程图 readback 函数体。mode=flow 注入 MAIN world。
 * 参数 args: [pattern(adapter/容器提示), format(mermaid|tree|json)]。
 * 返回 { text } 或 { error }。⚠ [inline flow-readback]:注入丢模块作用域,detect/read/
 * serialize 必须内联;逻辑须与 src/page-side/flow-readback.ts 真源一致(改一处须改两处),
 * query-flow-parity.test.ts 校验。纯读,不调用 Vue 方法(只读安全)。
 */
export const flowProbeFunc = (
  pattern: string,
  format: string,
): { text: string } | { error: string } => {
  try {
    const doc = document;
    // —— ipaas adapter: detect + read(内联真源 findIpaasVm/ipaasAdapter.read)——
    const body = doc.querySelector(".processSetting-body");
    let vm: any = null;
    if (body) {
      let cur: any = body, hops = 0;
      while (cur && hops < 15) {
        if (cur.__vue__ && cur.__vue__._data && Array.isArray(cur.__vue__._data.nodesDataList)) { vm = cur.__vue__; break; }
        cur = cur.parentElement; hops++;
      }
    }
    if (!vm) return { error: "no flow diagram on page (未检测到流程图；若确在流程页请等待加载，或用 vortex_screenshot)" };

    const d = vm._data;
    const nodes: Array<{ id: string; label: string; type: string }> = [];
    const edges: Array<{ from: string; to: string; label?: string }> = [];
    let counter = 0;
    const genId = (n: any): string => (n && n.id != null && n.id !== "null" ? `ip_${n.id}_${counter++}` : `n${counter++}`);
    const subSeq = (x: any): any[] =>
      Array.isArray(x) ? x
      : x && Array.isArray(x.septs) ? x.septs
      : x && Array.isArray(x.nodes) ? x.nodes
      : x && Array.isArray(x.children) ? x.children
      : [];
    const expand = (seq: any[], prevId: string | null): { first: string | null; last: string | null } => {
      let last = prevId, first: string | null = null;
      for (const node of seq || []) {
        if (!node || typeof node !== "object") continue;
        const id = genId(node);
        const type = String(node.septType || node.type || "NODE");
        nodes.push({ id, label: String(node.name || node.nodeName || type), type });
        if (last) edges.push({ from: last, to: id });
        if (first === null) first = id;
        last = id;
        const data = node.data || {};
        if (Array.isArray(data.branchData) && data.branchData.length) {
          // 真实形状(app 源码坐实):branchData[i]={septType:"CONCURRENT_ITEM",septs:[...]}(无 name),分支按序号。
          data.branchData.forEach((branch: any, bi: number) => {
            const bseq = subSeq(branch);
            if (!bseq.length) return;
            const r = expand(bseq, null);
            if (r.first) edges.push({ from: id, to: r.first, label: (branch && (branch.name || branch.branchName)) || `分支${bi + 1}` });
          });
        }
        const loop = subSeq(data.iterateSeptData);
        if (loop.length) { const r = expand(loop, null); if (r.first) edges.push({ from: id, to: r.first, label: "循环" }); }
      }
      return { first, last };
    };
    let mainPrev: string | null = null;
    if (d.startNode && typeof d.startNode === "object") {
      const sid = genId(d.startNode);
      nodes.push({ id: sid, label: String(d.startNode.name || "开始"), type: String(d.startNode.septType || "START") });
      mainPrev = sid;
    }
    const bodyRes = expand(Array.isArray(d.nodesDataList) ? d.nodesDataList : [], mainPrev);
    mainPrev = bodyRes.last ?? mainPrev;
    if (d.endNode && typeof d.endNode === "object") {
      const eid = genId(d.endNode);
      nodes.push({ id: eid, label: String(d.endNode.name || "结束"), type: String(d.endNode.septType || "END") });
      if (mainPrev) edges.push({ from: mainPrev, to: eid });
    }
    const title = d.formParams && typeof d.formParams.name === "string" ? d.formParams.name : undefined;
    const graph = { title, nodes, edges };

    // —— serialize(内联真源 serializeFlow)——
    const escFlow = (s: string): string => String(s ?? "").replace(/\r?\n/g, " ").replace(/"/g, "#quot;").trim();
    const fmt = format === "tree" || format === "json" ? format : "mermaid";
    if (fmt === "json") return { text: JSON.stringify(graph) };
    if (fmt === "tree") {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const lines: string[] = [];
      if (graph.title) lines.push(`流程: ${graph.title}`);
      graph.nodes.forEach((n, i) => {
        lines.push(`${i + 1}. ${n.label} (${n.type})`);
        for (const e of graph.edges.filter((ed) => ed.from === n.id)) {
          const tgt = byId.get(e.to);
          lines.push(`   → ${tgt ? tgt.label : e.to}${e.label ? ` [${e.label}]` : ""}`);
        }
      });
      return { text: lines.join("\n") };
    }
    // mermaid
    const idx = new Map<string, string>();
    graph.nodes.forEach((n, i) => idx.set(n.id, `N${i}`));
    const lines: string[] = ["flowchart TD"];
    if (graph.title) lines.push(`  %% ${escFlow(graph.title)}`);
    for (const n of graph.nodes) {
      const mid = idx.get(n.id)!;
      const text = `${escFlow(n.label)} (${escFlow(n.type)})`;
      const t = (n.type || "").toUpperCase();
      lines.push("  " + (t === "START" || t === "END" ? `${mid}(["${text}"])` : t === "PARALLEL" || t === "CONCURRENT" ? `${mid}{"${text}"}` : `${mid}["${text}"]`));
    }
    for (const e of graph.edges) {
      const f = idx.get(e.from), t = idx.get(e.to);
      if (!f || !t) continue;
      lines.push(e.label ? `  ${f} -->|${escFlow(e.label)}| ${t}` : `  ${f} --> ${t}`);
    }
    return { text: lines.join("\n") };
  } catch (e) {
    return { error: "flow readback error: " + (e instanceof Error ? e.message : String(e)) };
  }
};

/**
 * 结构化数据回读探针。真源 src/page-side/schema-readback.ts;此处是注入用的自包含副本
 * (executeScript 注入丢模块作用域,不能 import),parity 由 query-schema-parity.test.ts 守。
 * [inline schema-readback]
 */
export const schemaProbeFunc = (
  pattern: string,
  format: string,
  maxEntities: number,
):
  | { text: string; total: number; truncated: boolean; scanned: Record<string, number> }
  | { error: string } => {
  try {
    const doc = document;
    const SCHEMA_MAX_VALUE_CHARS = 500;

    interface E { type: string; props: Record<string, unknown>; source: string; untrusted: true; id?: string }

    const firstType = (raw: unknown): string | null => {
      if (typeof raw === "string" && raw.trim()) return raw.trim();
      if (Array.isArray(raw)) for (const t of raw) if (typeof t === "string" && t.trim()) return t.trim();
      return null;
    };
    const toEntity = (obj: Record<string, unknown>, source: string): E | null => {
      const type = firstType(obj["@type"]);
      if (!type) return null;
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "@context" || k === "@id") continue;
        props[k] = v;
      }
      if (!Array.isArray(obj["@type"])) delete props["@type"];
      const e: E = { type, props, source, untrusted: true };
      const id = obj["@id"];
      if (typeof id === "string" && id) e.id = id;
      return e;
    };
    const flattenLd = (parsed: unknown): Record<string, unknown>[] => {
      if (Array.isArray(parsed)) return parsed.filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
      if (!parsed || typeof parsed !== "object") return [];
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj["@graph"])) {
        return (obj["@graph"] as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
      }
      return [obj];
    };

    const ldScriptEls = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    const ldEntities: E[] = [];
    let parseErrors = 0;
    ldScriptEls.forEach((s, i) => {
      let parsed: unknown;
      try { parsed = JSON.parse(s.textContent || ""); } catch { parseErrors++; return; }
      for (const obj of flattenLd(parsed)) {
        const e = toEntity(obj, `jsonld:${i}`);
        if (e) ldEntities.push(e);
      }
    });

    const SRC_TAGS = new Set(["IMG", "AUDIO", "EMBED", "IFRAME", "SOURCE", "TRACK", "VIDEO"]);
    const HREF_TAGS = new Set(["A", "AREA", "LINK"]);
    const readItem = (scope: Element): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      const t = scope.getAttribute("itemtype");
      if (t) out["@type"] = t;
      for (const el of Array.from(scope.querySelectorAll("[itemprop]"))) {
        const start = el.hasAttribute("itemscope") ? el.parentElement : el;
        if ((start ? start.closest("[itemscope]") : null) !== scope) continue;
        let value: unknown;
        if (el.hasAttribute("itemscope")) value = readItem(el);
        else {
          const tag = el.tagName;
          if (tag === "META") value = el.getAttribute("content") || "";
          else if (HREF_TAGS.has(tag)) value = el.getAttribute("href") || "";
          else if (SRC_TAGS.has(tag)) value = el.getAttribute("src") || "";
          else if (tag === "OBJECT") value = el.getAttribute("data") || "";
          else if (tag === "DATA" || tag === "METER") value = el.getAttribute("value") || "";
          else if (tag === "TIME") value = el.getAttribute("datetime") || (el.textContent || "").trim();
          else value = (el.textContent || "").trim();
        }
        for (const name of (el.getAttribute("itemprop") || "").split(/\s+/).filter(Boolean)) {
          const prev = out[name];
          if (prev === undefined) out[name] = value;
          else if (Array.isArray(prev)) prev.push(value);
          else out[name] = [prev, value];
        }
      }
      return out;
    };
    const scopes = Array.from(doc.querySelectorAll("[itemscope]"));
    const mdEntities: E[] = [];
    let itemrefsSkipped = 0;
    let untypedItems = 0;
    let mdIdx = 0;
    for (const scope of scopes) {
      if (scope.hasAttribute("itemref")) itemrefsSkipped++;
      if (scope.hasAttribute("itemprop")) continue;
      const type = scope.getAttribute("itemtype");
      if (!type) {
        untypedItems++;
        continue;
      }
      const { "@type": _t, ...props } = readItem(scope);
      const e: E = { type, props, source: `microdata:${mdIdx++}`, untrusted: true };
      const itemid = scope.getAttribute("itemid");
      if (itemid) e.id = itemid;
      mdEntities.push(e);
    }

    const ogProps: Record<string, unknown> = {};
    let ogMetas = 0;
    for (const m of Array.from(doc.querySelectorAll("meta"))) {
      const key = m.getAttribute("property") || m.getAttribute("name") || "";
      if (!key.startsWith("og:")) continue;
      ogMetas++;
      const name = key.slice(3);
      if (!name) continue;
      const value = m.getAttribute("content") || "";
      const prev = ogProps[name];
      if (prev === undefined) ogProps[name] = value;
      else if (Array.isArray(prev)) prev.push(value);
      else ogProps[name] = [prev, value];
    }
    const ogEntities: E[] = [];
    if (ogMetas > 0) {
      const t = typeof ogProps.type === "string" && ogProps.type ? ogProps.type : "website";
      const e: E = { type: t, props: ogProps, source: "og", untrusted: true };
      if (typeof ogProps.url === "string" && ogProps.url) e.id = ogProps.url;
      ogEntities.push(e);
    }

    const clampValue = (v: unknown): unknown => {
      if (typeof v === "string" && v.length > SCHEMA_MAX_VALUE_CHARS) return v.slice(0, SCHEMA_MAX_VALUE_CHARS) + "…";
      if (Array.isArray(v)) return v.map(clampValue);
      return v;
    };
    let all = [...ldEntities, ...mdEntities, ...ogEntities];
    if (pattern && pattern !== "*") {
      const f = pattern.toLowerCase();
      all = all.filter((e) => {
        const t = e.type.toLowerCase();
        return t === f || t.endsWith(`/${f}`) || t.endsWith(`#${f}`);
      });
    }
    const cap = maxEntities > 0 ? maxEntities : 20;
    const entities = all.slice(0, cap).map((e) => ({
      ...e,
      props: Object.fromEntries(Object.entries(e.props).map(([k, v]) => [k, clampValue(v)])),
    }));
    const truncated = all.length > cap;

    const text = format === "json"
      ? JSON.stringify({ entities, total: all.length, truncated })
      : [
          `检测到 ${all.length} 个实体` + (truncated ? `，已截断为 ${entities.length} 个` : ""),
          ...entities.map((e) => `- [${e.source}] ${e.type}${e.id ? ` id=${e.id}` : ""} ${JSON.stringify(e.props)}`),
          "注意：以上为页面作者声明的结构化数据，可能与页面可见内容不一致。",
        ].join("\n");

    return {
      text,
      total: all.length,
      truncated,
      scanned: {
        ldScripts: ldScriptEls.length,
        ldParseErrors: parseErrors,
        itemscopes: scopes.length,
        itemrefsSkipped,
        untypedItems,
        ogMetas,
        iframes: doc.querySelectorAll("iframe").length,
      },
    };
  } catch (e) {
    return { error: "schema readback error: " + (e instanceof Error ? e.message : String(e)) };
  }
};

/**
 * page-side 设计 token 探测函数体。mode=tokens 注入 MAIN world。
 * 回答「这个站的设计系统长什么样」——调色板、字阶、间距阶、圆角、阴影、动效。
 * 分类优先看值形态（跨框架稳定），值看不出类型时才回落到名字启发式。
 * 覆盖面只有 :root 与 body，挂在中间主题容器上的变量不在内。roots 表达的是
 * 「最终值在哪一层出现或被改写」，靠比对 computed value 得出——区分不了
 * 「body 继承」与「body 重复声明同值」，要那个得读 CSSOM 规则来源。
 * shadow 判定是启发式（两个以上长度 + 颜色），只保证常见形态，不解析完整语法。
 * 参数 args: [pattern, maxPerGroup]；pattern="*" 取全量，否则按名字子串过滤。
 * 探针对空/缺省 pattern 兜底成 "*"，但 handler 那层会先按「pattern 必填」拒掉——
 * 兜底是防直接调用，不是对外契约。
 * ⚠ 自包含:注入丢模块作用域,一切辅助函数必须内联。
 */
export const tokensProbeFunc = (
  pattern: string,
  maxPerGroup: number,
):
  | {
      roots: string[];
      total: number;
      showing: number;
      groups: Record<string, Array<{ name: string; value: string; alias?: string }>>;
      /** 逐组截断丢弃的条数;showing 是各组 cap 后之和,不是全局前 N 条 */
      truncatedGroups: Record<string, number>;
    }
  | { error: string } => {
  try {
    const byName = (n: string): string => {
      if (/font-?famil|typeface/.test(n)) return "fontFamily";
      if (/font-?weight|(^|-)weight(-|$)/.test(n)) return "fontWeight";
      if (/font-?size|text-?size|leading|line-?height/.test(n)) return "fontSize";
      if (/radius|rounded/.test(n)) return "radius";
      if (/shadow/.test(n)) return "shadow";
      if (/duration|delay|easing|transition|animation/.test(n)) return "motion";
      if (/colou?r|(^|-)bg(-|$)|background|(^|-)fg(-|$)|foreground/.test(n)) return "color";
      if (/space|spacing|gap|size|inset|margin|padding/.test(n)) return "spacing";
      return "other";
    };
    const classify = (name: string, value: string): string => {
      const n = name.toLowerCase();
      const v = value.trim();
      if (/^var\(/.test(v)) return byName(n);
      if (/gradient\(/i.test(v)) return "gradient";
      if (/^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i.test(v)) return "color";
      if (/cubic-bezier\(|steps\(|^-?\d+(\.\d+)?m?s$/i.test(v)) return "motion";
      if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/i.test(v)) return "motion";
      // 至少两个长度(offset-x/offset-y)才是 shadow;border 简写只有一个,被这条挡住
      if (
        /\d\s*(px|rem|em)\b[\s\S]*\d\s*(px|rem|em)\b/i.test(v) &&
        /(rgba?\(|#[0-9a-f]{3,8})/i.test(v)
      ) {
        return "shadow";
      }
      if (/^-?\d+(\.\d+)?(px|rem|em|%|vh|vw)$/.test(v)) {
        const g = byName(n);
        return g === "color" || g === "other" ? "spacing" : g;
      }
      if (/,/.test(v) && /(sans-serif|serif|monospace|system-ui|cursive|fantasy)/i.test(v)) {
        return "fontFamily";
      }
      return byName(n);
    };

    const roots: string[] = [];
    const seen = new Map<string, string>();
    const hosts: Array<[string, Element | null]> = [
      [":root", document.documentElement],
      ["body", document.body],
    ];
    for (const host of hosts) {
      if (!host[1]) continue;
      const cs = getComputedStyle(host[1]);
      let contributed = false;
      for (const prop of Array.from(cs as unknown as Iterable<string>)) {
        if (typeof prop !== "string" || prop.slice(0, 2) !== "--") continue;
        const value = cs.getPropertyValue(prop).trim();
        // 空值不覆盖已有值:body 枚举到无效声明会把 :root 的值清掉
        if (value === "" && seen.has(prop)) continue;
        // 自定义属性会继承,body 多半只是把 :root 的值重念一遍;
        // 只有新增或改写才算这一层的贡献,否则 roots 会谎报覆盖面
        if (!seen.has(prop) || seen.get(prop) !== value) contributed = true;
        seen.set(prop, value);
      }
      if (contributed) roots.push(host[0]);
    }

    const needle = (pattern || "*").toLowerCase();
    const all =
      needle === "*"
        ? Array.from(seen)
        : Array.from(seen).filter((e) => e[0].toLowerCase().indexOf(needle) !== -1);

    const groups: Record<string, Array<{ name: string; value: string; alias?: string }>> = {};
    const truncatedGroups: Record<string, number> = {};
    let showing = 0;
    for (const entry of all.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const name = entry[0];
      const value = entry[1];
      const g = classify(name, value);
      if (!groups[g]) groups[g] = [];
      // 截断是逐组的,不记下丢了多少调用方无从从 total/showing 反推
      if (groups[g].length >= maxPerGroup) {
        truncatedGroups[g] = (truncatedGroups[g] ?? 0) + 1;
        continue;
      }
      const m = value.trim().match(/^var\(\s*(--[^,)\s]+)/);
      groups[g].push(m ? { name, value, alias: m[1] } : { name, value });
      showing++;
    }
    return { roots, total: all.length, showing, groups, truncatedGroups };
  } catch (e) {
    return { error: "tokens probe error: " + (e instanceof Error ? e.message : String(e)) };
  }
};

/**
 * 归一化 vortex_query mode=css 的 `attr` 参数为属性名数组(去空)。
 *
 * 接受: 单属性("class") / 分隔符拼接的多属性("class|title" 或 "class,title") /
 * 已构建的数组 / undefined。空段与空白自动过滤; 若无有效项返回 null,
 * 调用方据此完全跳过属性提取。
 *
 * R11 修复: 此前畸形复合串如 "class|title" 被直接传给 getAttribute("class|title"),
 * 静默返回 null, 向 agent 隐藏了 attrs 为空的真实原因。
 */
export function normalizeCssAttrParam(attr: string | string[] | undefined): string[] | null {
  if (attr == null) return null;
  const raw = Array.isArray(attr) ? attr : attr.split(/[,|]/);
  const out = raw.map((a) => a.trim()).filter(Boolean);
  return out.length > 0 ? out : null;
}

type StyleProbeElement = Record<string, unknown> & {
  pseudoRaw?: Record<string, Record<string, string>>;
  declaredFont?: string;
};
type StyleProbeResult = {
  elements: StyleProbeElement[];
  total: number;
  showing: number;
  fontFaces?: Array<Record<string, string>>;
  fontFacesPartial?: boolean;
};

/** 探针读回的短横线属性名 → isPseudoRendered 要的驼峰形状。 */
function toPseudoComputed(raw: Record<string, string>): Parameters<typeof isPseudoRendered>[0] {
  return {
    content: raw.content ?? "",
    display: raw.display ?? "",
    visibility: raw.visibility ?? "",
    opacity: raw.opacity ?? "",
    backgroundImage: raw["background-image"] ?? "",
    width: raw.width ?? "",
    height: raw.height ?? "",
  };
}

function renderedPseudos(raw: Record<string, Record<string, string>>): Record<string, Record<string, string>> | undefined {
  const out: Record<string, Record<string, string>> = {};
  for (const [which, cs] of Object.entries(raw)) {
    if (isPseudoRendered(toPseudoComputed(cs))) out[which] = cs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 把探针的中间态(pseudoRaw / declaredFont)换成判定后的 pseudo / font 字段。
 * 字体走 CDP;拿不到时 evidence=unavailable 并带原因——不回落到会答错的宽度测量。
 */
async function finalizeStyleResult(
  res: StyleProbeResult,
  opt: { wantPseudo: boolean; wantFont: boolean; debuggerMgr?: DebuggerManager; tabId: number; selector: string; maxResults: number },
): Promise<StyleProbeResult> {
  const fonts = opt.wantFont
    ? opt.debuggerMgr
      ? await fetchPlatformFonts(opt.debuggerMgr, opt.tabId, opt.selector, opt.maxResults, res.elements.length)
      : { reason: "no debugger session available in this build" }
    : null;

  const elements = res.elements.map((el, i) => {
    const { pseudoRaw, declaredFont, ...rest } = el;
    const pseudo = opt.wantPseudo && pseudoRaw ? renderedPseudos(pseudoRaw) : undefined;
    const font = !opt.wantFont || declaredFont === undefined
      ? undefined
      : fonts && "fonts" in fonts
        ? buildFontEvidence(declaredFont, fonts.fonts[i] ?? null, fonts.fonts[i] === null ? "node lookup failed" : undefined)
        : buildFontEvidence(declaredFont, null, fonts ? fonts.reason : undefined);
    return { ...rest, ...(pseudo ? { pseudo } : {}), ...(font ? { font } : {}) };
  });

  const { fontFaces, ...restRes } = res;
  // 知乎把一个 family 按 unicode-range 切了 302 片,原样返回是 81KB
  const faces = fontFaces ? aggregateFontFaces(fontFaces) : undefined;
  return {
    ...restRes,
    elements,
    ...(faces ? { fontFaces: faces.faces, fontFamiliesTotal: faces.totalFamilies, fontFacesTruncated: faces.truncated } : {}),
  } as StyleProbeResult;
}

export function registerQueryHandlers(router: ActionRouter, debuggerMgr?: DebuggerManager): void {
  router.registerAll({
    [QueryActions.QUERY_PAGE]: async (args, tabId) => {
      const mode = args.mode as string | undefined;

      // 空串按没给算,否则调用方拿着有效 @ref 也会被判 pattern 缺失
      const rawPattern = args.pattern as string | undefined;
      const explicitPattern =
        typeof rawPattern === "string" && rawPattern.trim() !== "" ? rawPattern : undefined;
      const selectorMode = mode != null && QUERY_SELECTOR_MODES.has(mode);
      if (explicitPattern != null && args.index != null) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          "vortex_query: provide either `pattern` or an @ref, not both",
        );
      }
      // 选择器类 mode 复用 resolveTarget 反查,与 dom.* 同一条寻址链
      const resolved =
        explicitPattern == null && selectorMode ? resolveTargetOptional(args) : undefined;
      const pattern = explicitPattern ?? resolved?.selector;

      // 参数校验
      if (
        !mode ||
        (mode !== "text" && mode !== "css" && mode !== "component" &&
         mode !== "geometry" && mode !== "style" && mode !== "sheet" && mode !== "flow" &&
         mode !== "chart" && mode !== "schema" && mode !== "tokens")
      ) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `vortex_query: mode must be 'text', 'css', 'component', 'geometry', 'style', 'sheet', 'flow', 'chart', 'schema' or 'tokens', got ${String(mode)}`,
        );
      }
      if (!pattern || typeof pattern !== "string" || !pattern.trim()) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          "vortex_query: pattern is required and must be a non-empty string",
        );
      }

      // 快照绑定的 tab/frame 优先,跨 frame ref 才不会打到主 frame
      const tid = await getActiveTabId(
        resolved?.boundTabId ?? (args.tabId as number | undefined) ?? tabId,
      );
      const frameId = resolved?.boundFrameId ?? (args.frameId as number | undefined);
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
          | { matches: unknown[]; total: number; has_more: boolean; scanned?: TextScan }
          | { error: string; matches: never[]; total: number }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage text: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage text error: ${res.error}`);
        }
        // scanned 只服务于零命中自陈,不进载荷 —— 有命中时形状与从前逐字节一致。
        const { scanned, ...payload } = res;
        return withDiagnosis(
          payload,
          res.total === 0 && scanned
            ? diagnoseEmptyQueryText({ ...scanned, pattern, isRegex, frameScoped: frameId != null })
            : null,
        );
      } else if (mode === "css") {
        // css query 模式
        const attributes: string[] | null = normalizeCssAttrParam(args.attr as string | string[] | undefined);
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 20, 100);
        const includeText = (args.includeText as boolean | undefined) ?? true;

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: cssQueryFunc,
          args: [pattern, attributes, maxResults, includeText],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { elements: unknown[]; total: number; showing: number; scanned?: CssScan }
          | { error: string; elements: never[]; total: number }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage css: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage css error: ${res.error}`);
        }
        const { scanned, ...payload } = res;
        return withDiagnosis(
          payload,
          res.total === 0 && scanned
            ? diagnoseEmptyQueryCss({ ...scanned, selector: pattern, frameScoped: frameId != null })
            : null,
        );
      } else if (mode === "geometry") {
        // geometry 模式:注入 geometryProbeFunc 取 bbox/视口/遮挡/裁剪 + 两元素关系。
        // pattern = CSS 选择器(命中多元素;命中前两个产 pair 关系)。
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 10, 50);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: geometryProbeFunc,
          args: [pattern, maxResults],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { viewport: unknown; elements: unknown[]; total: number; showing: number }
          | { error: string }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage geometry: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage geometry error: ${res.error}`);
        }
        return res;
      } else if (mode === "flow") {
        // flow 模式:注入 flowProbeFunc,adapter 检测流程图→读模型→mermaid/tree/json。
        const format = typeof args.attr === "string" ? args.attr : "mermaid";

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: flowProbeFunc,
          args: [pattern, format],
          world: "MAIN",
        });

        const res = results[0]?.result as { text: string } | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage flow: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage flow error: ${res.error}`);
        }
        return res;
      } else if (mode === "chart") {
        // chart 模式:注入 chartProbeFunc,echarts adapter 定位实例→getOption→归一化数据。
        // pattern 预留(v1 全页);attr = 格式(summary 默认|json);maxResults = 每系列点上限。
        const format = typeof args.attr === "string" ? args.attr : "summary";
        const maxPoints = Math.min((args.maxResults as number | undefined) ?? 200, 2000);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: chartProbeFunc,
          args: [pattern, format, maxPoints],
          world: "MAIN",
        });

        const res = results[0]?.result as { text: string } | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage chart: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage chart error: ${res.error}`);
        }
        return res;
      } else if (mode === "sheet") {
        // sheet 模式:注入 sheetProbeFunc 读语雀 Lake Sheet 内存模型 → md/csv/json。
        // pattern = sheet 选择器(v1 仅活动 sheet);attr = 格式;maxResults = 行上限。
        const format = typeof args.attr === "string" ? args.attr : "markdown";
        const maxRows = Math.min((args.maxResults as number | undefined) ?? 200, 1000);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: sheetProbeFunc,
          args: [pattern, format, maxRows],
          world: "MAIN",
        });

        const res = results[0]?.result as { text: string } | { error: string } | undefined;
        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage sheet: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage sheet error: ${res.error}`);
        }
        return res;
      } else if (mode === "schema") {
        // schema 模式:读页面作者声明的 JSON-LD/Microdata/OGP。pattern = @type 过滤("*"=全部)
        const format = typeof args.attr === "string" ? args.attr : "summary";
        const maxEntities = Math.min((args.maxResults as number | undefined) ?? 20, 100);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: schemaProbeFunc,
          args: [pattern, format, maxEntities],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { text: string; total: number; truncated: boolean; scanned: Record<string, number> }
          | { error: string }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage schema: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage schema error: ${res.error}`);
        }
        // scanned 只服务于零命中自陈,不进载荷 —— 有命中时形状与其他 mode 一致
        const { scanned, ...payload } = res;
        return withDiagnosis(
          payload,
          res.total === 0
            ? diagnoseEmptySchema({
                ...(scanned as unknown as {
                  ldScripts: number; ldParseErrors: number; itemscopes: number;
                  itemrefsSkipped: number; untypedItems: number; ogMetas: number; iframes: number;
                }),
                // schema 三源都不在 shadow 里(JSON-LD 在 head，OGP 在 meta)，恒 0
                shadowRoots: 0,
                frameScoped: frameId != null,
                typeFilter: pattern === "*" ? null : pattern,
              })
            : null,
        );
      } else if (mode === "tokens") {
        // tokens 模式:抽站点 CSS 自定义属性,给调色板/字阶/间距阶。
        // 负数会让 length >= maxPerGroup 恒真,把每个 token 都算成被截断
        const maxPerGroup = Math.max(1, Math.min((args.maxResults as number | undefined) ?? 40, 200));

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: tokensProbeFunc,
          args: [pattern, maxPerGroup],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | {
              roots: string[];
              total: number;
              showing: number;
              groups: Record<string, unknown[]>;
              truncatedGroups: Record<string, number>;
            }
          | { error: string }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage tokens: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage tokens error: ${res.error}`);
        }
        return withDiagnosis(
          res,
          res.total === 0
            ? "no CSS custom properties matched on :root/body; the site may compile design tokens away at build time (SCSS/Less variables leave no runtime trace) — use mode=style on a representative element instead"
            : null,
        );
      } else if (mode === "style") {
        // style 模式:注入 styleProbeFunc 取 computed color/background(上溯 painted bg)+ WCAG 对比度。
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 10, 50);

        // attr 选组,不传给全四组;组名非法直接报错,别静默返回空对象
        const ALL_GROUPS = ["typography", "box", "paint", "motion", "pseudo", "font"];
        const requested = normalizeCssAttrParam(args.attr as string | undefined);
        const groups = requested ?? ALL_GROUPS;
        const bad = groups.filter((g) => ALL_GROUPS.indexOf(g) === -1);
        if (bad.length > 0) {
          throw vtxError(
            VtxErrorCode.INVALID_PARAMS,
            `vortex_query mode=style: attr must be one or more of ${ALL_GROUPS.join("|")}; got ${bad.join(",")}`,
          );
        }

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: styleProbeFunc,
          args: [pattern, maxResults, groups],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { elements: unknown[]; total: number; showing: number }
          | { error: string }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage style: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage style error: ${res.error}`);
        }
        return finalizeStyleResult(res as StyleProbeResult, {
          wantPseudo: groups.indexOf("pseudo") !== -1,
          wantFont: groups.indexOf("font") !== -1,
          debuggerMgr,
          tabId: tid,
          selector: pattern,
          maxResults,
        });
      } else {
        // component 模式:注入 componentInspectFunc 取 Vue/React 组件链 + 行数据。
        // 默认低(5/depth3):组件实例数据比 css/text 重,且全局预算硬兜底防输出爆炸。
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 5, 10);
        const componentDepth = Math.min(Math.max((args.componentDepth as number | undefined) ?? 3, 1), 12);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: componentInspectFunc,
          args: [pattern, componentDepth, maxResults],
          world: "MAIN",
        });

        const res = results[0]?.result as
          | { components: unknown[]; total: number; showing: number }
          | { error: string; components: never[]; total: number }
          | undefined;

        if (!res) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, "query.queryPage component: executeScript returned no result");
        }
        if ("error" in res && res.error) {
          throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR, `query.queryPage component error: ${res.error}`);
        }
        return res;
      }
    },
  });
}
