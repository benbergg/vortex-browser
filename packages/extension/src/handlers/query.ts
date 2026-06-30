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
):
  | {
      elements: Array<{
        index: number;
        tag: string;
        color: string;
        background: string;
        bgFromAncestor: boolean;
        fontWeight: string;
        fontSize: string;
        contrastRatio: number | null;
        wcagAA: boolean;
        wcagAAA: boolean;
      }>;
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

    // 解析 rgb/rgba → [r,g,b,a];无法解析返 null。
    const parse = (c: string): [number, number, number, number] | null => {
      if (!c) return null;
      const m = c.match(/-?[\d.]+/g);
      if (!m || m.length < 3) return null;
      const n = m.map(Number);
      return [n[0], n[1], n[2], n.length >= 4 ? n[3] : 1];
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
      // 上溯找 painted 背景(⑦:徽章背景常在祖先;自身透明时找最近非透明祖先)。
      let background = cs.backgroundColor;
      let bgFromAncestor = false;
      if (isTransparent(background)) {
        for (let a: HTMLElement | null = el.parentElement, j = 0; a && j < 8; j++, a = a.parentElement) {
          const abg = getComputedStyle(a).backgroundColor;
          if (!isTransparent(abg)) {
            background = abg;
            bgFromAncestor = true;
            break;
          }
        }
      }
      let contrastRatio: number | null = null;
      const fg = parse(color);
      const bg = parse(background);
      if (fg && bg && !isTransparent(background)) {
        const L1 = lum(fg) + 0.05;
        const L2 = lum(bg) + 0.05;
        contrastRatio = Math.round((Math.max(L1, L2) / Math.min(L1, L2)) * 100) / 100;
      }
      elements.push({
        index: i,
        tag: el.tagName.toLowerCase(),
        color,
        background,
        bgFromAncestor,
        fontWeight: cs.fontWeight,
        fontSize: cs.fontSize,
        contrastRatio,
        wcagAA: contrastRatio != null && contrastRatio >= 4.5,
        wcagAAA: contrastRatio != null && contrastRatio >= 7,
      });
    }
    return { elements, total, showing: limit };
  } catch (e) {
    return { error: "style probe error: " + (e instanceof Error ? e.message : String(e)) };
  }
};

export function registerQueryHandlers(router: ActionRouter): void {
  router.registerAll({
    [QueryActions.QUERY_PAGE]: async (args, tabId) => {
      const mode = args.mode as string | undefined;
      const pattern = args.pattern as string | undefined;

      // 参数校验
      if (
        !mode ||
        (mode !== "text" && mode !== "css" && mode !== "component" && mode !== "geometry" && mode !== "style")
      ) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `vortex_query: mode must be 'text', 'css', 'component', 'geometry' or 'style', got ${String(mode)}`,
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
      } else if (mode === "css") {
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
      } else if (mode === "style") {
        // style 模式:注入 styleProbeFunc 取 computed color/background(上溯 painted bg)+ WCAG 对比度。
        const maxResults = Math.min((args.maxResults as number | undefined) ?? 10, 50);

        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: styleProbeFunc,
          args: [pattern, maxResults],
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
        return res;
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
