import { ContentActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { captureAXNodeMap } from "../reasoning/ax-snapshot.js";
import type { CDPAXNode } from "../reasoning/types.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";
import { resolveTargetOptional } from "../lib/resolve-target.js";
import { truncateWithTextTrailer, truncateWithHtmlTrailer } from "../lib/truncate.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";
import {
  TERMINAL_ADAPTERS,
  collectTerminalLines,
  selectTerminal,
  serializeTerminalLines,
  type TerminalProbe,
} from "../lib/terminal-readback.js";

// ---------------------------------------------------------------------------
// content.getAccessibilityTree:Chrome AX 主路径 + DOM 启发式回退
// ---------------------------------------------------------------------------

/** AX 主路径预算:节点 2000 / 深度 20 / name+value 200 字符 / 序列化 1 MiB(UTF-8) */
const AX_TREE_BUDGET = { maxNodes: 2000, maxDepth: 20, maxChars: 200, maxBytes: 1024 * 1024 };
/** DOM 回退路径预算:节点 500 / 深度 10 / 名称 100 字符(经 args 传入页内注入函数) */
const DOM_TREE_BUDGET = { maxNodes: 500, maxDepth: 10, maxChars: 100 };

interface A11yTreeNode {
  role: string;
  name?: string;
  value?: string;
  children?: A11yTreeNode[];
  /** 数据来源:chrome-ax = Chrome 真实 AX 树;dom-heuristic = DOM 启发式回退 */
  source?: "chrome-ax" | "dom-heuristic";
  /** 仅 DOM 回退路径出现:未能取到 Chrome AX 语义 */
  degraded?: true;
  degradedReason?: string;
  /** 触发预算截断(有数据被丢弃)时出现 */
  truncated?: true;
}

function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 字符串上限截断:省略号计入上限(截断后总长 = max) */
function clipText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max - 1) + "…", truncated: true };
}

function summarizeAxError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  const brief = typeof code === "string" ? `${code}: ${message}` : message;
  return brief.length > 200 ? brief.slice(0, 199) + "…" : brief;
}

/**
 * 由 CDP AX 原始索引重建无障碍树。
 * - 根:role=RootWebArea 者,否则取无父节点者;
 * - ignored 节点自身跳过,其有效后代提升到父级并保序(不整棵子树删除);
 * - 不过滤 isInteresting(用 captureAXNodeMap 的不过滤索引),role/name/value 取 Chrome 原值;
 * - 预算:节点 2000 / 深度 20 / name+value 200 字符 / 序列化 1 MiB,超限即停并标 truncated。
 */
