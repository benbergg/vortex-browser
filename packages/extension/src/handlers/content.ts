import { ContentActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";
import { resolveTargetOptional } from "../lib/resolve-target.js";
import { truncateWithTextTrailer, truncateWithHtmlTrailer } from "../lib/truncate.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";

export function registerContentHandlers(router: ActionRouter): void {
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
      const maxDepth = typeof args.maxDepth === "number" && args.maxDepth >= 0 ? args.maxDepth : 20;
      // P1: scroll=true 时提取前分步滚动触发懒加载(window 级)。懒加载内容不滚动
      // 不进 DOM,裸 extract 会返回内容但缺目标数据(正确性失败)。详见 0023 设计文档。
      const scroll = args.scroll === true;
      const tid = await getActiveTabId(__t?.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: async (sel: string | null, opts: { wantValue: boolean; wantAttrs: boolean; maxDepth: number; scroll: boolean }) => {
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
            const text = hidden ? "" : (root as HTMLElement).innerText ?? "";

            if (!opts.wantValue && !opts.wantAttrs) {
              return { result: text };
            }
            const controls = walkControls(root, opts.maxDepth);
            return { result: { text, controls } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        args: [selector ?? null, { wantValue, wantAttrs, maxDepth, scroll }],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string };
      if (res?.error) throw vtxError(res.error.startsWith("Element not found:") ? VtxErrorCode.ELEMENT_NOT_FOUND : VtxErrorCode.JS_EXECUTION_ERROR, res.error, selector ? { selector } : undefined);
      const raw = res?.result;
      const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : 131072;
      if (!Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 5242880) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS, `maxBytes must be an integer in [4096, 5242880]; got ${maxBytes}`);
      }
      if (typeof raw === "string") {
        return truncateWithTextTrailer(raw, maxBytes);
      }
      if (raw && typeof raw === "object" && "text" in (raw as Record<string, unknown>)) {
        const obj = raw as { text: string; controls?: unknown };
        const truncated = truncateWithTextTrailer(obj.text, Math.max(4096, Math.floor(maxBytes / 2)));
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
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: () => {
          try {
            interface A11yNode {
              role: string;
              name?: string;
              children?: A11yNode[];
            }

            let nodeCount = 0;

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
              return roleMap[tag] ?? tag;
            }

            function getName(el: Element): string | undefined {
              const ariaLabel = el.getAttribute("aria-label");
              if (ariaLabel) return ariaLabel;
              const ariaLabelledBy = el.getAttribute("aria-labelledby");
              if (ariaLabelledBy) {
                const labelEl = document.getElementById(ariaLabelledBy);
                if (labelEl) return (labelEl as HTMLElement).innerText?.trim();
              }
              const text = (el as HTMLElement).innerText?.trim();
              if (text) return text.slice(0, 100);
              return undefined;
            }

            function walkNode(el: Element, depth: number): A11yNode | null {
              if (nodeCount >= 500 || depth > 10) return null;
              nodeCount++;

              const node: A11yNode = { role: getRole(el) };
              const name = getName(el);
              if (name) node.name = name;

              const childNodes: A11yNode[] = [];
              for (const child of Array.from(el.children)) {
                const childNode = walkNode(child, depth + 1);
                if (childNode) childNodes.push(childNode);
                if (nodeCount >= 500) break;
              }
              if (childNodes.length > 0) node.children = childNodes;

              return node;
            }

            const tree = walkNode(document.body, 0);
            return { result: tree };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        args: [],
        world: "MAIN",
      });
      const res = results[0]?.result as { result?: unknown; error?: string };
      // AX tree 无 selector 维度，仅透传错误
      if (res?.error) {
        throw vtxError(
          res.error.startsWith("Element not found:")
            ? VtxErrorCode.ELEMENT_NOT_FOUND
            : VtxErrorCode.JS_EXECUTION_ERROR,
          res.error,
        );
      }
      return res?.result;
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
