import { DomActions, VtxErrorCode, vtxError } from "@bytenew/vortex-shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";
import { resolveTarget, resolveTargetOptional } from "../lib/resolve-target.js";
import { pageQuery as nativePageQuery, mapPageError } from "../adapter/native.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";
import { clickBBox as cdpClickBBox, cdpClickElement } from "../adapter/cdp.js";
import { getIframeOffset } from "../lib/iframe-offset.js";
import {
  runCascaderDriverCDP,
  runDateRangeDriverCDP,
  runTimePickerDriverCDP,
} from "../adapter/cdp-drivers/index.js";
import {
  FILL_REJECT_PATTERNS,
  findDriver,
  COMMIT_DRIVERS,
  type CommitKind,
} from "../patterns/index.js";
import { waitActionable } from "../action/auto-wait.js";

export function registerDomHandlers(
  router: ActionRouter,
  debuggerMgr: DebuggerManager,
): void {
  router.registerAll({
    [DomActions.QUERY]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string) => {
          try {
            const el = document.querySelector(sel);
            if (!el) return { result: null };
            const attrs: Record<string, string> = {};
            for (const attr of Array.from(el.attributes)) {
              attrs[attr.name] = attr.value;
            }
            return {
              result: {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                classes: Array.from(el.classList),
                text: (el as HTMLElement).innerText?.slice(0, 500),
                attributes: attrs,
              },
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.QUERY_ALL]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string) => {
          try {
            const elements = Array.from(document.querySelectorAll(sel)).slice(0, 100);
            return {
              result: elements.map((el) => {
                const attrs: Record<string, string> = {};
                for (const attr of Array.from(el.attributes)) {
                  attrs[attr.name] = attr.value;
                }
                return {
                  tag: el.tagName.toLowerCase(),
                  id: el.id || undefined,
                  classes: Array.from(el.classList),
                  text: (el as HTMLElement).innerText?.slice(0, 200),
                  attributes: attrs,
                };
              }),
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.CLICK]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const useRealMouse = args.useRealMouse as boolean | undefined;

      // L2 integration: actionability + auto-wait pre-check
      await waitActionable(tid, frameId, selector, { timeout: (args.timeout as number | undefined) ?? 5000 });

      if (useRealMouse) {
        return await cdpClickElement(debuggerMgr, tid, frameId, selector);
      }

      // 普通 element.click() 路径（含失败探测）
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const results = await chrome.scripting.executeScript({
        target: buildExecuteTarget(tid, frameId),
        func: (sel: string) => {
          try {
            // 探测阶段：逐项检查失败原因，细化错误码
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            if (els.length > 1) {
              return {
                errorCode: "SELECTOR_AMBIGUOUS",
                error: `Selector "${sel}" matched ${els.length} elements`,
                extras: { matchCount: els.length },
              };
            }
            const el = els[0] as HTMLElement;
            if ((el as HTMLInputElement).disabled === true) {
              return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
            }
            const rect0 = el.getBoundingClientRect();
            if (rect0.width === 0 || rect0.height === 0) {
              return {
                errorCode: "ELEMENT_DETACHED",
                error: `Element ${sel} has zero dimensions (detached or hidden)`,
              };
            }
            // offscreen 检查（滚入视口之前）
            const inView =
              rect0.top < window.innerHeight &&
              rect0.bottom > 0 &&
              rect0.left < window.innerWidth &&
              rect0.right > 0;
            if (!inView) {
              return {
                errorCode: "ELEMENT_OFFSCREEN",
                error: `Element ${sel} is outside the viewport`,
              };
            }
            // 滚入视口后做 occlusion 检查
            el.scrollIntoView({ block: "center", inline: "center" });
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            // 使用穿 shadow 的 deepElementFromPoint，避免对 shadow-internal 元素返回 shadow host
            // 导致 host.contains(el) 不穿 shadow 而误判 ELEMENT_OCCLUDED。
            const topEl = (window as any).__vortexDomResolve.deepElementFromPoint(cx, cy);
            // 复合输入控件(Element Plus el-select 等)把可见显示层(placeholder /
            // selected-item)作为兄弟节点叠在透明真控件之上。hit-test 命中显示层兄弟——
            // 既非 target 也非其后代——但它非交互且与 target 同处一个交互 widget 容器
            // (el 的最近交互祖先 contains hit),点击经显示层冒泡仍到达控件,非真遮挡。
            // 与 actionability.ts / cdp.ts 的 carve-out 同源(2026-06-01 el-select dogfood)。
            const isInteractiveEl = (x: Element): boolean => {
              const t = x.tagName.toLowerCase();
              return (
                !!x.getAttribute("role") ||
                x.getAttribute("tabindex") != null ||
                t === "button" ||
                t === "a" ||
                t === "input" ||
                t === "select" ||
                t === "textarea"
              );
            };
            let sameWidgetDecoration = false;
            if (topEl && !isInteractiveEl(topEl)) {
              let w: Element | null = el.parentElement;
              while (w && w !== document.documentElement) {
                if (isInteractiveEl(w)) {
                  if (w.contains(topEl)) sameWidgetDecoration = true;
                  break;
                }
                w = w.parentElement;
              }
            }
            if (
              topEl &&
              topEl !== el &&
              !el.contains(topEl) &&
              !topEl.contains(el) &&
              !sameWidgetDecoration
            ) {
              const classStr =
                typeof topEl.className === "string" && topEl.className
                  ? "." + topEl.className.split(" ").filter(Boolean).join(".")
                  : "";
              const desc =
                topEl.tagName.toLowerCase() +
                (topEl.id ? "#" + topEl.id : "") +
                classStr;
              return {
                errorCode: "ELEMENT_OCCLUDED",
                error: `Element ${sel} is covered by <${desc}>`,
                extras: { blocker: desc },
              };
            }
            // 通过所有检查，执行 click；对可 focus 元素（input/textarea/button/select）
            // 先 focus 再 click，保证后续 vortex_press 键盘事件能落在 active element 上
            // （JS .click() 不像真实鼠标那样顺带 focus，修掉这个行为差异）
            if (typeof (el as HTMLElement).focus === "function") {
              try {
                (el as HTMLElement).focus();
              } catch {
                // swallow: focus 不是所有元素都支持
              }
            }
            // Dispatch full pointer/mouse event sequence so frameworks that
            // hook mousedown/mouseup (AngularJS Material $mdGesture/tapClick,
            // Hammer.js, Ant Design v3 Select, pre-3.0 Element UI Select)
            // observe what looks like a real tap. Without this, those
            // frameworks see only a lone click() and silently ignore it,
            // which is why md-select dropdowns refused to open during the
            // 2026-05-21 RocketMQ dogfood (BUG 8, P0).
            //
            // Order matches the W3C "click activation" spec: pointerdown →
            // mousedown → pointerup → mouseup → click. We then still call
            // el.click() so element-level click handlers (form submit /
            // anchor navigation) fire reliably even when intermediate
            // listeners stopPropagation.
            const ptrInit: PointerEventInit = {
              bubbles: true, cancelable: true, composed: true, view: window,
              button: 0, buttons: 1, clientX: cx, clientY: cy,
              pointerType: "mouse", pointerId: 1, isPrimary: true,
            };
            const mouseDown: MouseEventInit = {
              bubbles: true, cancelable: true, composed: true, view: window,
              button: 0, buttons: 1, clientX: cx, clientY: cy,
            };
            const mouseUp: MouseEventInit = {
              bubbles: true, cancelable: true, composed: true, view: window,
              button: 0, buttons: 0, clientX: cx, clientY: cy,
            };
            try { el.dispatchEvent(new PointerEvent("pointerdown", ptrInit)); } catch { /* PointerEvent unsupported */ }
            el.dispatchEvent(new MouseEvent("mousedown", mouseDown));
            try { el.dispatchEvent(new PointerEvent("pointerup", { ...ptrInit, buttons: 0 })); } catch { /* */ }
            el.dispatchEvent(new MouseEvent("mouseup", mouseUp));
            el.click();
            return {
              result: {
                success: true,
                element: {
                  tag: el.tagName.toLowerCase(),
                  id: el.id || undefined,
                  text: el.innerText?.slice(0, 200),
                },
              },
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        args: [selector],
        world: "MAIN",
      });
      const res = results[0]?.result as {
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      };
      if (res?.error) {
        const code: VtxErrorCode =
          res.errorCode && res.errorCode in VtxErrorCode
            ? (res.errorCode as VtxErrorCode)
            : res.error.startsWith("Element not found:")
              ? VtxErrorCode.ELEMENT_NOT_FOUND
              : VtxErrorCode.JS_EXECUTION_ERROR;
        throw vtxError(code, res.error, { selector, extras: res.extras });
      }
      return res?.result;
    },

    [DomActions.TYPE]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const text = args.text as string;
      const delay = (args.delay as number | undefined) ?? 0;
      if (text == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: text");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // L2 integration: actionability + auto-wait pre-check (editable required)
      await waitActionable(tid, frameId, selector, { timeout: (args.timeout as number | undefined) ?? 5000, needsEditable: true });

      // Probe target: shared validation + contentEditable detection.
      // The page-side handler below runs the legacy
      // dispatch-KeyboardEvent + el.value path used by every
      // input/textarea case in bench. Rich-text editors
      // (ProseMirror / Slate / Lexical / Notion / Confluence) reject
      // synthetic events (isTrusted=false) and don't expose .value,
      // so the host-side code routes them through CDP Input.insertText
      // — the only path that produces a native browser-source input
      // event capable of driving a real rich-text editor's
      // beforeinput → transaction pipeline.
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector。
      // 此处单次加载同时覆盖下方两处查询站点：probe（actionability 检测）与 input/textarea dispatch。
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const probe = await nativePageQuery<{
        ok?: true;
        isContentEditable?: boolean;
        errorCode?: string;
        error?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (sel: string) => {
          const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
          if (els.length === 0) {
            return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
          }
          if (els.length > 1) {
            return {
              errorCode: "SELECTOR_AMBIGUOUS",
              error: `Selector "${sel}" matched ${els.length} elements`,
              extras: { matchCount: els.length },
            };
          }
          const el = els[0] as HTMLElement;
          if ((el as HTMLInputElement).disabled === true) {
            return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
          }
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            return {
              errorCode: "ELEMENT_DETACHED",
              error: `Element ${sel} has zero dimensions (detached or hidden)`,
            };
          }
          const inView =
            rect.top < window.innerHeight &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.right > 0;
          if (!inView) {
            return {
              errorCode: "ELEMENT_OFFSCREEN",
              error: `Element ${sel} is outside the viewport`,
            };
          }
          // Pre-focus so the upcoming CDP insertText / dispatch
          // event chain has a focused element to land on. focus()
          // is idempotent if the element is already active.
          el.focus();
          return { ok: true, isContentEditable: el.isContentEditable === true };
        },
        [selector],
      );
      if (probe?.error) {
        mapPageError(probe, selector);
      }

      if (probe?.isContentEditable) {
        // contentEditable path — Input.insertText is the only way to
        // produce a trusted beforeinput event that ProseMirror /
        // Slate / Lexical / Notion / Confluence will accept.
        // Delay is honored by chunking per character; default 0
        // sends the whole text in one IPC roundtrip.
        await debuggerMgr.attach(tid);
        if (delay > 0) {
          for (const ch of text) {
            await debuggerMgr.sendCommand(tid, "Input.insertText", { text: ch });
            await new Promise((r) => setTimeout(r, delay));
          }
        } else {
          await debuggerMgr.sendCommand(tid, "Input.insertText", { text });
        }
        return { success: true, typed: text.length, path: "cdp-insertText" };
      }

      // input / textarea path — legacy synthetic dispatch (kept
      // byte-identical to v0.8 for every passing case in bench).
      const res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        async (sel: string, txt: string, delayMs: number) => {
          try {
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            const el = els[0] as HTMLInputElement;
            el.focus();
            for (const char of txt) {
              const eventInit = { key: char, bubbles: true, cancelable: true };
              el.dispatchEvent(new KeyboardEvent("keydown", eventInit));
              el.dispatchEvent(new KeyboardEvent("keypress", eventInit));
              if (el.value !== undefined) el.value += char;
              el.dispatchEvent(new InputEvent("input", { bubbles: true, data: char }));
              el.dispatchEvent(new KeyboardEvent("keyup", eventInit));
              if (delayMs > 0) {
                await new Promise((r) => setTimeout(r, delayMs));
              }
            }
            return { result: { success: true, typed: txt.length, path: "page-side-dispatch" } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector, text, delay ?? 0],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.FILL]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const value = args.value as string;
      const fallbackToNative = args.fallbackToNative === true;
      if (value == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: value");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // L2 integration: actionability + auto-wait pre-check (editable required)
      await waitActionable(tid, frameId, selector, { timeout: (args.timeout as number | undefined) ?? 5000, needsEditable: true });

      // === framework-aware rejection via page-side bundle (@since 0.4.0, migrated T2.7a) ===
      if (!fallbackToNative) {
        await loadPageSideModule(tid, frameId, "fill-reject");
        const rejectResult = await nativePageQuery<
          | { rejected: false }
          | { rejected: true; errorCode: string; error: string; extras: Record<string, unknown> }
          | undefined
        >(
          tid,
          frameId,
          (sel: string, patterns: unknown) =>
            (window as any).__vortexFillReject.checkRejectPattern(sel, patterns),
          [selector, FILL_REJECT_PATTERNS],
        );
        if (rejectResult?.rejected) {
          const r = rejectResult as { rejected: true; errorCode: string; error: string; extras: Record<string, unknown> };
          mapPageError(r, selector);
        }
      }

      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (sel: string, val: string) => {
          try {
            // === element probes (in sync with CLICK) ===
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            if (els.length > 1) {
              return {
                errorCode: "SELECTOR_AMBIGUOUS",
                error: `Selector "${sel}" matched ${els.length} elements`,
                extras: { matchCount: els.length },
              };
            }
            const el = els[0] as HTMLInputElement;
            if (el.disabled === true) {
              return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return {
                errorCode: "ELEMENT_DETACHED",
                error: `Element ${sel} has zero dimensions (detached or hidden)`,
              };
            }
            const inView =
              rect.top < window.innerHeight &&
              rect.bottom > 0 &&
              rect.left < window.innerWidth &&
              rect.right > 0;
            if (!inView) {
              return {
                errorCode: "ELEMENT_OFFSCREEN",
                error: `Element ${sel} is outside the viewport`,
              };
            }
            // 元素类型分流:isEditable 门放行的类型(input/textarea/select/
            // contenteditable)比 fill 写值逻辑能正确处理的多。对非 text-like 的元素,
            // 回退 `el.value = val` 要么被原生静默忽略、要么写错属性,伪装成
            // success:true 实则页面无变化(silent false-success)。逐类响亮报错指引正确 action。
            // (2026-06-03 act 原语白盒审计族 B)
            //
            // contenteditable → type(走 CDP Input.insertText 正确驱动)。
            if (el.isContentEditable) {
              return {
                errorCode: "INVALID_TARGET",
                error: `Element ${sel} is contentEditable; use action "type" instead of "fill"`,
              };
            }
            // 原生 <select> → select(fill 设 el.value 仅按 option value 匹配,传可见
            // 文本会被静默忽略并清空选中;SELECT handler 有 value→文本→label 回退)。
            if (el instanceof HTMLSelectElement) {
              return {
                errorCode: "INVALID_TARGET",
                error: `Element ${sel} is a <select>; use action "select" instead of "fill"`,
              };
            }
            // checkbox/radio → click(fill 的原生 value setter 写的是 value 属性即
            // 提交值,不是 checked 状态;勾选/取消勾选要靠 click 切换)。
            if (
              el instanceof HTMLInputElement &&
              (el.type === "checkbox" || el.type === "radio")
            ) {
              return {
                errorCode: "INVALID_TARGET",
                error: `Element ${sel} is a ${el.type}; use action "click" to toggle it instead of "fill"`,
              };
            }
            // === fill operation ===
            // 走原生 value setter 是为绕过 React 受控组件覆盖的 setter,但必须按元素
            // 实际类型取:textarea 用 HTMLTextAreaElement、input 用 HTMLInputElement。
            // 用错类型(如对 <textarea> 调用 HTMLInputElement 的 setter)会触发浏览器
            // 对原生访问器的品牌检查抛 "Illegal invocation"——Bing/Google 搜索框、评论框
            // 等都是 textarea,误用 input setter 会让 fill 对整类失效。
            const valueProto =
              el instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : el instanceof HTMLInputElement
                  ? window.HTMLInputElement.prototype
                  : null;
            const nativeValueSetter = valueProto
              ? Object.getOwnPropertyDescriptor(valueProto, "value")?.set
              : undefined;
            if (nativeValueSetter) {
              nativeValueSetter.call(el, val);
            } else {
              el.value = val;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            // 回读校验副作用真发生:type=number/date/email 等对非法格式的值,原生 setter
            // 静默置空(el.value="")。传了非空值却读回空 = 输入被拒,报 NO_EFFECT 而非
            // 假成功(2026-06-03 act 原语白盒审计族 A,#7)。仅判「非空→空」的明确拒绝,
            // 不误伤值规范化(如 number "007"→"7")。
            if (String(val) !== "" && (el as HTMLInputElement).value === "") {
              return {
                errorCode: "NO_EFFECT",
                error: `Element ${sel} rejected value "${String(val)}" (likely a format/type constraint, e.g. type=number/date); value is empty after fill`,
                extras: { attempted: String(val), type: (el as HTMLInputElement).type },
              };
            }
            return { result: { success: true } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector, value],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.SELECT]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      // value 可为单值(string)或数组(string[],原生 <select multiple> 多选)。
      const value = args.value as string | string[];
      if (value == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: value");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // L2 integration: actionability + auto-wait pre-check
      await waitActionable(tid, frameId, selector, { timeout: (args.timeout as number | undefined) ?? 5000 });

      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (sel: string, val: string | string[]) => {
          try {
            // === 探测（与 CLICK 同步）===
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            if (els.length > 1) {
              return {
                errorCode: "SELECTOR_AMBIGUOUS",
                error: `Selector "${sel}" matched ${els.length} elements`,
                extras: { matchCount: els.length },
              };
            }
            const el = els[0] as HTMLSelectElement;
            if (el.disabled === true) {
              return { errorCode: "ELEMENT_DISABLED", error: `Element ${sel} is disabled` };
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return {
                errorCode: "ELEMENT_DETACHED",
                error: `Element ${sel} has zero dimensions (detached or hidden)`,
              };
            }
            const inView =
              rect.top < window.innerHeight &&
              rect.bottom > 0 &&
              rect.left < window.innerWidth &&
              rect.right > 0;
            if (!inView) {
              return {
                errorCode: "ELEMENT_OFFSCREEN",
                error: `Element ${sel} is outside the viewport`,
              };
            }
            // === select 操作 ===
            // 原生 <select>:el.value=val 仅按 option 的 value 属性匹配,且选不中时
            // value 静默变 "" / selectedIndex 变 -1。调用方(尤其 agent)常只看得到可见
            // 文本(observe 不枚举 option),故按 value → 可见文本(label) → label 属性
            // 依次回退;全不中则报错而非假成功(2026-06-01 native-select dogfood)。
            const opts = Array.from(el.options);
            const norm = (s: string) => s.replace(/\s+/g, " ").trim();
            const matchOption = (one: string): HTMLOptionElement | null => {
              const t = norm(String(one));
              return (
                opts.find((o) => o.value === one) ??
                opts.find((o) => norm(o.text) === t) ??
                opts.find((o) => o.label != null && norm(o.label) === t) ??
                null
              );
            };

            // 数组 value = 多选(原生 <select multiple>)。单值赋值 el.value 只能选中
            // 一个 option,多选必须逐 option 设 .selected;全中才提交,任一不中报错而非
            // 部分假成功(2026-06-03 多选 dogfood,act 原语白盒审计族 E)。
            if (Array.isArray(val)) {
              if (!el.multiple) {
                return {
                  errorCode: "INVALID_PARAMS",
                  error: `<select> ${sel} is not multiple; pass a single value, not an array`,
                };
              }
              // 去重:数组里两项可能解析到同一 option(如 ["Apple","Apple"],或一个按
              // value、一个按可见文本命中同一项)。不去重则 matched 计数 > selectedOptions
              // 实际选中数,下面回读校验会误报 NO_EFFECT。
              const matched: HTMLOptionElement[] = [];
              const seen = new Set<HTMLOptionElement>();
              const unmatched: string[] = [];
              for (const one of val as string[]) {
                const m = matchOption(one);
                if (!m) {
                  unmatched.push(String(one));
                  continue;
                }
                if (!seen.has(m)) {
                  seen.add(m);
                  matched.push(m);
                }
              }
              if (unmatched.length > 0) {
                return {
                  errorCode: "NO_MATCHING_OPTION",
                  error: `<select> ${sel} has no option matching ${JSON.stringify(unmatched)} (by value or visible text)`,
                  extras: {
                    unmatched,
                    available: opts.map((o) => o.value || o.text).slice(0, 30),
                  },
                };
              }
              for (const o of opts) o.selected = false;
              for (const m of matched) m.selected = true;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              // 回读校验副作用真发生(disabled option 可能拒绝选中):selectedOptions
              // 必须与意图一致,否则报 NO_EFFECT 而非假成功。
              const selectedNow = Array.from(el.selectedOptions).map((o) => o.value);
              if (selectedNow.length !== matched.length) {
                return {
                  errorCode: "NO_EFFECT",
                  error: `<select> ${sel} multi-select did not fully apply (expected ${matched.length} selected, got ${selectedNow.length}; check for disabled options)`,
                  extras: { selected: selectedNow },
                };
              }
              return { result: { success: true, value: selectedNow } };
            }

            // 单值
            const opt = matchOption(val as string);
            if (!opt) {
              return {
                errorCode: "NO_MATCHING_OPTION",
                error: `<select> ${sel} has no option matching "${String(val)}" (by value or visible text)`,
                extras: {
                  available: opts.map((o) => o.value || o.text).slice(0, 30),
                },
              };
            }
            el.value = opt.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { result: { success: true, value: el.value } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector, value],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.SCROLL]: async (args, tabId) => {
      const __t = resolveTargetOptional(args);
      const selector = __t?.selector;
      const container = args.container as string | undefined;
      const position = args.position as string | undefined;
      const x = args.x as number | undefined;
      const y = args.y as number | undefined;
      if (!selector && !position && x === undefined && y === undefined) {
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          "Must specify selector/index, position, or x/y coordinates",
        );
      }
      const tid = await getActiveTabId(__t?.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (
          sel: string | undefined,
          cont: string | undefined,
          pos: string | undefined,
          sx: number | undefined,
          sy: number | undefined,
        ) => {
          try {
            // 找最近 scrollable 祖先：沿 parentElement 链找 overflow:auto|scroll
            // 且 scrollHeight > clientHeight 的元素。modal 内 overflow:auto 容器
            // 是最常见的"卡在 window 不动"场景（P1-5, 2026-05-21）。
            const findScrollableAncestor = (el: Element | null): Element | null => {
              for (let cur: Element | null = el; cur; cur = cur.parentElement) {
                if (cur === document.documentElement || cur === document.body) break;
                const cs = getComputedStyle(cur);
                const overflowY = cs.overflowY;
                const overflowX = cs.overflowX;
                const scrolls = (overflowY === "auto" || overflowY === "scroll" || overflowX === "auto" || overflowX === "scroll");
                if (scrolls && (cur.scrollHeight > cur.clientHeight || cur.scrollWidth > cur.clientWidth)) {
                  return cur;
                }
              }
              return null;
            };

            // 读滚动位置(回读校验副作用:scroll 必须返回是否真滚动,否则到边界/
            // 容器解析错时静默假成功,agent 以为滚到了实际没动 → 后续 act 找不到目标
            // 陷入循环。2026-06-03 act 原语白盒审计族 A,#18/#19)。
            const readPos = (t: Element | Window): { top: number; left: number } =>
              t instanceof Window
                ? { top: t.scrollY, left: t.scrollX }
                : { top: (t as Element).scrollTop, left: (t as Element).scrollLeft };

            // 确定滚动容器
            let scrollTarget: Element | Window = window;
            if (cont) {
              const containerEl = document.querySelector(cont);
              if (!containerEl) return { error: `Container not found: ${cont}` };
              scrollTarget = containerEl;
            }

            // selector + position 组合：滚动 selector 元素的最近 scrollable 祖先
            // 而不是把元素居中（scrollIntoView 对 modal 内 overflow 容器无效，
            // 是用户 P1-5 报告的根因）
            if (sel && pos && !cont) {
              const el = document.querySelector(sel);
              if (!el) return { error: `Element not found: ${sel}` };
              const ancestor = findScrollableAncestor(el);
              if (ancestor) {
                scrollTarget = ancestor;
              }
              // fall through to position branch（scrollTarget 已切换）
            } else if (sel) {
              // 仅 selector（无 position）：scrollIntoView 把元素居中。用 behavior:"auto"
              // (instant)而非 smooth——平滑动画异步,scrollTo 立即返回而滚动未完成,
              // 后续 observe/act 读到中途位置(#19)。回读元素 rect 判断是否真移动 + 是否
              // 已在视口。
              const el = document.querySelector(sel);
              if (!el) return { error: `Element not found: ${sel}` };
              const beforeTop = el.getBoundingClientRect().top;
              el.scrollIntoView({ behavior: "auto", block: "center" });
              const afterRect = el.getBoundingClientRect();
              const inView =
                afterRect.top < window.innerHeight && afterRect.bottom > 0;
              return {
                result: {
                  success: true,
                  moved: Math.abs(afterRect.top - beforeTop) > 1,
                  inView,
                },
              };
            }

            const doScroll = (opts: ScrollToOptions): { success: true; moved: boolean; scrollTop: number; scrollLeft: number } => {
              const before = readPos(scrollTarget);
              const scrollOpts: ScrollToOptions = { ...opts, behavior: "auto" };
              if (scrollTarget instanceof Window) {
                scrollTarget.scrollTo(scrollOpts);
              } else {
                (scrollTarget as Element).scrollTo(scrollOpts);
              }
              const after = readPos(scrollTarget);
              return {
                success: true,
                // 回读:位置无变化(已在目标边界 / 容器不可滚 / 容器解析错)时 moved:false,
                // agent 据此判断是否真滚动而非盲信 success(#18)。
                moved:
                  Math.abs(after.top - before.top) > 1 ||
                  Math.abs(after.left - before.left) > 1,
                scrollTop: after.top,
                scrollLeft: after.left,
              };
            };

            // 根据 position 滚动(behavior:auto instant,#19)
            if (pos) {
              const scrollOpts: ScrollToOptions = {};
              if (pos === "top") { scrollOpts.top = 0; }
              else if (pos === "bottom") { scrollOpts.top = 999999; }
              else if (pos === "left") { scrollOpts.left = 0; }
              else if (pos === "right") { scrollOpts.left = 999999; }
              return { result: doScroll(scrollOpts) };
            }

            // 滚动到指定坐标
            if (sx !== undefined || sy !== undefined) {
              const scrollOpts: ScrollToOptions = {};
              if (sx !== undefined) scrollOpts.left = sx;
              if (sy !== undefined) scrollOpts.top = sy;
              return { result: doScroll(scrollOpts) };
            }

            return { error: "Must specify selector, position, or x/y coordinates" };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector ?? null, container ?? null, position ?? null, x ?? null, y ?? null],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.HOVER]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      // 加载 dom-resolve 模块，使 inline func 能通过 shadow 穿透解析 selector
      await loadPageSideModule(tid, frameId, "dom-resolve");
      const res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (sel: string) => {
          try {
            // === 探测（与 CLICK 同步；HOVER 不检查 disabled，disabled 元素仍可收 hover 事件）===
            const els = (window as any).__vortexDomResolve.queryAllDeep(sel) as Element[];
            if (els.length === 0) {
              return { errorCode: "ELEMENT_NOT_FOUND", error: `Element not found: ${sel}` };
            }
            if (els.length > 1) {
              return {
                errorCode: "SELECTOR_AMBIGUOUS",
                error: `Selector "${sel}" matched ${els.length} elements`,
                extras: { matchCount: els.length },
              };
            }
            const el = els[0] as HTMLElement;
            // 滚入视口:真鼠标(下面 CDP mouseMoved)只能移到视口内坐标,离屏元素
            // hover 无效。滚动后再取 rect 算中心(2026-06-03 act 原语白盒审计族 C)。
            el.scrollIntoView({ block: "center", inline: "center" });
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return {
                errorCode: "ELEMENT_DETACHED",
                error: `Element ${sel} has zero dimensions (detached or hidden)`,
              };
            }
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            // === hover 操作(合成事件回退)===
            // 合成事件供监听 page-side mouseover 的库即时反应;真实 CSS :hover 态由
            // handler 侧的 CDP mouseMoved 触发(合成 JS 事件不更新浏览器 hover 态)。
            // mouseenter 规范上不冒泡,用 bubbles:false 修正语义。
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true }));
            // 静态 tooltip 信息：CSS `title` 的 OS 级 tooltip 不依赖 JS 事件
            // 触发（需要鼠标在元素上真停留），JS 无法可靠等到。所以直接读
            // 元素的 tooltip 相关属性返回，调用方不再依赖 DOM 渲染（P2-8,
            // 2026-05-21）。
            const tooltipInfo: Record<string, string> = {};
            const title = el.getAttribute("title");
            if (title) tooltipInfo.title = title;
            const ariaLabel = el.getAttribute("aria-label");
            if (ariaLabel) tooltipInfo.ariaLabel = ariaLabel;
            const ariaDescribedBy = el.getAttribute("aria-describedby");
            if (ariaDescribedBy) {
              tooltipInfo.ariaDescribedBy = ariaDescribedBy;
              const desc = document.getElementById(ariaDescribedBy);
              if (desc) {
                const t = (desc.textContent || "").replace(/\s+/g, " ").trim();
                if (t) tooltipInfo.ariaDescription = t.slice(0, 200);
              }
            }
            const dataTooltip = el.getAttribute("data-tooltip") || el.getAttribute("data-original-title");
            if (dataTooltip) tooltipInfo.dataTooltip = dataTooltip;
            return { result: { cx, cy, tooltip: tooltipInfo } };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector],
      );
      if (res?.error) mapPageError(res, selector);
      const hr = res?.result as
        | { cx: number; cy: number; tooltip: Record<string, string> }
        | undefined;
      // CDP 真鼠标移到元素中心:更新浏览器 hover 态,触发 CSS :hover + 原生
      // pointerover/mousemove/mouseover——合成 JS 事件无法触发 CSS :hover,纯 CSS
      // 悬停菜单/tooltip 因此永不展开(2026-06-03 act 原语白盒审计族 C,P0)。
      if (hr) {
        const { x: ox, y: oy } = await getIframeOffset(tid, frameId);
        await debuggerMgr.attach(tid);
        await debuggerMgr.sendCommand(tid, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: hr.cx + ox,
          y: hr.cy + oy,
        });
      }
      return { success: true, ...(hr?.tooltip ?? {}) };
    },

    [DomActions.GET_ATTRIBUTE]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const attribute = args.attribute as string;
      if (!attribute) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: attribute");
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string, attr: string) => {
          try {
            const el = document.querySelector(sel);
            if (!el) return { error: `Element not found: ${sel}` };
            return { result: el.getAttribute(attr) };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector, attribute],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.GET_SCROLL_INFO]: async (args, tabId) => {
      const __t = resolveTargetOptional(args);
      const selector = __t?.selector;
      const tid = await getActiveTabId(__t?.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string | undefined) => {
          try {
            if (sel) {
              const el = document.querySelector(sel);
              if (!el) return { error: `Element not found: ${sel}` };
              return {
                result: {
                  scrollTop: el.scrollTop,
                  scrollLeft: el.scrollLeft,
                  scrollHeight: el.scrollHeight,
                  scrollWidth: el.scrollWidth,
                  clientHeight: el.clientHeight,
                  clientWidth: el.clientWidth,
                },
              };
            }
            return {
              result: {
                scrollTop: window.scrollY,
                scrollLeft: window.scrollX,
                scrollHeight: document.documentElement.scrollHeight,
                scrollWidth: document.documentElement.scrollWidth,
                clientHeight: document.documentElement.clientHeight,
                clientWidth: document.documentElement.clientWidth,
              },
            };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        [selector ?? null],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.WAIT_FOR_MUTATION]: async (args, tabId) => {
      const __t = resolveTarget(args);
      const selector = __t.selector;
      const timeout = (args.timeout as number | undefined) ?? 10000;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string, timeoutMs: number) => {
          return new Promise<{ result?: unknown; error?: string }>((resolve) => {
            try {
              const el = document.querySelector(sel);
              if (!el) {
                resolve({ error: `Element not found: ${sel}` });
                return;
              }
              let settled = false;
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                observer.disconnect();
                resolve({ result: { mutated: false } });
              }, timeoutMs);

              const observer = new MutationObserver(() => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                observer.disconnect();
                resolve({ result: { mutated: true } });
              });

              observer.observe(el, { childList: true, subtree: true });
            } catch (err) {
              resolve({ error: err instanceof Error ? err.message : String(err) });
            }
          });
        },
        [selector, timeout],
      );
      if (res?.error) mapPageError(res, selector);
      return res?.result;
    },

    [DomActions.WAIT_SETTLED]: async (args, tabId) => {
      // selector 可选；无 selector 时监视 document.body 整棵
      const __t = resolveTargetOptional(args);
      const selector = __t?.selector;
      const quietMs = (args.quietMs as number | undefined) ?? 300;
      const timeout = (args.timeout as number | undefined) ?? 8000;
      const tid = await getActiveTabId(
        __t?.boundTabId ?? (args.tabId as number | undefined) ?? tabId,
      );
      const frameId = __t?.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);
      const res = await nativePageQuery<{ result?: unknown; error?: string } | undefined>(
        tid,
        frameId,
        (sel: string | null, quiet: number, to: number) => {
          return new Promise<{ result?: unknown; error?: string }>((resolve) => {
            try {
              const root = sel ? document.querySelector(sel) : document.body;
              if (!root) {
                resolve({ error: sel ? `Element not found: ${sel}` : "document.body not found" });
                return;
              }
              const start = Date.now();
              let settled = false;
              let quietTimer: ReturnType<typeof setTimeout> | null = null;
              let mutationsSeen = 0;

              const timeoutTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                obs.disconnect();
                if (quietTimer) clearTimeout(quietTimer);
                resolve({
                  error: `DOM did not settle within ${to}ms (${mutationsSeen} mutations observed)`,
                  // 标识 TIMEOUT，便于 handler 分类
                  // 约定：以 "DOM did not settle" 开头 → TIMEOUT
                });
              }, to);

              const startQuiet = () => {
                if (quietTimer) clearTimeout(quietTimer);
                quietTimer = setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  obs.disconnect();
                  clearTimeout(timeoutTimer);
                  resolve({
                    result: {
                      settled: true,
                      waitedMs: Date.now() - start,
                      mutationsSeen,
                    },
                  });
                }, quiet);
              };

              const obs = new MutationObserver(() => {
                mutationsSeen++;
                startQuiet();
              });
              obs.observe(root, { childList: true, subtree: true, attributes: true });
              // 立即开 quiet 窗口（"已经静止"情况下直接到期 resolve）
              startQuiet();
            } catch (err) {
              resolve({ error: err instanceof Error ? err.message : String(err) });
            }
          });
        },
        [selector ?? null, quietMs, timeout],
      );
      if (res?.error) {
        const isTimeout = res.error.startsWith("DOM did not settle");
        const isNotFound =
          res.error.startsWith("Element not found:") ||
          res.error.startsWith("document.body not found");
        const code = isTimeout
          ? VtxErrorCode.TIMEOUT
          : isNotFound
            ? VtxErrorCode.ELEMENT_NOT_FOUND
            : VtxErrorCode.JS_EXECUTION_ERROR;
        throw vtxError(code, res.error, selector ? { selector } : undefined);
      }
      return res?.result;
    },

    [DomActions.COMMIT]: async (args, tabId) => {
      const kind = args.kind as CommitKind | undefined;
      const value = args.value as unknown;
      const timeout = (args.timeout as number | undefined) ?? 8000;
      if (!kind) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: kind");
      if (value == null) throw vtxError(VtxErrorCode.INVALID_PARAMS, "Missing required param: value");
      const driver = findDriver(kind);
      if (!driver) {
        const known = COMMIT_DRIVERS.map((d) => d.kind);
        throw vtxError(
          VtxErrorCode.INVALID_PARAMS,
          `No commit driver for kind=${kind}. Known: ${known.join(", ")}`,
        );
      }

      const __t = resolveTarget(args);
      const selector = __t.selector;
      const tid = await getActiveTabId(__t.boundTabId ?? (args.tabId as number | undefined) ?? tabId);
      const frameId = __t.boundFrameId ?? (args.frameId as number | undefined);
      if (frameId != null) await ensureFrameAttached(tid, frameId);

      // daterange/datetimerange 走 CDP 真鼠标路径：dispatchMouseEvent 是 untrusted,
      // Element Plus 某些 handler 检查 isTrusted 后不同步 v-model。
      if (driver.kind === "daterange" || driver.kind === "datetimerange") {
        return await runDateRangeDriverCDP({
          tid,
          frameId,
          selector,
          closestSelector: driver.closestSelector,
          isDateTime: driver.kind === "datetimerange",
          value: value as { start?: string; end?: string },
          timeout,
          debuggerMgr,
        });
      }

      // cascader 也走 CDP：trigger 对 JS .click() 不响应，但 panel 内 node labels
      // 用 page-side .click() 可以逐级展开，混合路径省一堆 CDP 往返。
      if (driver.kind === "cascader") {
        return await runCascaderDriverCDP({
          tid,
          frameId,
          selector,
          closestSelector: driver.closestSelector,
          value: value as unknown[],
          timeout,
          debuggerMgr,
        });
      }

      // time picker：CDP 打开 panel + 三列 spinner click + 点 OK
      if (driver.kind === "time") {
        return await runTimePickerDriverCDP({
          tid,
          frameId,
          selector,
          closestSelector: driver.closestSelector,
          value: String(value),
          timeout,
          debuggerMgr,
        });
      }

      // Load page-side bundle for drivers that have been migrated out of inline func.
      if (driver.kind === "checkbox-group") {
        await loadPageSideModule(tid, frameId, "commit-checkbox-group");
      } else if (driver.kind === "select") {
        await loadPageSideModule(tid, frameId, "commit-select");
      }

      const res = await nativePageQuery<{
        result?: unknown;
        error?: string;
        errorCode?: string;
        stage?: string;
        extras?: Record<string, unknown>;
      } | undefined>(
        tid,
        frameId,
        (sel: string, closestSelector: string, val: unknown, timeoutMs: number, driverId: string) => {
          if (driverId === "element-plus-checkbox-group") {
            return (window as any).__vortexCommitCheckboxGroup.run(sel, closestSelector, val, timeoutMs);
          }
          if (driverId === "element-plus-select") {
            return (window as any).__vortexCommitSelect.run(sel, closestSelector, val, timeoutMs);
          }
          return { error: `Unknown driver id: ${driverId}`, errorCode: "INVALID_PARAMS" };
        },
        [selector, driver.closestSelector, value as never, timeout, driver.id],
      );

      if (res?.error) {
        const known = res.errorCode && res.errorCode in VtxErrorCode;
        const code = known ? (res.errorCode as VtxErrorCode) : VtxErrorCode.JS_EXECUTION_ERROR;
        const extras: Record<string, unknown> = { ...(res.extras ?? {}), driverId: driver.id };
        if (res.stage) extras.stage = res.stage;
        throw vtxError(code, res.error, { selector, extras });
      }
      return res?.result;
    },
  });
}