function buildAXTree(byNodeId: Map<string, CDPAXNode>): { root: A11yTreeNode | null } {
  const { maxNodes, maxDepth, maxChars, maxBytes } = AX_TREE_BUDGET;
  let truncated = false;
  let nodeCount = 0;

  let rootId: string | undefined;
  for (const [id, node] of byNodeId) {
    if (!node.ignored && node.role?.value === "RootWebArea") {
      rootId = id;
      break;
    }
  }
  if (rootId === undefined) {
    for (const [id, node] of byNodeId) {
      if (node.ignored) continue;
      if (!node.parentId || !byNodeId.has(node.parentId)) {
        rootId = id;
        break;
      }
    }
  }
  if (rootId === undefined) return { root: null };

  const rootSrc = byNodeId.get(rootId)!;
  const produced: Array<{ node: A11yTreeNode; parent: A11yTreeNode | null }> = [];

  const makeNode = (src: CDPAXNode): A11yTreeNode => {
    const node: A11yTreeNode = { role: src.role?.value ?? "generic" };
    const name = clipText((src.name?.value ?? "").trim(), maxChars);
    if (name.text) node.name = name.text;
    if (name.truncated) truncated = true;
    const rawValue = src.value?.value;
    if (typeof rawValue === "string") {
      const value = clipText(rawValue, maxChars);
      if (value.text) node.value = value.text;
      if (value.truncated) truncated = true;
    }
    return node;
  };

  const buildChildren = (src: CDPAXNode, depth: number, parent: A11yTreeNode | null): A11yTreeNode[] => {
    const out: A11yTreeNode[] = [];
    for (const childId of src.childIds ?? []) {
      if (nodeCount >= maxNodes) {
        truncated = true;
        break;
      }
      const child = byNodeId.get(childId);
      if (!child) {
        truncated = true;
        continue;
      }
      if (child.ignored) {
        // ignored 节点自身跳过:其有效后代提升到当前层级并保持原有顺序
        out.push(...buildChildren(child, depth, parent));
        continue;
      }
      if (depth > maxDepth) {
        truncated = true;
        continue;
      }
      const built = makeNode(child);
      nodeCount++;
      produced.push({ node: built, parent });
      const kids = buildChildren(child, depth + 1, built);
      if (kids.length > 0) built.children = kids;
      out.push(built);
    }
    return out;
  };

  const root = makeNode(rootSrc);
  nodeCount++;
  produced.push({ node: root, parent: null });
  // 深度按输出层级计:根为第 1 层,最深节点层级 ≤ maxDepth
  const kids = buildChildren(rootSrc, 2, root);
  if (kids.length > 0) root.children = kids;

  // 有非 ignored 节点未被收录 → 确实丢了数据,必须可见(禁止静默删项)
  let nonIgnored = 0;
  for (const node of byNodeId.values()) if (!node.ignored) nonIgnored++;
  if (nodeCount < nonIgnored) truncated = true;

  root.source = "chrome-ax";
  if (truncated) root.truncated = true;

  // 序列化字节预算:超限则从 DFS 尾部裁剪(保留文档前部的控件),直到落回预算内
  let bytes = utf8Len(JSON.stringify(root));
  if (bytes > maxBytes) {
    truncated = true;
    root.truncated = true;
    bytes = utf8Len(JSON.stringify(root));
    const detached = new Set<A11yTreeNode>();
    const markDetached = (node: A11yTreeNode): void => {
      detached.add(node);
      for (const child of node.children ?? []) markDetached(child);
    };
    while (bytes > maxBytes) {
      const avg = Math.max(1, Math.floor(bytes / Math.max(1, nodeCount)));
      const drop = Math.max(1, Math.ceil((bytes - maxBytes) / avg));
      let removed = 0;
      for (let i = produced.length - 1; i >= 0 && removed < drop; i--) {
        const entry = produced[i];
        if (detached.has(entry.node) || !entry.parent) continue;
        const siblings = entry.parent.children;
        if (!siblings) continue;
        const idx = siblings.indexOf(entry.node);
        if (idx < 0) continue;
        siblings.splice(idx, 1);
        if (siblings.length === 0) delete entry.parent.children;
        markDetached(entry.node);
        removed++;
      }
      if (removed === 0) break;
      bytes = utf8Len(JSON.stringify(root));
    }
    // 极端兜底:子树全裁掉仍超限(根自身过大)时,直接丢掉根的 children
    if (bytes > maxBytes && root.children) {
      delete root.children;
      bytes = utf8Len(JSON.stringify(root));
    }
  }
  if (truncated) root.truncated = true;
  return { root };
}

export function registerContentHandlers(router: ActionRouter, debuggerMgr?: DebuggerManager): void {
  router.registerAll({
    [ContentActions.GET_TEXT]: async (args, tabId) => {
      // v0.8.1: @ref 形式（{index, snapshotId}）也走 page-side path，通过
      // snapshot store 反查 selector。dispatch 层不再 throw "a11y subtree
      // pending"（P0-6, 2026-05-21）。
      const __t = resolveTargetOptional(args);
      const selector = __t?.selector ?? (args.selector as string | undefined);
      const includeRaw = Array.isArray(args.include) ? (args.include as string[]) : null;
      const wantValue = includeRaw != null && includeRaw.includes("value");
      const wantAttrs = includeRaw != null && includeRaw.includes("attrs");
      const wantsStructured = wantValue || wantAttrs;
      // REQ-NNN N0060 京东评测: vortex_extract 支持 img alt 提取 — 京东自营
      // `<img alt="自营">` 角标 + 淘宝/天猫 `<img alt="天猫积分">` 角标能从 extract
      // 召回内容中读到 alt 文字。innerText/textContent 都不读 attribute (alt 是
      // attribute 不是 text node), 需在 page-side 显式遍历 img[alt] 追加。
      // 默认开 (includeAlt=true), 显式 false 关闭 → 行为与现有 innerText 一致
      // (向后兼容, 老脚本/测试不破)。
      const includeAlt = args.includeAlt !== false;
      const maxDepth = typeof args.maxDepth === "number" && args.maxDepth >= 0 ? args.maxDepth : 20;
      // P1: scroll=true 时提取前分步滚动触发懒加载(window 级)。懒加载内容不滚动
      // 不进 DOM,裸 extract 会返回内容但缺目标数据(正确性失败)。详见 0023 设计文档。
      const scroll = args.scroll === true;
      const tid = await getActiveTabId(__t?.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      // 按需加载 dom-resolve：只有解析出 selector 时才需要它。
      // 注入的 func 仅在 sel 非空时才用 window.__vortexDomResolve.queryDeep(sel)；
      // 无 selector 时 root 取 document.body、open shadow 文本由 collectShadowText
      // 自己遍历 el.shadowRoot 拿，本来就不依赖 dom-resolve 模块。
      // 预加载是无条件硬失败：files 注入 3s 不 settle 就抛 PAGE_NOT_READY，
      // 会提前终止这次提取。历史上无 selector 的 extract 请求曾出现该错误
      // （同期同 tab 也有无 selector 的 extract 成功过），本次移除的是一处无谓依赖；
      // 真机是否因此恢复、底层诱因是什么，待 DAST 验证。
      // selector 必须是**解析后**的值（含 index/@ref 从 snapshot 反查出的），
      // 用 args.selector 判断会误伤 ref 路径的 shadow 穿透。
      if (selector) await loadPageSideModule(tid, frameId, "dom-resolve");
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: async (sel: string | null, opts: { wantValue: boolean; wantAttrs: boolean; maxDepth: number; scroll: boolean; includeAlt: boolean; terminalContainers?: string[] }) => {
          try {
            // P1 scroll-to-load：提取前分步滚到底触发懒加载。每步滚到底后在
            // grace 窗口内**轮询等待 scrollHeight 增长**——一旦增长立即进下一步
            // （快站不浪费），grace（1500ms）内无增长即判定懒加载耗尽。
            // 关键：不能用"scrollHeight 短期不变"判停——AJAX 请求在途时 DOM 尚未
            // append，scrollHeight 暂不变，会把"加载中"误判为"已 settle"提前终止、
            // 提取到陈旧快照（live 验证 quotes.toscrape 实证：旧逻辑停在 10 条 +
            // Loading，批次在提取后才落地）。grace 轮询容忍 AJAX 延迟。
            // 硬上限 15 步 + 15s deadline 为无限滚动信息流封顶（优雅降级）。
            // 提取后恢复原 scrollY 不扰用户视图；innerText 读全 DOM 与滚动位置无关，
            // 懒加载内容一旦 append 即持久（虚拟列表 DOM 回收为非目标）。
            if (opts.scroll) {
              const MAX_SCROLL_STEPS = 15;
              const __origScrollY = window.scrollY;
              const __deadline = Date.now() + 15000;
              for (let __s = 0; __s < MAX_SCROLL_STEPS && Date.now() < __deadline; __s++) {
                const __before = document.documentElement.scrollHeight;
                window.scrollTo(0, __before);
                let __grew = false;
                const __graceEnd = Date.now() + 1500;
                while (Date.now() < __graceEnd) {
                  await new Promise((r) => setTimeout(r, 200));
                  if (document.documentElement.scrollHeight > __before) {
                    __grew = true;
                    break;
                  }
                }
                if (!__grew) break;
              }
              window.scrollTo(0, __origScrollY);
            }

            // Hidden 检查：display:none / visibility:hidden / [hidden] 自身或祖先
            // —— Chrome 的 el.innerText 在 display:none 元素上仍返回 textContent，
            // 违反 schema 描述 "Extract visible text"。这里显式过滤。
            const isHiddenChain = (el: Element | null): boolean => {
              for (let cur: Element | null = el; cur; cur = cur.parentElement) {
                if (cur.nodeType !== 1) continue;
                if ((cur as HTMLElement).hidden) return true;
                const cs = getComputedStyle(cur);
                if (cs.display === "none" || cs.visibility === "hidden") return true;
              }
              return false;
            };

            // 构造从 root 到 el 的稳定 path（用 nth-of-type / id 优先）
            const buildPath = (el: Element, root: Element): string => {
              const parts: string[] = [];
              let cur: Element | null = el;
              while (cur && cur !== root && cur.nodeType === 1) {
                const tag = cur.tagName.toLowerCase();
                if (cur.id) {
                  parts.unshift(`${tag}#${cur.id}`);
                  break;
                }
                const parent = cur.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
                  const idx = siblings.indexOf(cur);
                  parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx + 1})` : tag);
                } else {
                  parts.unshift(tag);
                }
                cur = parent;
              }
              return parts.join(" > ");
            };

            interface ControlInfo {
              path: string;
              tag: string;
              type?: string;
              name?: string;
              id?: string;
              value?: string | string[];
              checked?: boolean;
              selected?: boolean;
              attrs?: Record<string, string>;
            }

            const SELECTABLE_ATTRS = ["id", "name", "type", "role", "aria-label", "aria-labelledby", "placeholder", "title", "data-testid"];

            const pickAttrs = (el: Element): Record<string, string> => {
              const out: Record<string, string> = {};
              for (const a of SELECTABLE_ATTRS) {
                const v = el.getAttribute(a);
                if (v != null) out[a] = v;
              }
              // data-* 全集（前 8 个，防爆炸）
              let dataCount = 0;
              for (const attr of Array.from(el.attributes)) {
                if (attr.name.startsWith("data-") && !(attr.name in out)) {
                  out[attr.name] = attr.value;
                  if (++dataCount >= 8) break;
                }
              }
              return out;
            };

            const extractControl = (el: Element, root: Element): ControlInfo | null => {
              const tag = el.tagName.toLowerCase();
              if (tag !== "input" && tag !== "textarea" && tag !== "select" && !(el as HTMLElement).isContentEditable) {
                return null;
              }
              if (isHiddenChain(el) && !(tag === "input" && (el as HTMLInputElement).type === "hidden")) {
                return null;
              }
              const ci: ControlInfo = { path: buildPath(el, root), tag };
              const idA = el.getAttribute("id");
              const nameA = el.getAttribute("name");
              if (idA) ci.id = idA;
              if (nameA) ci.name = nameA;
              if (tag === "input") {
                const inp = el as HTMLInputElement;
                ci.type = inp.type || "text";
                if (inp.type === "checkbox" || inp.type === "radio") {
                  ci.checked = inp.checked;
                  if (inp.value && inp.value !== "on") ci.value = inp.value;
                } else {
                  ci.value = inp.value;
                }
              } else if (tag === "textarea") {
                ci.value = (el as HTMLTextAreaElement).value;
              } else if (tag === "select") {
                const sel = el as HTMLSelectElement;
                if (sel.multiple) {
                  ci.value = Array.from(sel.selectedOptions).map(o => o.value);
                } else {
                  ci.value = sel.value;
                  const opt = sel.options[sel.selectedIndex];
                  if (opt) ci.selected = true;
                }
              } else {
                // contenteditable
                ci.type = "contenteditable";
                ci.value = (el as HTMLElement).textContent ?? "";
              }
              if (opts.wantAttrs) ci.attrs = pickAttrs(el);
              return ci;
            };

            const walkControls = (root: Element, maxDepth: number): ControlInfo[] => {
              const out: ControlInfo[] = [];
              const stack: Array<{ el: Element; d: number }> = [{ el: root, d: 0 }];
              let visited = 0;
              while (stack.length && visited < 2000) {
                const { el, d } = stack.pop()!;
                visited++;
                const ci = extractControl(el, root);
                if (ci) out.push(ci);
                if (d < maxDepth) {
                  // open shadow root 内的表单控件:root 经 queryDeep 已穿 shadow 解析,
                  // 但子树遍历只走 light-DOM el.children 会漏掉 shadow 内 input/select
                  // (OBS-3 silent-false-success)。同 querySelectorAllDeep 语义,下钻
                  // 时也枚举 open shadowRoot 子节点(closed shadowRoot 为 null,符合 CE spec)。
                  const sr = (el as HTMLElement).shadowRoot;
                  if (sr) {
                    for (const child of Array.from(sr.children)) {
                      stack.push({ el: child, d: d + 1 });
                    }
                  }
                  for (const child of Array.from(el.children)) {
                    stack.push({ el: child, d: d + 1 });
                  }
                }
              }
              return out;
            };

            const root: Element | null = sel
              ? ((window as any).__vortexDomResolve.queryDeep(sel) as Element | null)
              : document.body;
            if (sel && !root) return { error: `Element not found: ${sel}` };
            if (!root) return { result: "" };
            const hidden = isHiddenChain(root);
            const inner = (root as HTMLElement).innerText ?? "";
            // open shadow 穿透:Chrome 的 innerText **不进 shadow tree**,页面用
            // web component 时 shadow 内可见文本被静默漏掉(silent-false-negative,
            // 与 observe/walkControls 已穿 open shadow 不对称,违反 "visible text"
            // 契约;实机复现 2026-06-20:open shadow canary 被 extract 漏、被 observe
            // 召回)。遍历 root 子树找 open shadow host(closed shadowRoot 读为 null,
            // 浏览器硬限制、两原语都不可达),取其 shadow 子树 innerText,includes 去重
            // 追加(slot 投影的 light 文本已在 base 里,去重避免重复;live spike 验证
            // slot 组件无重复,同 walkWithAlt 既有取舍)。
            const collectShadowText = (rootEl: Element, base: string): string => {
              let result = base;
              const stack: Element[] = [rootEl];
              let visited = 0;
              while (stack.length && visited < 5000) {
                const el = stack.pop()!;
                visited++;
                const sr = (el as { shadowRoot?: ShadowRoot | null }).shadowRoot;
                if (sr) {
                  for (const sc of Array.from(sr.children)) {
                    const t = ((sc as HTMLElement).innerText ?? "").trim();
                    if (t && !result.includes(t)) result += "\n" + t;
                    stack.push(sc);
                  }
                }
                for (const child of Array.from(el.children)) stack.push(child);
              }
              return result;
            };
            // REQ-NNN N0060 京东评测: innerText 不读 img alt attribute, 京东
            // 自营/淘宝/天猫角标 `<img alt="...">` 是 attribute 不是 text node。
            // walkWithAlt 追加未在 innerText 中出现的 alt 文字 (dedup via
            // includes, 简单有效)。 includeAlt=false 显式关闭 → 行为与
            // 原 innerText 完全一致 (向后兼容)。
            const walkWithAlt = (rootEl: Element, base: string): string => {
              if (!opts.includeAlt) return base;
              let result = base;
              rootEl.querySelectorAll("img[alt]").forEach((img) => {
                const alt = img.getAttribute("alt")?.trim();
                if (alt && !result.includes(alt)) {
                  result = result.length > 0 ? `${result} ${alt}` : alt;
                }
              });
              return result;
            };
            const text = hidden ? "" : walkWithAlt(root, collectShadowText(root, inner));
            // 目标本身就是终端容器（.xterm-rows / .view-lines / .cm-content）时，innerText
            // 是补齐到列宽的行（尾随空格淹没），逻辑行要从行元素读——标记出来，
            // host 侧再采一次逻辑行。
            const terminalRoot = !!root && (opts.terminalContainers ?? []).some((c) => {
              try { return root.matches(c); } catch { return false; }
            });

            if (!opts.wantValue && !opts.wantAttrs) {
              // 普通路径保持 { result: text } 原形（源码级契约：getText 只要 text 时返回纯字符串）
              if (terminalRoot) return { result: text, terminal: true };
              return { result: text };
            }
            const controls = walkControls(root, opts.maxDepth);
            if (terminalRoot) return { result: { text, controls }, terminal: true };
            return { result: { text, controls } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        args: [selector ?? null, { wantValue, wantAttrs, maxDepth, scroll, includeAlt, terminalContainers: Object.values(TERMINAL_ADAPTERS).map((a) => a.container) }],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string; terminal?: boolean };
      if (res?.error) throw vtxError(res.error.startsWith("Element not found:") ? VtxErrorCode.ELEMENT_NOT_FOUND : VtxErrorCode.JS_EXECUTION_ERROR, res.error, selector ? { selector } : undefined);
      let raw = res?.result;
      // 目标是终端容器 → 读逻辑行（逐行取行元素），替掉补齐到列宽的 innerText。
      if (res?.terminal && typeof raw === "string") {
        const probeRes = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: collectTerminalLines,
          args: [TERMINAL_ADAPTERS, selector ?? null],
          world: "MAIN",
        });
        const readback = selectTerminal(probeRes[0]?.result as TerminalProbe | undefined);
        if (readback) raw = serializeTerminalLines(readback.lines);
      }
      // B3-7: 截断上限优先级 maxLength(默认 10KB=10240) > maxBytes(向后兼容) > 默认 10240.
      // 注: truncateWithTextTrailer 的 limit 单位是 code-point(字符)数, maxBytes 历史命名
      // 但单位同为字符(非真字节), 故两者可统一比较.
      const maxBytesArg = args.maxBytes as number | undefined;
      // maxBytes 显式传入时仍按旧范围 [4096, 5242880] 校验(向后兼容契约)
      if (maxBytesArg !== undefined && (!Number.isInteger(maxBytesArg) || maxBytesArg < 4096 || maxBytesArg > 5242880)) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS, `maxBytes must be an integer in [4096, 5242880]; got ${maxBytesArg}`);
      }
      // maxLength 优先于 maxBytes; 缺省 10240(10KB). 范围 [1, 5242880].
      const maxLength = (args.maxLength as number | undefined) ?? maxBytesArg ?? 10240;
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 5242880) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS, `maxLength must be an integer in [1, 5242880]; got ${maxLength}`);
      }
      const effectiveLimit = maxLength;
      if (typeof raw === "string") {
        return truncateWithTextTrailer(raw, effectiveLimit);
      }
      if (raw && typeof raw === "object" && "text" in (raw as Record<string, unknown>)) {
        const obj = raw as { text: string; controls?: unknown };
        const truncated = truncateWithTextTrailer(obj.text, effectiveLimit);
        return { text: truncated, controls: obj.controls };
      }
      return raw;
    },

    [ContentActions.GET_HTML]: async (args, tabId) => {
      const selector = args.selector as string | undefined;
      const tid = await getActiveTabId(args.tabId as number | undefined ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: (sel: string | undefined) => {
          try {
            if (sel) {
              const el = (window as any).__vortexDomResolve.queryDeep(sel);
              if (!el) return { error: `Element not found: ${sel}` };
              return { result: el.outerHTML };
            }
            return { result: document.documentElement.outerHTML };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        args: [selector ?? null],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string };
      if (res?.error) throw vtxError(res.error.startsWith("Element not found:") ? VtxErrorCode.ELEMENT_NOT_FOUND : VtxErrorCode.JS_EXECUTION_ERROR, res.error, selector ? { selector } : undefined);
      const raw = res?.result;
      if (typeof raw !== "string") return raw;
      const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : 131072;
      if (!Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 5242880) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS, `maxBytes must be an integer in [4096, 5242880]; got ${maxBytes}`);
      }
      return truncateWithHtmlTrailer(raw, maxBytes);
    },

    [ContentActions.GET_ACCESSIBILITY_TREE]: async (args, tabId) => {
      const tid = await getActiveTabId(args.tabId as number | undefined ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // DOM 启发式回退路径:未知标签 → generic;所有名称来源统一 100 字符上限。
      const runDomHeuristic = async (degradedReason: string): Promise<A11yTreeNode | null> => {
        const results = await chrome.scripting.executeScript({
          target: buildExecuteTarget(tid, frameId),
          func: (opts: { maxNodes: number; maxDepth: number; maxChars: number }) => {
            try {
              interface A11yNode {
                role: string;
                name?: string;
                children?: A11yNode[];
              }

              let nodeCount = 0;
              let truncated = false;

              // 所有名称来源(aria-label / aria-labelledby 文本 / innerText)统一上限,
              // 省略号计入上限(截断后总长 = maxChars)。
              function clip(text: string): string {
                if (text.length <= opts.maxChars) return text;
                truncated = true;
                return text.slice(0, opts.maxChars - 1) + "…";
              }

              function getRole(el: Element): string {
                const ariaRole = el.getAttribute("role");
                if (ariaRole) return ariaRole;
                const tag = el.tagName.toLowerCase();
                const roleMap: Record<string, string> = {
                  a: "link",
                  button: "button",
                  input: "textbox",
                  select: "listbox",
                  textarea: "textbox",
                  img: "img",
                  h1: "heading",
                  h2: "heading",
                  h3: "heading",
                  h4: "heading",
                  h5: "heading",
                  h6: "heading",
                  nav: "navigation",
                  main: "main",
                  header: "banner",
                  footer: "contentinfo",
                  aside: "complementary",
                  form: "form",
                  table: "table",
                  li: "listitem",
                  ul: "list",
                  ol: "list",
                };
                // 未知标签(自定义元素 / div / span 等)在 Chrome 里的真实 AX role
                // 就是 generic —— 返回标签名是伪 role。
                return roleMap[tag] ?? "generic";
              }

              function getName(el: Element): string | undefined {
                const ariaLabel = el.getAttribute("aria-label");
                if (ariaLabel) return clip(ariaLabel);
                const ariaLabelledBy = el.getAttribute("aria-labelledby");
                if (ariaLabelledBy) {
                  const labelEl = document.getElementById(ariaLabelledBy);
                  if (labelEl) {
                    const labelled = (labelEl as HTMLElement).innerText?.trim();
                    return labelled ? clip(labelled) : undefined;
                  }
                }
                const text = (el as HTMLElement).innerText?.trim();
                if (text) return clip(text);
                return undefined;
              }

              function walkNode(el: Element, depth: number): A11yNode | null {
                if (nodeCount >= opts.maxNodes || depth > opts.maxDepth) {
                  truncated = true;
                  return null;
                }
                nodeCount++;

                const node: A11yNode = { role: getRole(el) };
                const name = getName(el);
                if (name) node.name = name;

                const childNodes: A11yNode[] = [];
                for (const child of Array.from(el.children)) {
                  const childNode = walkNode(child, depth + 1);
                  if (childNode) childNodes.push(childNode);
                  if (nodeCount >= opts.maxNodes) {
                    truncated = true;
                    break;
                  }
                }
                if (childNodes.length > 0) node.children = childNodes;

                return node;
              }

              const tree = walkNode(document.body, 0);
              return { result: tree, truncated };
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
          },
          args: [DOM_TREE_BUDGET],
          world: "MAIN",
        });
        const res = results[0]?.result as { result?: A11yTreeNode; error?: string; truncated?: boolean };
        // AX tree 无 selector 维度，仅透传错误
        if (res?.error) {
          throw vtxError(
            res.error.startsWith("Element not found:")
              ? VtxErrorCode.ELEMENT_NOT_FOUND
              : VtxErrorCode.JS_EXECUTION_ERROR,
            res.error,
          );
        }
        const tree = res?.result;
        if (!tree) return null;
        tree.source = "dom-heuristic";
        tree.degraded = true;
        tree.degradedReason = degradedReason;
        if (res.truncated) tree.truncated = true;
        return tree;
      };

      // AX 主路径只对主 frame 生效(Chrome 扩展 frame id 与 CDP frame id 不同,本轮不做映射)
      const isMainFrame = frameId == null || frameId === 0;
      if (!isMainFrame) return runDomHeuristic("non-main-frame");
      if (!debuggerMgr) return runDomHeuristic("debugger-unavailable");
      try {
        const { byNodeId } = await captureAXNodeMap(debuggerMgr, tid, 0);
        const ax = buildAXTree(byNodeId);
        if (!ax.root) return runDomHeuristic("ax-tree-empty");
        return ax.root;
      } catch (err) {
        // 白名单回退:attach / enableDomain / getFullAXTree 失败(含跨域、A11Y 不可用)
        return runDomHeuristic(summarizeAxError(err));
      }
    },

    [ContentActions.GET_ELEMENT_TEXT]: async (args, tabId) => {
      const selector = args.selector as string;
      if (!selector) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: selector");
      const tid = await getActiveTabId(args.tabId as number | undefined ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: (sel: string) => {
          try {
            const el = (window as any).__vortexDomResolve.queryDeep(sel);
            if (!el) return { error: `Element not found: ${sel}` };
            return { result: el.textContent };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        args: [selector ?? null],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string };
      if (res?.error) throw vtxError(res.error.startsWith("Element not found:") ? VtxErrorCode.ELEMENT_NOT_FOUND : VtxErrorCode.JS_EXECUTION_ERROR, res.error, selector ? { selector } : undefined);
      return res?.result;
    },

    [ContentActions.GET_COMPUTED_STYLE]: async (args, tabId) => {
      const selector = args.selector as string;
      const properties = args.properties as string[] | undefined;
      if (!selector) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: selector");
      const tid = await getActiveTabId(args.tabId as number | undefined ?? tabId);
      const frameId = args.frameId as number | undefined;
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: (sel: string, props: string[] | undefined) => {
          try {
            const el = (window as any).__vortexDomResolve.queryDeep(sel);
            if (!el) return { error: `Element not found: ${sel}` };
            const style = window.getComputedStyle(el);
            const defaultProps = [
              "display",
              "position",
              "width",
              "height",
              "color",
              "backgroundColor",
              "fontSize",
              "margin",
              "padding",
              "border",
            ];
            const targetProps = props ?? defaultProps;
            const result: Record<string, string> = {};
            for (const prop of targetProps) {
              result[prop] = style.getPropertyValue(
                prop.replace(/([A-Z])/g, "-$1").toLowerCase(),
              );
            }
            return { result };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        args: [selector, properties ?? null],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string };
      if (res?.error) throw vtxError(res.error.startsWith("Element not found:") ? VtxErrorCode.ELEMENT_NOT_FOUND : VtxErrorCode.JS_EXECUTION_ERROR, res.error, selector ? { selector } : undefined);
      return res?.result;
    },
  });
}
