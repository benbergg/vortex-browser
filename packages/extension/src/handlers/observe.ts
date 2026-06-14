import { ObserveActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";
import { getIframeOffset } from "../lib/iframe-offset.js";
import {
  gcSnapshots,
  newSnapshotId,
  setSnapshot,
  type SnapshotElement,
} from "../lib/snapshot-store.js";
import { captureAXNodeMap } from "../reasoning/ax-snapshot.js";
import { buildIndexToBackend, applyOverlay, type OverlayableElement } from "./observe-ax-overlay.js";
import { markListenerElements } from "./observe-js-listener.js";

type FramesParam =
  | "main"
  | "all-same-origin"
  /** @since 0.4.0 (O-6)：按扩展 manifest host_permissions 过滤，不用严格 origin 同源 */
  | "all-permitted"
  | "all"
  | number[];

/**
 * Auto-fallback 阈值（v0.7.4）：当 caller 未显式传 `frames` 且 main frame 的
 * interactive 元素 < 此值，**且**页面有 child iframe，自动 retry 用 all-permitted
 * 重扫子 frame，把结果合并到 scans。
 *
 * Why：禅道/JIRA Cloud/phpMyAdmin 等"shell+iframe content"老后台主 frame 只剩
 * 顶部 nav（10-15 link/button），业务表格全在 iframe 里。caller 第一次 observe
 * 拿到的"近乎为空"无法引导后续动作，被迫第二次 observe 加 frames=all-permitted。
 * 5 Whys 定位：默认值是给 SPA 优化的，但 LLM 无页面先验知识 → Poka-Yoke 缺失。
 * 此 fallback 让 caller 第一次 observe 就拿到内容（dogfood 卡点 #1）。
 *
 * Threshold=50（调升自 v0.7.4 初始的 20）：覆盖含主导航的现代 shell 页面
 * （如 testc.bytenew.com 主壳带 60+ 顶部 nav link 但业务在跨域 iframe，原 20
 * 触发不到）。现代 SPA 主 frame 通常 ≥100 元素，不触发；no-iframe 页面 child=0
 * 也不触发，三重门避免误判。dogfood 反馈：voc-front 会话发现"含 nav 主壳 +
 * iframe 业务"在 testc.bytenew.com 不触发，迫使 caller 手动加 frames=all-permitted。
 */
const FALLBACK_INTERACTIVE_THRESHOLD = 50;

/**
 * 轻量 MV3 match pattern 匹配器：支持 `<all_urls>` / `scheme://host-pattern/path-pattern`。
 * scheme 里 `*` 代表 http|https，host 里 `*.example.com` 代表任意子域 / example.com 本身。
 * 不支持 port / 完整正则——对扩展 manifest 通常足够。
 */
function matchesHostPermission(pattern: string, url: URL): boolean {
  if (pattern === "<all_urls>") {
    return /^(https?|ws|wss|ftp|file):$/.test(url.protocol);
  }
  const m = pattern.match(/^([^:]+):\/\/([^/]+)\/(.*)$/);
  if (!m) return false;
  const [, scheme, host] = m;
  const urlScheme = url.protocol.replace(/:$/, "");
  if (scheme !== "*" && scheme !== urlScheme) {
    if (!(scheme === "*" && /^(https?)$/.test(urlScheme))) return false;
  }
  if (host === "*") return true;
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    return url.hostname === base || url.hostname.endsWith("." + base);
  }
  return host === url.hostname;
}

function isFrameInPermissions(url: string): boolean {
  try {
    const u = new URL(url);
    // 非 HTTP(S) frame（chrome:// / about:blank / data:）视为不可 scan
    if (!/^https?:|^ws:|^wss:$/.test(u.protocol)) return false;
    const manifest = chrome.runtime.getManifest();
    const patterns = manifest.host_permissions ?? [];
    return patterns.some((p) => matchesHostPermission(p, u));
  } catch {
    return false;
  }
}

interface FrameTarget {
  frameId: number;
  url: string;
  parentFrameId: number;
}

interface ScannedElement {
  index: number;
  tag: string;
  role: string;
  name: string;
  bbox: { x: number; y: number; w: number; h: number };
  visible: boolean;
  inViewport: boolean;
  occludedBy?: string;
  attrs: Record<string, string>;
  /** Framework UI state derived from class / aria. @since 0.4.0 (O-8) */
  state?: { checked?: boolean | "mixed"; selected?: boolean; active?: boolean; disabled?: boolean; expanded?: boolean; required?: boolean; current?: boolean; invalid?: boolean; sort?: "ascending" | "descending" | "none"; haspopup?: string; readonly?: boolean };
  /** 值域控件(slider/spinbutton/progressbar/meter 及原生 range/number/progress)的当前值,如 "30" 或 "30/100"。@since dogfood 2026-06-02 */
  valueNow?: string;
  /** BUG-010 N0060 京东评测: el 含 onClick 桩 / cursor:pointer 时标 true,
   * 提示 LLM 评测者该 ref 走真实 mouse (vortex_mouse_drag 或 useRealMouse=true)
   * 兜底, 不要直接 el.click() (isTrusted=false 拦截)。 */
  reactClickable?: true;
  /** reactClickable=true 时给 LLM 的可读提示, 含具体兜底命令名。 */
  clickHint?: string;
  /** CDP getEventListeners 确认有 click/mousedown/pointerdown 监听器。
   * 高优先交互判定信号（优先级高于 cursor:pointer 启发），并集增强不删元素。@since T3 */
  listenerInteractive?: true;
  /** 最近的已收集祖先的 frame-local index；根节点 undefined。@since a11y-tree */
  parentIndex?: number;
  /** role=link 的 href，供 compact 树渲染 /url。@since a11y-tree */
  href?: string;
  /** 离屏但可交互(visually hidden actionable)标记。@since v0.7 */
  offScreenActionable?: boolean;
  /** AX nameSource：名称来源(label/placeholder/title/heuristic 等)。@since ax-overlay */
  nameSource?: string;
  /** aria-controls 指向的 frame-local 元素下标列表。@since ax-overlay */
  controls?: number[];
  /** aria-owns 指向的 frame-local 元素下标列表。@since ax-overlay */
  owns?: number[];
  /** aria-errormessage 或 aria-describedby(错误)关联文本。@since ax-overlay */
  errorMessage?: string;
  /** aria-describedby 关联描述文本。@since ax-overlay */
  description?: string;
  /** 复合控件元数据(combobox/listbox/date-input/file-input/range-input 等)。@since ax-overlay */
  compound?: {
    role: string;
    count?: number;
    options?: string[];
    /** date/time 格式串或 file input 当前文件名/None */
    formatHint?: string;
    /** range/number input 最小值约束 */
    min?: string;
    /** range/number input 最大值约束 */
    max?: string;
    /** range/number input 步长约束 */
    step?: string;
  };
  _sel: string;
}

interface FramePageResult {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    scrollY: number;
    scrollHeight: number;
  };
  elements: ScannedElement[];
  candidateCount: number;
  truncated: boolean;
}

function safeOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * 走 parent chain 跨过 opaque origin 找第一个具体 origin。
 * Spec: `<iframe srcdoc>` 继承父文档 origin —— about:srcdoc 是 opaque URL
 * (`new URL("about:srcdoc").origin` 返回字面量 "null"),srcdoc 嵌 srcdoc 时递归
 * 继承。找不到具体 origin 返回 null。
 * Issue #15: 据此把 srcdoc 子框归入其继承的源。
 */
function inheritedOrigin(
  f: chrome.webNavigation.GetAllFrameResultDetails,
  byId: Map<number, chrome.webNavigation.GetAllFrameResultDetails>,
): string | null {
  let cur: chrome.webNavigation.GetAllFrameResultDetails | undefined = f;
  let depth = 0;
  while (cur && depth < 16) {
    const o = safeOrigin(cur.url);
    // 具体 origin(非 opaque)。opaque URL 的 origin 是字面量 "null"。
    if (o && o !== "null") return o;
    const parentId = cur.parentFrameId;
    if (parentId == null || parentId < 0) return null;
    cur = byId.get(parentId);
    depth++;
  }
  return null;
}

/** Exported for unit tests; production callers go through the snapshot handler. */
export async function resolveTargetFrames(
  tabId: number,
  explicitFrameId: number | undefined,
  framesParam: FramesParam,
): Promise<FrameTarget[]> {
  const all = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const asTargets = (ff: chrome.webNavigation.GetAllFrameResultDetails[]): FrameTarget[] =>
    ff.map((f) => ({
      frameId: f.frameId,
      url: f.url,
      parentFrameId: f.parentFrameId ?? 0,
    }));

  // 向后兼容：显式 frameId 参数仅扫该 frame，不下钻
  if (explicitFrameId != null) {
    const f = all.find((x) => x.frameId === explicitFrameId);
    return f ? asTargets([f]) : [];
  }

  if (Array.isArray(framesParam)) {
    return asTargets(all.filter((f) => framesParam.includes(f.frameId)));
  }
  if (framesParam === "all") {
    return asTargets(all);
  }
  if (framesParam === "all-permitted") {
    // 按扩展 manifest host_permissions 过滤。host_permissions=<all_urls> 时
    // 行为等同 "all"；当 manifest 收紧 host_permissions 时，只 scan 有权限的。
    return asTargets(all.filter((f) => isFrameInPermissions(f.url)));
  }
  if (framesParam === "all-same-origin") {
    const main = all.find((f) => f.frameId === 0);
    const mainOrigin = safeOrigin(main?.url);
    if (!mainOrigin) return main ? asTargets([main]) : [];
    const byId = new Map(all.map((f) => [f.frameId, f]));
    return asTargets(all.filter((f) => inheritedOrigin(f, byId) === mainOrigin));
  }
  // 默认 "main"
  const main = all.find((f) => f.frameId === 0);
  return main ? asTargets([main]) : [];
}

/**
 * React/Vue 重写后 SPA 商品卡常用的"非 native onClick"探测 + 标记者 (BUG-010
 * N0060 京东选品评测 V1): 京东商品卡 div 含 React 桩 `onClick={kd()}` 但
 * el.click() 不触发跳转 (isTrusted=false, React 18 root delegation 拦截),
 * 必须真实 mouse 事件 (vortex_mouse_drag 或 useRealMouse=true) 兜底。
 *
 * 命中条件 (任一):
 *   - `el.onclick` property 被框架挂上 (React onClick 桩) —— 现代 SPA
 *   - `el.getAttribute("onclick")` 非空 —— jQuery-era PHP 后台 (Zentao
 *     legacy panels, phpMyAdmin) inline handler
 *   - `getComputedStyle(el).cursor === "pointer"` —— 祖传 framework
 *     onClick 钩子没暴露 property/attribute (Vue3 vnode 内部 invoker,
 *     React Fiber 内部引用, 旧 WebForms 装饰 div) 的兜底
 *
 * 副作用 (双标): 同时在 live DOM (`el.dataset.vortexReactClickable = "1"`)
 * 与 ScannedElement 输出 (`out.reactClickable + out.clickHint`) 标记。
 * live DOM 标用于后续 vortex_act click 自动检测并切换到 CDP 真实 mouse
 * 路径, ScannedElement 标用于 LLM 评测者直接读 clickHint 提示, 二者解耦
 * 可独立演进 (评测侧改用 mouse_drag 即可, 不依赖 click 路径变化)。
 *
 * Why export: TDD test `observe-react-clickable.test.ts` 在 jsdom 元素
 * 上直接验证 (1) 命中条件 (2) dataset 副作用 (3) out 字段, 不需跑全
 * chrome.scripting.executeScript 链路。生产调用方仅 observe emit 阶段。
 */
export const REACT_CLICKABLE_HINT =
  "react onClick or cursor:pointer detected; vortex_act click may not trigger (isTrusted=false). Use vortex_mouse_drag(realMouse) or vortex_act click with useRealMouse=true to bypass.";

export interface ReactClickableMarker {
  reactClickable: true;
  clickHint: string;
}

export function applyReactClickableMarker(
  el: HTMLElement,
  out: { reactClickable?: true; clickHint?: string },
): ReactClickableMarker | null {
  const hasOnClickProp = el.onclick != null;
  const hasOnClickAttr = el.getAttribute("onclick") != null;
  const isPointer = getComputedStyle(el).cursor === "pointer";
  if (!hasOnClickProp && !hasOnClickAttr && !isPointer) return null;
  // 副作用 1: live DOM 标, 供后续 vortex_act click 自动检测
  el.dataset.vortexReactClickable = "1";
  // 副作用 2: ScannedElement 输出标, 供 LLM 评测者读 clickHint
  out.reactClickable = true;
  out.clickHint = REACT_CLICKABLE_HINT;
  return { reactClickable: true, clickHint: REACT_CLICKABLE_HINT };
}

/**
 * 跨池祖先短路的"原子控件 vs 聚焦容器"判据(N0064 D6 dogfood 根因)。
 *
 * cursor:pointer fallback 收候选时会跳过"祖先链上已有 INTERACTIVE_SELECTORS 元素"
 * 的子项,避免 `<button><span cursor:pointer>` 双现。但 Element UI 2.x 的浮层容器
 * (el-popover/el-dialog/el-drawer)自带 `tabindex="0"` + `role="tooltip|dialog"`,
 * 因 `[tabindex]:not([-1])` 进池却**不是原子点击目标**——它只是聚焦/浮层容器,内部的
 * bnCheck / el-dropdown-menu__item 等自定义控件是独立目标。短路若把这类容器当原子控件,
 * 会把整层弹窗内容全吞掉(实机:columnDisplay 9 列 checkbox 全丢)。
 *
 * 判据:祖先 role ∈ 容器角色集(grouping/overlay,不描述子树),或它仅因 tabindex 入池
 * (不匹配任何原子控件选择器)→ 视为聚焦容器,短路**不**应触发。真原子控件
 * (button/a/[role=button|menuitem|option…]/label/[onclick] 等)仍触发短路防双现。
 *
 * Why export:供 `observe-focus-container-suppress.test.ts` jsdom 直测真源;inject func
 * 内联同语义副本(closure 注入无法 import),改一处须同步另一处,源码锁守护。
 */
export const FOCUS_CONTAINER_ROLES = new Set<string>([
  "tooltip",
  "dialog",
  "alertdialog",
  "group",
  "region",
  "menu",
  "listbox",
  "tree",
  "grid",
  "table",
  "tabpanel",
  "navigation",
  "toolbar",
  "document",
  "application",
  "none",
  "presentation",
]);
export const ATOMIC_INTERACTIVE_SELECTORS =
  "button,a[href],summary,input:not([type=hidden]),select,textarea,label,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=treeitem],[role=option],[contenteditable],[onclick]";
export function isFocusContainerOnly(el: Element): boolean {
  const role = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (role && FOCUS_CONTAINER_ROLES.has(role)) return true;
  return !el.matches(ATOMIC_INTERACTIVE_SELECTORS);
}

/**
 * 班牛(bytenew)bnCheck 自定义勾选控件识别(N0064 P2-1 dogfood)。
 *
 *   <div class="bnCheck"><span class="bnCheck-status[ checked]">…</span>
 *        <span class="bnCheck-label">名</span></div>
 *
 * 无 role / 无原生 <input> / 无 aria-checked,勾选态是 `.bnCheck-status` 上的**裸**
 * `checked` class。getRole 因此返 tag(span),controlRoleFromClass 末位 token 规则
 * 抓不到缩写 "bnCheck"(≠checkbox),getUiState 的 is-checked/aria/native 路径也全漏
 * (checked 落在后代 status span)。本判据从 collected 元素(常是 bnCheck-label)上溯
 * ≤5 层命中 `.bnCheck` 根 → role=checkbox + checked。只覆盖实机验证过的 bnCheck,
 * 不臆测 bnRadio(未复现)。
 *
 * Why export:供 `observe-bncheck-checkbox.test.ts` jsdom 直测真源;inject func 注入丢
 * 模块作用域不能 import,内联同语义副本,改一处须同步(源码锁守护)。
 */
export function bnCheckInfo(el: Element): { role: "checkbox"; checked: boolean } | null {
  let root: Element | null = null;
  for (let p: Element | null = el, d = 0; p && d < 5; p = p.parentElement, d++) {
    const cls = typeof p.className === "string" ? p.className : "";
    if (/(^|\s)bnCheck(\s|$)/.test(cls)) {
      root = p;
      break;
    }
  }
  if (!root) return null;
  const status = root.querySelector(".bnCheck-status");
  return { role: "checkbox", checked: !!status && status.classList.contains("checked") };
}

async function scanOneFrame(
  tabId: number,
  frameId: number,
  maxElements: number,
  viewport: "visible" | "full",
  includeText: boolean,
  includeAX: boolean,
  filterMode: "interactive" | "all",
): Promise<FramePageResult | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: buildExecuteTarget(tabId, frameId),
      func: (
        max: number,
        mode: string,
        withText: boolean,
        withAX: boolean,
        filter: "interactive" | "all",
      ) => {
        // Per-observe rid prefix used as identity fallback when buildSelector
        // can't produce a page-unique CSS selector (e.g. Element Plus v-for
        // groups with identical inner DOM). Ambiguous elements are stamped
        // with `data-vortex-rid` so the @fNeM ref system resolves them by
        // identity instead of degrading to a path that matches multiple
        // siblings.
        const ridPrefix = `vtx${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 6)}_`;
        let ridCounter = 0;
        // Clear stale rids from previous observes on this frame so the
        // attribute set never accumulates across long-lived SPA sessions
        // and stale snapshot refs can't silently resolve to mis-rendered
        // elements (review feedback on PR #19).
        for (const stale of document.querySelectorAll("[data-vortex-rid]")) {
          stale.removeAttribute("data-vortex-rid");
        }

        const INTERACTIVE_SELECTORS = [
          "button",
          "a[href]",
          // 原生 radio/checkbox 也收。组件库(Element Plus/Ant 等)把真 input
          // visually-hidden 藏在可点的 <label> 下,真正可点的是外层 label
          // (下方 label:has(...) 收),这类 surrogate input 由扫描循环里的
          // closest("label")/opacity 门挡掉避免双现;而裸露的原生 input
          // (兄弟式 <label for> / 纯 aria-label / 无 label)以前被整类排除 →
          // 完全隐形(记住密码/同意条款/性别单选等最常见原生表单全盲),
          // 现直接收(2026-06-02 dogfood AB)。
          "input:not([type=hidden])",
          "select",
          "textarea",
          // 原生 disclosure 触发器：<details> 的首个 <summary> 是可点开合的控件
          // (GitHub 菜单 / MDN / 文档站 FAQ 折叠大量使用)。它本身是交互入口,
          // 而关闭态 <details> 的内部内容由下方 checkVisibility 门挡掉
          // (content-visibility:hidden,2026-06-02 dogfood)。:first-of-type 限定
          // 首个——HTML 规范里仅第一个 <summary> 是 disclosure 控件,第 2+ 个是
          // 普通流内容点了无效,收进来会误导 agent(评审 #1 LOW)。
          "details > summary:first-of-type",
          "label:has(input[type=radio]), label:has(input[type=checkbox])",
          "[role=button]",
          "[role=link]",
          "[role=textbox]",
          "[role=checkbox]",
          "[role=radio]",
          "[role=tab]",
          "[role=menuitem]",
          "[role=treeitem]",
          "[role=option]",
          "[tabindex]:not([tabindex='-1'])",
          "[contenteditable]",
          // Inline onclick handler — covers jQuery-era PHP backoffice / WebForms
          // pages (e.g. Zentao legacy panels, phpMyAdmin) where business actions
          // are wired as `<div onclick="...">` / `<a onclick="..." href="#">`
          // without semantic role or cursor:pointer CSS. Modern Vue/React apps
          // bind via @click in the framework runtime (no [onclick] attribute),
          // so this selector is a pure additive on legacy surface.
          "[onclick]",
          // 原生 HTML5 draggable 容器:<div draggable="true"> 是可拖拽控件(看板/文件
          // 管理器/sortable 列表海量使用),但常无 role/tabindex/[onclick]/cursor:pointer,
          // 既有白名单与 cursor:pointer fallback 全漏 → observe 暴露 0 ref,断掉标志性的
          // observe→ref→vortex_drag 流(drag 工具本身用裸 selector 可拖,只是 agent 凭
          // observe 发现不了目标)。draggable 是枚举属性(非布尔),仅显式 "true" 可拖,
          // 故 [draggable=true] 精确匹配——draggable=""/"false" 不收(2026-06-14 真实站
          // 评测 the-internet/drag_and_drop)。原生 img/a 默认可拖但已被 a[href] 覆盖。
          "[draggable=true]",
        ].join(",");

        const COLLECTED_ATTRS = [
          "id",
          "data-testid",
          "data-test",
          "href",
          "type",
          "name",
          "placeholder",
          "value",
          "aria-label",
          "title",
        ];

        // 显式声明为「纯文本/装饰、非控件」的 ARIA role。作者写下 role="text"
        // 是比继承来的 cursor:pointer 更强的语义信号:它告诉辅助技术「这是文本,
        // 不是控件」。cursor:pointer fallback 必须尊重这个声明,否则可点卡片把
        // cursor 继承给内部观看数/时间戳文本时,这些 `role="text"` 叶子会被误收
        // 进 interactive 列表(youtube `[text] "2.1万次观看"`,2026-06-01 dogfood)。
        // 不含 heading/group——可折叠标题等带 cursor:pointer 的 heading 是真交互。
        const NON_INTERACTIVE_ROLES = new Set([
          "text",
          "paragraph",
        ]);

        // bnCheckInfo 内联副本——真源见导出函数(可单测),inject func 注入丢模块作用域
        // 不能 import,改一处须同步(源码锁守护)。班牛 bnCheck 自定义勾选控件:无 role/无
        // 原生 input/无 aria-checked,勾选态 = 后代 .bnCheck-status 上裸 `checked` class。
        // 上溯 ≤5 层命中 .bnCheck 根 → checkbox + checked(N0064 P2-1)。
        const bnCheckInfo = (
          el: Element,
        ): { role: "checkbox"; checked: boolean } | null => {
          let root: Element | null = null;
          for (let p: Element | null = el, d = 0; p && d < 5; p = p.parentElement, d++) {
            const cls = typeof p.className === "string" ? p.className : "";
            if (/(^|\s)bnCheck(\s|$)/.test(cls)) {
              root = p;
              break;
            }
          }
          if (!root) return null;
          const status = root.querySelector(".bnCheck-status");
          return { role: "checkbox", checked: !!status && status.classList.contains("checked") };
        };

        function getRole(el: Element): string {
          const explicit = el.getAttribute("role");
          if (explicit) {
            // ARIA role 是空格分隔的「回退角色列表」,浏览器取首个有效 token
            // (如 Wikipedia 可排序表头 role="columnheader button" → columnheader)。
            // 取首个 token 近似该规则(作者惯例把主角色置首),避免把整串含空格的
            // 多 token 当畸形 role 输出 [columnheader button](2026-06-03 Wikipedia
            // dogfood)。role 仅空格时 first 为空,回落到下方隐式 role 推导。
            const first = explicit.trim().split(/\s+/)[0];
            if (first) return first;
          }
          const tag = el.tagName.toLowerCase();
          if (tag === "a" && el.hasAttribute("href")) return "link";
          if (tag === "button") return "button";
          if (tag === "input") {
            const t = (el as HTMLInputElement).type;
            if (t === "checkbox") return "checkbox";
            if (t === "radio") return "radio";
            // submit/button/reset/image 均映射 button(HTML-AAM:这四种 input
            // 的 ARIA role 都是 button)。旧逻辑漏了 reset/image → 它们错报 textbox
            // (2026-06-02 saucedemo dogfood AH 连带)。
            if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
            // range/number 是值域控件,role 精确化为 slider/spinbutton 让 agent
            // 知道这是可调数值(配合下方 valueNow 暴露当前值,2026-06-02 dogfood)。
            if (t === "range") return "slider";
            if (t === "number") return "spinbutton";
            return "textbox";
          }
          if (tag === "select") return "combobox";
          if (tag === "textarea") return "textbox";
          // <summary> 是 disclosure 开合控件,交互模型等同按钮,role 报 button 让
          // LLM 直接理解为可点(原生 <details>/<summary>,2026-06-02 dogfood)。
          if (tag === "summary") return "button";
          // 班牛 bnCheck 自定义勾选控件(无 role/无原生 input)→ checkbox(N0064 P2-1)。
          if (bnCheckInfo(el)) return "checkbox";
          return tag;
        }

        // 元素是否带交互可供性(用于 occlusion carve-out 判定 widget 容器)。
        function isInteractiveEl(x: Element): boolean {
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
        }

        // Icon-only fallback：先 svg `<title>` / img alt / aria-label，失败再 className。
        // 触发条件：元素含 svg/img 后代（典型 svg/img 图标按钮）。
        // **不**包含 `<i>` 标签兜底——空 `<i>` 多为 CSS pseudo-element 渲染的装饰。
        // className 路径带 denylist，过滤掉 Element Plus / Ant / Vant 等框架前缀类
        // 和通用泛词 (icon/iconfont/btn/button/wrapper/container)——它们对 LLM 等同
        // "icon"/"button"，零信息（testc 实测 `el-icon` × 3 + `el-popover_*` × 2）。
        // 以及生成式原子类（emotion `css-*` / styled-components `sc-*`）纯 hash，
        // 否决以免框架前缀被否后级联回退到 emotion token（preview.pro.ant.design dogfood）。
        // CSS Modules `_closeIcon_1ygkr_39` → `closeIcon` 仍正常保留（不在 denylist）。
        // 共用于：(1) cursor:pointer fallback gate (2) getAccessibleName 末尾兜底。
        const ICON_CLASS_DENY_PREFIXES = ["el-", "ant-", "anticon", "van-"];
        const ICON_CLASS_DENY_NAMES = new Set([
          "icon", "iconfont", "btn", "button", "wrapper", "container",
        ]);
        function iconNameFromClass(el: Element): string {
          const inner = el.querySelector("svg, img") as Element | null;
          if (!inner) return "";
          // 1. svg `<title>` / img alt / aria-label —— 真语义来源
          if (inner.tagName === "svg") {
            const t = inner.querySelector("title")?.textContent?.trim();
            if (t) return t.slice(0, 80);
          } else if (inner.tagName === "IMG") {
            const alt = (inner as HTMLImageElement).alt?.trim();
            if (alt) return alt.slice(0, 80);
          }
          const aria = inner.getAttribute("aria-label")?.trim();
          if (aria) return aria.slice(0, 80);
          // 2. className 兜底，带 denylist
          const cls =
            el.className && typeof el.className === "string" ? el.className : "";
          for (const c of cls.split(/\s+/).filter(Boolean)) {
            const m = c.match(/^_?([a-zA-Z][a-zA-Z0-9_-]{2,})/);
            if (!m || !m[1]) continue;
            const cleaned = m[1]
              .replace(/_[a-z0-9]{4,}_\d+$/i, "")
              .replace(/_[a-z0-9]{4,}$/i, "");
            if (cleaned.length < 3) continue;
            // 去 BEM 副产物 trailing `_`（`el-popover__reference` → strip hash → `el-popover_`）
            const lower = cleaned.toLowerCase().replace(/_+$/, "");
            if (ICON_CLASS_DENY_NAMES.has(lower)) continue;
            if (ICON_CLASS_DENY_PREFIXES.some((p) => lower.startsWith(p))) continue;
            // 生成式原子类(emotion `css-*` / styled-components `sc-*`)是纯 hash,
            // 零语义。必须否决——否则当真语义类先被框架前缀 denylist 否决时
            // (如 `ant-pro-layout-bg-list css-tql0nm`:`ant-` 否决后),名字会
            // 级联回退到 emotion token `css-tql0nm`,比无名更糟;且让本应被
            // BUG-3 噪声过滤器丢弃的非交互背景层凭这个假名续命被误报为可交互
            // (2026-06-01 preview.pro.ant.design dogfood 实测)。
            if (/^css-/.test(lower) || /^sc-[a-z]/.test(lower)) continue;
            return cleaned;
          }
          return "";
        }

        // REQ-009 N0060 京东评测 A 方案: 图标式无文本 `<a>` 兜底名(京东
        // 30 个客服图标 + 1 个 logo 是该模式的代表,跨平台通用)。
        // 五条件全部命中才兜底 (顺序敏感):
        //   1. tagName === "a"  (仅链接,不误判 button)
        //   2. children.length === 0  (排除含 <img>/<svg> 的真图标 link, 让
        //      它们的 alt/svg-title/aria-label 走 iconNameFromClass 路径)
        //   3. textContent.trim() === ""  (无文本)
        //   4. bbox width ≤ 32 && height ≤ 32  (小图标, 32x32 购物车图标等
        //      真按钮通常含 svg, 已被条件 2 排除; 32x32 boundary 防御)
        //   5. href 非空  (避免空锚 <a></a> 误判)
        // 返回 `icon-link @x=N,y=N` 固定名, LLM 一眼识别这是图标式 link,
        // 不再被空名率统计误伤 (京东 29.90% → ~1%)。
        // 不命中 aria-label / title: 已有有意义 attribute 命名的链接让原路径
        // 处理, 避免与 iconNameFromClass 抢名。
        const ICON_LINK_MAX_SIZE = 32;
        function iconLinkName(el: Element): string | null {
          if (el.tagName.toLowerCase() !== "a") return null;
          if (el.children.length > 0) return null;
          if (el.textContent.trim() !== "") return null;
          const href = el.getAttribute("href");
          if (!href) return null;
          if (el.getAttribute("aria-label")) return null;
          if (el.getAttribute("title")) return null;
          const rect = el.getBoundingClientRect();
          if (rect.width > ICON_LINK_MAX_SIZE || rect.height > ICON_LINK_MAX_SIZE) return null;
          return `icon-link @x=${Math.round(rect.x)},y=${Math.round(rect.y)}`;
        }

        // CSS 字体图标约定的前缀(Bootstrap Icons / FontAwesome / Glyphicons):
        // 类名 `<prefix>-<icon>` 经 ::before 字形渲染,无 inner svg/img。
        // bi-/fa-/glyphicon- = 三大图标字体;vxe-icon-(vxe-table)/van-icon-(Vant)=
        // 组件库 CSS 字体图标(::before 字形,无 inner svg/img)。仅显示路径(getAccessibleName
        // 末位 iconFontName)给已召回图标按钮补名,**不进 gate**(round-12 幽灵续命约束)。
        const ICON_FONT_PREFIXES = [
          "bi-", "fa-", "glyphicon-", "vxe-icon-", "van-icon-",
        ];
        // FontAwesome 样式修饰类(非图标名,与 `fa-<icon>` 同形,故白名单逐一跳过)。
        const ICON_FONT_MODIFIERS = new Set([
          // 样式族(solid/regular/brands…)
          "fa-solid", "fa-regular", "fa-brands", "fa-light", "fa-thin",
          "fa-duotone", "fa-sharp",
          // 布局/对齐
          "fa-fw", "fa-border", "fa-pull-left", "fa-pull-right", "fa-inverse",
          // 尺寸(fa-2xs..fa-10x)
          "fa-2xs", "fa-xs", "fa-sm", "fa-lg", "fa-xl", "fa-2xl",
          "fa-1x", "fa-2x", "fa-3x", "fa-4x", "fa-5x",
          "fa-6x", "fa-7x", "fa-8x", "fa-9x", "fa-10x",
          // 动画族(FA6)
          "fa-spin", "fa-spin-reverse", "fa-spin-pulse", "fa-pulse",
          "fa-beat", "fa-fade", "fa-beat-fade", "fa-bounce", "fa-shake", "fa-flip",
          // 旋转/翻转变换
          "fa-rotate-90", "fa-rotate-180", "fa-rotate-270", "fa-rotate-by",
          "fa-flip-horizontal", "fa-flip-vertical", "fa-flip-both",
          // 图标叠放工具类
          "fa-stack", "fa-stack-1x", "fa-stack-2x",
        ]);
        // 纯图标按钮的末位兜底:图标用 CSS 字体字形渲染(Bootstrap Icons `bi-gear`、
        // FontAwesome `fa-gear`、Glyphicons `glyphicon-cog`),无 inner svg/img 故
        // iconNameFromClass 吃不到,且无 aria-label/title/text → accessible name 真空。
        // 仅匹配已知 icon-font 前缀时取名(strip 前缀、hyphen→空格),避免泛 className
        // 噪声(2026-06-03 Monaco editor dogfood AP)。
        function iconFontName(el: Element): string {
          const cls =
            el.className && typeof el.className === "string" ? el.className : "";
          const tokens = cls.split(/\s+/).filter(Boolean);
          for (const c of tokens) {
            const lower = c.toLowerCase();
            if (ICON_FONT_MODIFIERS.has(lower)) continue;
            for (const p of ICON_FONT_PREFIXES) {
              if (lower.startsWith(p) && lower.length > p.length) {
                // DESIGN-003 (N0063): 前缀匹配大小写无关,但返回保留原 token 大小写
                // (与 aria-label/text 路径对称)。c.slice 而非 lower.slice:icon-addCube→
                // "addCube" 不再压成 "addcube",可读 + 可反查 [class*="addCube"]。
                return c.slice(p.length).replace(/-/g, " ");
              }
            }
          }
          // 班牛(Bangniu/testc)web-icon:基类 `wicon` + `icon-<name>`(icon-add-1 /
          // icon-more),CSS ::before 字形,无 inner svg/img、无 aria/text。`icon-` 前缀
          // 本身太泛(易误名装饰图标),**仅在 `wicon` 签名基类同在时**取名,把命名锚定
          // 到班牛体系(2026-06-10 testc dogfood:hover 出的 +/··· 图标按钮无名被丢)。
          if (tokens.includes("wicon")) {
            for (const c of tokens) {
              const lower = c.toLowerCase();
              if (lower.startsWith("icon-") && lower.length > 5) {
                // DESIGN-003 (N0063): 保留原大小写(c.slice 非 lower.slice),icon-addCube→
                // "addCube"。与上方前缀分支 + 测试副本 WICON_BRANCH 同步。
                return c.slice(5).replace(/-/g, " ");
              }
            }
          }
          return "";
        }

        // controlRoleFromClass 内联副本(注入体不能 import control-naming.ts,改一处须同步)。
        // 终末 token 规则:class 按 BEM/连字符切词,末位 ∈ {checkbox,radio,switch,toggle}
        // → 规范 role 名。给无 role/无 name 的自定义控件(vxe-cell--checkbox)兜底命名。
        const controlRoleFromClass = (el: Element): string => {
          const cls =
            el.className && typeof el.className === "string" ? el.className : "";
          for (const c of cls.split(/\s+/).filter(Boolean)) {
            const tokens = c.split(/--|__|-/).filter(Boolean);
            const last = tokens[tokens.length - 1]?.toLowerCase();
            // 关键词集与 control-naming.ts 的 CONTROL_KEYWORDS 同步:checkbox/radio/switch/toggle
            if (last && (last === "checkbox" || last === "radio" || last === "switch" || last === "toggle")) {
              return last === "toggle" ? "switch" : last;
            }
          }
          return "";
        };

        // Name extraction uses textContent (not innerText) to bypass CSS
        // `text-overflow: ellipsis` truncation — innerText returns the
        // rendered visible text, which on `white-space:nowrap; overflow:hidden`
        // cells drops everything past the visible width. textContent is the
        // unrendered DOM text and is unaffected. We still cap to 80 chars to
        // keep the observe token budget intact.
        const normName = (s: string | null | undefined): string =>
          (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

        function getAccessibleName(el: HTMLElement): string {
          const aria = el.getAttribute("aria-label");
          if (aria) return normName(aria);
          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy) {
            // aria-labelledby 是空格分隔 IDREF 列表(非单 ID);在元素所在 root 内
            // 逐个解析(ShadowRoot/Document 都有 getElementById,支持 shadow 内 label)
            // 再拼接。旧逻辑整串 document.getElementById 仅命中单 id 且仅主文档,多
            // IDREF / shadow 内全漏(2026-06-04 审计)。
            const root = el.getRootNode() as Document | ShadowRoot;
            const parts: string[] = [];
            for (const id of labelledBy.split(/\s+/)) {
              if (!id) continue;
              const label =
                typeof (root as Document).getElementById === "function"
                  ? (root as Document).getElementById(id)
                  : document.getElementById(id);
              if (label) parts.push(label.textContent ?? "");
            }
            if (parts.length) return normName(parts.join(" "));
          }
          if (
            el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.tagName === "SELECT"
          ) {
            const id = el.id;
            if (id) {
              const lbl = document.querySelector(`label[for="${id}"]`);
              if (lbl) return normName(lbl.textContent);
            }
            // radio / checkbox 通常包在 <label> 里（Element Plus el-radio / el-checkbox 风格）
            const t = (el as HTMLInputElement).type;
            if (t === "radio" || t === "checkbox") {
              const wrapLabel = el.closest("label");
              if (wrapLabel) return normName(wrapLabel.textContent);
            }
            // AH: <input type=submit|button|reset|image> 的可访问名取 value 属性
            // (HTML-AAM)。表单提交/搜索/登录按钮极常见(saucedemo 登录/结账按钮都是
            // <input type=submit value="Login/Continue">),旧逻辑只读 label/placeholder
            // → 全显示为无名 [button]。image 优先 alt;value 缺省回退类型默认名。
            // 严格限定这几种「value 是静态标签」的类型,绝不读 text/password 的 value
            // (那是用户输入/敏感内容,与 getValueInfo 同纪律)(2026-06-02 dogfood AH)。
            if (t === "submit" || t === "button" || t === "reset" || t === "image") {
              if (t === "image") {
                const alt = el.getAttribute("alt");
                if (alt) return normName(alt);
              }
              const v = (el as HTMLInputElement).value;
              if (v) return normName(v);
              if (t === "submit") return "Submit";
              if (t === "reset") return "Reset";
              if (t === "image") return "Submit Query";
            }
            // AI: <select> 不能落到下面 textContent 兜底——select 的 textContent 是
            // 全部 <option> 文本的拼接("Name (A to Z)Name (Z to A)Price..."噪声)。
            // 名应来自 label/aria(已在上面解析),无 label 则返空(当前选中值由
            // getValueInfo 以 value= 暴露)(2026-06-02 dogfood AI)。
            return (
              el.getAttribute("placeholder") || el.getAttribute("title") || ""
            );
          }
          if (el.tagName === "IMG") {
            return el.getAttribute("alt") || el.getAttribute("title") || "";
          }
          // role=treeitem 的 innerText 会包含 expanded 子节点的文本（"华东\n上海\n..."），
          // 取直接子代的 click 区文字（Element Plus: .el-tree-node__content）。
          const role = el.getAttribute("role");
          if (role === "treeitem") {
            const content = el.querySelector(":scope > .el-tree-node__content") as HTMLElement | null;
            if (content) return normName(content.textContent);
          }
          // <label> 包裹的 labelable 控件(input/select/textarea)若自带 aria-label,
          // 该 aria-label 即控件——也即这个可点 <label>——的可达名。label 的
          // textContent 此时常是快捷键角标(Excalidraw 工具栏 "1".."0")或为空,会盖过
          // 真名,故优先取嵌套控件 aria-label。Element Plus el-radio/el-checkbox 的
          // 嵌套 input 无 aria-label(可见文本在兄弟 span),不命中此分支,仍回退到
          // 下面的 textContent 取 "北京" 等,无回归。(2026-06-01 excalidraw dogfood)
          if (el.tagName === "LABEL") {
            const ctrl = el.querySelector("input, select, textarea");
            const ctrlAria = ctrl?.getAttribute("aria-label");
            if (ctrlAria) return normName(ctrlAria);
            // 包裹式 <label>(由 label:has(input[type=radio/checkbox]) 收的组件库
            // 控件,如 Element Plus el-radio/el-checkbox)的 textContent 就是该控件
            // 的可及名(HTML <label> 语义 + ARIA name-from-content)。e506fb9 把
            // radio/checkbox input(带 tabindex=0)纳入交互池后,下方 isContainer
            // 会因 label 含 input[tabindex] 后代而判其为「噪声容器」返空 → 名留空被
            // BUG-3 丢弃,而 input 自身又被 surrogate 门(opacity:0)跳过 → 整个
            // 选项控件隐形(spa-route-residue 漏选项 A/B/C、el-transfer 漏 checkbox)。
            // <label> 是有定义语义的标签元素(关联唯一 labelable 控件),其文本有界
            // 且就是控件名,不属 isContainer 针对的 focus-wrapper 噪声,故先于
            // isContainer 用 label 自身文本兜住(2026-06-03 bench 回归)。
            const wrapsCheckRadio = el.querySelector(
              "input[type=checkbox], input[type=radio]",
            );
            if (wrapsCheckRadio) {
              const labelText = normName(el.textContent);
              if (labelText) return labelText;
              // 缺陷① (2026-06-07 v4 淘宝评测): <label> 包 radio/checkbox 但
              // labelText 为空 (淘宝 emoji 雪碧图、Element Plus 纯图标 label、
              // Ant Design 自定义单选组等同病)。原行为: 落到 isContainer
              // 返空 → BUG-3 噪声过滤器丢弃 → 整控件在 observe 中隐形。
              // 通用化兜底: 用 input.type + input.value + bbox 位置生成可定位
              // 名, agent 仍能定位并操作 (不写淘宝特定字典, 不依赖 className
              // 拼写是否正确, 不依赖 aria-label 注入)。位置用 el (label 自
              // 身) 的 bbox 而非 input 的 bbox, 保证与 observe 报告的 bbox
              // 字段一致, agent 拿名即可定位。
              const inp = wrapsCheckRadio as HTMLInputElement;
              const role = inp.type === "checkbox" ? "checkbox" : "radio";
              const val = inp.value || "?";
              const rect = el.getBoundingClientRect();
              return `${role}=${val} @x=${Math.round(rect.left)},y=${Math.round(rect.top)}`;
            }
          }
          // AJ: 有交互后代的元素是**容器**,其 textContent 是子控件文本的拼接
          // (噪声),非自身标签——不作名源。典型:focus 管理用的 `<div tabindex=0>`
          // 包整个内容区(GitHub SharedPageLayout),无 role/aria-label,经 [tabindex]
          // 被 INTERACTIVE_SELECTORS 捕获,旧逻辑落到 textContent 取「anthropics/...
          // main36 Branches193 Tags...」整片拼接,且这个噪声名又击败了下游 BUG-3
          // 噪声过滤器的 `!name` 判定使其漏网。名留空后 BUG-3(filter=interactive)
          // 自动丢弃该幽灵容器。
          // ARIA name-from-content 本只对特定 role 生效;vortex 对 cursor:pointer
          // 自定义按钮 div 用 textContent 是 **leaf**(无交互后代)场景,不受影响。
          // 判别用「有交互后代」而非 cursor:免一次 getComputedStyle,且精准:leaf
          // 控件 querySelector 落空保留名,容器命中留空(2026-06-02 dogfood AJ)。
          //
          // REQ-009 N0060 京东评测 A 方案: icon-link 兜底 — 京东商品卡 30 个
          // 客服图标 `<a class="_newIcon_zclqt_32 _customer_service_icon_zclqt_60"
          // href="https://chat.jd.com/...">` (16x16, 无文本/aria/title) 是
          // 跨平台"图标式无文本 link"代表, 旧路径返空 → BUG-3 噪声过滤 / 进
          // LLM 视野当空名 link 处理。检测 5 条件 (tag==a / 无 children /
          // 无 textContent / bbox ≤32x32 / href 非空), 命中给固定名
          // `icon-link @x=N,y=N`。放在 PRODUCT_HINTS 之前: 商品卡 (整张 <a>
          // 含 textContent 商品特征) 应走 PRODUCT_HINTS 优先路径, icon-link
          // 仅兜底"小图标 link" 场景。aria-label / title 命中时不抢, 让有意义
          // 的 attribute 优先 (购物车图标常含 aria-label="购物车")。
          const iconLink = iconLinkName(el);
          if (iconLink) return iconLink;
          //
          // P1-1 修复方向重做(vortex-bench 2026-06-07 V4 淘宝评测 §7.3.1):
          // d4b7330 旧修复"判直属文本节点"在淘宝商品卡 <a class="doubleCardWrapperAdapt">
          // 上 directTextNodes=[] (所有文本在子 div) → 修复未生效,V4 复跑 3 品类
          // 空名率仍 ~30%。改判"textContent 含商品特征" (¥/￥/人付款/回头客/
          // 已售/月销):整张卡是链接 + textContent 含商品信息 → 卡片是商品卡,
          // 用自身 textContent (信息最丰富,标题/价格/销量/店铺名)。先于
          // isContainer 判定,确保"自身有商品信息"不被当容器丢弃。
          const PRODUCT_HINTS = /[\u00a5￥]\d|人付款|回头客|已售|月销/;
          const text = normName(el.textContent);
          if (text && PRODUCT_HINTS.test(text)) return text;
          const isContainer =
            el.querySelector(
              "a[href],button,input,select,textarea,[tabindex],[contenteditable=true]",
            ) != null;
          if (text && !isContainer) return text;
          // title 属性是 accname 规范的末位兜底名源:纯图标按钮常只有 title
          // (Excalidraw "更多工具" 触发器只有 title + 一个 svg)。放在 textContent
          // 之后、className 之前——有真文本时不抢,纯图标时优于 className hash。
          const titleAttr = el.getAttribute("title");
          if (titleAttr) return normName(titleAttr);
          // 容器(有交互后代)且无 label/title → 返空,交 BUG-3 噪声过滤器丢弃;
          // **不**走 className icon 兜底——容器常含头像/图标 img 会误触发
          // iconNameFromClass 取个 hash 噪声名,反而又击败 `!name` 过滤(AJ)。
          if (isContainer) return "";
          // 仅 svg/img 子且无文本无 title 时，从 className 兜底（如 `_closeIcon_1ygkr_39` → `closeIcon`）
          const fromIcon = iconNameFromClass(el);
          if (fromIcon) return fromIcon;
          // 控件类(无 role/无 name 的 vxe-cell--checkbox 等)按终末 token 取角色名。
          // 接在 svg/img 类名之后、字体图标之前:控件语义强于泛图标名。
          const ctrlRole = controlRoleFromClass(el);
          if (ctrlRole) return ctrlRole;
          // BUG-008 修复(V4 §7.4 淘宝评测):淘宝 sticky bar CTA 是 <div> 包
          //   <i> 购物车 icon。标准 fallback 全不命中 → 返空 → BUG-3 过滤掉。
          //   用 STICKY_BAR_CTA_REGEX 共享常量(见下方 collection 步骤)反推
          //   cta 名,让 BUG-3 放行。仅 div 命中,其它 tag 返空。
          const stickyCtaName = stickyBarCtaName(el);
          if (stickyCtaName) return stickyCtaName;
          // 末位:CSS 字体图标按钮(bi-/fa-/glyphicon-/vxe-icon-/van-icon-,::before 字形
          // 无 inner svg/img)。isContainer 已在上方返空,此处只给 leaf 图标按钮补名;
          // 不碰 cursor:pointer 入池门,规避 round-12 幽灵续命。
          return iconFontName(el);
        }

        // BUG-008 修复(V4 §7.4 淘宝评测) — 命名兜底,函数声明在调用前出现
        //   (hoisted),内部引用 STICKY_BAR_CTA_REGEX (下方 collection 步骤声明
        //   的 const),调用时机在 main for-loop,常量已初始化。
        function stickyBarCtaName(el: HTMLElement): string {
          if (el.tagName !== "DIV") return "";
          const iconChild = el.querySelector("i");
          if (!iconChild) return "";
          const cls = iconChild.getAttribute("class") || "";
          if (STICKY_BAR_CTA_REGEX.test(cls)) return "add-to-cart";
          return "";
        }

        // Pre-index aria-label occurrences once per snapshot so buildSelector
        // can decide uniqueness in O(1) instead of running a fresh
        // querySelectorAll for every observed element. On a 50-element
        // search results page that turns an O(N²) DOM scan into O(N).
        const ariaLabelCount = new Map<string, number>();
        for (const el of document.querySelectorAll("[aria-label]")) {
          const lbl = el.getAttribute("aria-label");
          if (lbl) ariaLabelCount.set(lbl, (ariaLabelCount.get(lbl) ?? 0) + 1);
        }

        // 给元素打唯一 data-vortex-rid 并返回该 selector。供两类情况复用：
        // (1) light-DOM 路径选择器歧义；(2) shadow-internal 元素（路径在 shadow 边界断裂）。
        // setAttribute 失败（非 Element / sandbox shadow）时返回 null，由调用方回退。
        // 注意：ridCounter 在 try 块之前自增，失败时 ridCounter 仍自增一格，无害——该 rid 不写入任何元素。
        function stampRid(el: Element): string | null {
          const rid = ridPrefix + ridCounter++;
          try {
            el.setAttribute("data-vortex-rid", rid);
            return `[data-vortex-rid="${rid}"]`;
          } catch (err) {
            try {
              console.warn("[vortex] data-vortex-rid stamp failed", err);
            } catch {
              // console 也可能被 sandbox，忽略。
            }
            return null;
          }
        }

        function buildSelector(el: Element): string {
          // shadow-internal 元素无法用 light-DOM CSS 路径定位（路径在 shadow 边界断裂，
          // 退化为裸 tag）。始终戳唯一 rid，交由穿 shadow 的 resolver 命中。
          if (el.getRootNode() instanceof ShadowRoot) {
            const stamped = stampRid(el);
            if (stamped) return stamped;
            // 戳记失败：回退裸 tag（仍优于崩溃；下游 deep resolver 命中即可，
            // 多命中则 SELECTOR_AMBIGUOUS）。
            return el.tagName.toLowerCase();
          }
          // id 唯一才用 #id —— 重复 id(无效 HTML 但 Modal/Drawer 覆盖同结构表单时
          // 常见,如 antd Pro 页面 search 与 Modal 均渲染 #name)会让下游 querySelector
          // 命中第一个(弹层背后被 mask 遮挡)元素 → actionability OBSCURED。歧义时
          // fall through 到路径/rid 分支保 1:1。(2026-06-13 antd Pro dogfood A1)
          if (
            el.id &&
            /^[a-zA-Z][\w-]*$/.test(el.id) &&
            document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1
          )
            return `#${CSS.escape(el.id)}`;
          const testId =
            el.getAttribute("data-testid") || el.getAttribute("data-test");
          if (testId) {
            const attr = el.getAttribute("data-testid") ? "data-testid" : "data-test";
            const testSel = `[${attr}="${testId.replace(/"/g, '\\"')}"]`;
            // 同 id:testid 也可能重复(列表项复用),唯一才用,否则 fall through。
            if (document.querySelectorAll(testSel).length === 1) return testSel;
          }
          // aria-label is the next-most-stable anchor for actionable widgets
          // (button / link / form control). It survives React re-renders that
          // shift nth-of-type indices, which made GitHub Star buttons unclickable
          // via @eN refs in v0.6 dogfood (search results — sibling repos kept
          // re-mounting). Only emit when the label is page-unique so dom.click
          // won't trip SELECTOR_AMBIGUOUS; otherwise fall through to the
          // path-based fallback below.
          const ariaLabel = el.getAttribute("aria-label");
          if (
            ariaLabel &&
            ariaLabel.length > 0 &&
            ariaLabel.length < 120 &&
            ariaLabelCount.get(ariaLabel) === 1
          ) {
            const tag = el.tagName.toLowerCase();
            const escaped = ariaLabel.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            return `${tag}[aria-label="${escaped}"]`;
          }
          const parts: string[] = [];
          let cur: Element | null = el;
          let depth = 0;
          while (cur && cur.nodeType === 1 && depth < 8) {
            const parent = cur.parentElement;
            if (!parent) {
              parts.unshift(cur.tagName.toLowerCase());
              break;
            }
            const sameTagSiblings = Array.from(parent.children).filter(
              (c) => c.tagName === cur!.tagName,
            );
            const tag = cur.tagName.toLowerCase();
            if (sameTagSiblings.length > 1) {
              const idx = sameTagSiblings.indexOf(cur) + 1;
              parts.unshift(`${tag}:nth-of-type(${idx})`);
            } else {
              parts.unshift(tag);
            }
            if (parent.tagName === "BODY" || parent.tagName === "HTML") {
              parts.unshift(parent.tagName.toLowerCase());
              break;
            }
            cur = parent;
            depth++;
          }
          const sel = parts.join(" > ");
          // Path may collide with sibling structures (Element Plus v-for
          // groups, repeated table rows, etc.). When ambiguous, stamp the
          // element with a unique data-vortex-rid attribute and return
          // that — guarantees a 1:1 selector for downstream act/extract.
          if (document.querySelectorAll(sel).length > 1) {
            const stamped = stampRid(el);
            if (stamped) return stamped;
            // 戳记失败 → 落到（仍歧义的）路径，让运行时得到可读的 SELECTOR_AMBIGUOUS。
          }
          return sel;
        }

        function describeElement(el: Element): string {
          const classStr =
            typeof el.className === "string" && el.className
              ? "." + el.className.split(" ").filter(Boolean).join(".")
              : "";
          return (
            el.tagName.toLowerCase() +
            (el.id ? `#${el.id}` : "") +
            classStr
          );
        }

        // O-8: framework UI state from class / aria.
        // 代理拿到 observe 结果时最需要的两个问题：
        //   1. checkbox/radio 当前是不是 checked（Element Plus 把状态放在 label.is-checked，不在 input）
        //   2. tab 当前是不是 active（div.is-active / [aria-selected=true]）
        // 下面的 getUiState 沿 el 自身 + 上溯 2 层 ancestor 扫这几个 class / aria。
        function getUiState(el: HTMLElement): {
          checked?: boolean;
          selected?: boolean;
          active?: boolean;
          disabled?: boolean;
          expanded?: boolean;
          required?: boolean;
          current?: boolean;
          invalid?: boolean;
          sort?: "ascending" | "descending" | "none";
          haspopup?: string;
        } | undefined {
          const s: {
            checked?: boolean;
            selected?: boolean;
            active?: boolean;
            disabled?: boolean;
            expanded?: boolean;
            required?: boolean;
            current?: boolean;
            invalid?: boolean;
            sort?: "ascending" | "descending" | "none";
            haspopup?: string;
          } = {};
          let cur: Element | null = el;
          for (let i = 0; i < 3 && cur; i++, cur = cur.parentElement) {
            const cls =
              typeof cur.className === "string" ? cur.className : "";
            // is-* 组件类约定可落在包裹祖先(Element Plus 把 is-checked 放 wrapper
            // label,故跨祖先查);但 ARIA aria-checked/selected/pressed 按规范落在
            // 角色元素自身,上溯祖先会把容器(role=option aria-selected)状态误归
            // 内部子控件(<button> 误带 [selected])。aria-* 仅在 i===0(el 自身)读
            // (2026-06-04 审计 LIVE 确认)。
            const selfAria = i === 0;
            if (s.checked === undefined) {
              if (cls.includes("is-checked") || (selfAria && cur.getAttribute("aria-checked") === "true")) {
                s.checked = true;
              }
            }
            if (s.selected === undefined) {
              if (cls.includes("is-selected") || (selfAria && cur.getAttribute("aria-selected") === "true")) {
                s.selected = true;
              }
            }
            if (s.active === undefined) {
              if (cls.includes("is-active") || (selfAria && cur.getAttribute("aria-pressed") === "true")) {
                s.active = true;
              }
            }
          }
          // AE: 该元素被某控件的 aria-activedescendant 指向 = 当前虚拟焦点(键盘
          // 高亮项)。combobox/listbox/tree/grid 方向键导航时焦点不在该项 DOM 上,
          // 只有触发器的 aria-activedescendant 指过来——标 [active] 让 agent 知道
          // 「方向键当前落在哪项、Enter 会选中谁」。与 is-active/aria-pressed 同义
          // (都表示「一组里当前激活的那个」),复用同一 flag(2026-06-02 dogfood AE)。
          // 按元素身份匹配(集合已在各 root 内 scope-正确解析),避免跨 scope 同名
          // id 误标。
          if (s.active === undefined && activeDescendantEls.has(el)) {
            s.active = true;
          }
          // 原生 checkbox/radio 的勾选态在 IDL .checked(不在 class/aria)。组件库
          // 把状态放 label.is-checked 上由上面的循环覆盖;此处补两类:裸露的原生
          // input(AB 修复后才可见)读自身 .checked;包裹式 <label>(surface 元素
          // 是 label、内嵌 input 被 surrogate 门去重)读其内嵌 checkbox/radio——
          // 否则普通 <label><input checked> 永远不显示勾选态(2026-06-02 dogfood AB)。
          if (s.checked === undefined) {
            let probe: HTMLInputElement | null = null;
            if (el.tagName === "INPUT") {
              probe = el as HTMLInputElement;
            } else if (el.tagName === "LABEL") {
              probe = el.querySelector(
                "input[type=checkbox], input[type=radio]",
              ) as HTMLInputElement | null;
            }
            if (
              probe &&
              (probe.type === "checkbox" || probe.type === "radio") &&
              probe.checked === true
            ) {
              s.checked = true;
            }
          }
          // 班牛 bnCheck:勾选态 = 后代 .bnCheck-status 的裸 `checked` class,既非
          // is-checked 也非 aria/native,上面全漏——单独补(N0064 P2-1)。
          if (s.checked === undefined) {
            const bn = bnCheckInfo(el);
            if (bn && bn.checked) s.checked = true;
          }
          // 禁用判定用 :disabled 伪类而非 IDL .disabled 属性:<fieldset disabled>
          // 会级联禁用内部所有控件(浏览器真禁用、阻断交互),但子控件的 IDL
          // .disabled 仍返 false——只有 :disabled 伪类反映级联真状态(同样覆盖
          // disabled <optgroup>/<select> 内的 option)。旧逻辑只看 .disabled →
          // 漏标 fieldset 级联禁用控件,agent 误以为可点、白等满 timeout 才 DISABLED
          // 失败(2026-06-02 dogfood)。:disabled 是 .disabled 的严格超集,无回归。
          // aria-disabled 仍须看值:组件库常给启用元素显式写 aria-disabled="false",
          // 只判属性存在会把启用元素误标禁用(2026-06-01 dialog dogfood)。
          if (
            (typeof el.matches === "function" && el.matches(":disabled")) ||
            el.getAttribute("aria-disabled") === "true"
          ) {
            s.disabled = true;
          }
          // aria-expanded:下拉菜单 / combobox / 折叠面板 / 树节点的开合状态。
          // 折叠与展开态的菜单按钮 observe 输出本来完全相同,agent 无法判断下拉
          // 是否已打开(会重复点开、或开着却去别处找选项)。只在 ="true" 时发
          // [expanded] 标记(与 checked/selected 同模式,collapsed 不发避免噪声)。
          // 仅查元素自身——aria-expanded 按 ARIA 惯例落在触发器本身,上溯祖先会
          // 把无关父级的展开态错配到子按钮(2026-06-02 dogfood)。
          if (el.getAttribute("aria-expanded") === "true") {
            s.expanded = true;
          } else if (
            // 原生 <details>/<summary> disclosure 的开合态在 details.open IDL 属性上,
            // 不在 aria-expanded(MDN CSS 侧栏 108 个属性分组、文档站 FAQ 折叠面板均
            // 用原生 details)。<summary> 的宿主 <details> 打开时发 [expanded],与
            // aria-expanded 同语义、同「collapsed 不发避免噪声」策略,使原生折叠组与
            // 展开组在 observe 中可区分(2026-06-03 MDN dogfood)。
            el.tagName === "SUMMARY" &&
            el.parentElement?.tagName === "DETAILS" &&
            (el.parentElement as HTMLDetailsElement).open === true
          ) {
            s.expanded = true;
          }
          // 必填字段:agent 填表前需知道哪些字段必填(否则提交才报错)。
          // observe-render 早已支持 [required] 标记,但 producer 一直没接线
          // (死标记)。原生 required 属性(input/select/textarea)+ ARIA
          // aria-required="true" 双覆盖(2026-06-02 dogfood)。
          // 包裹式 <label><input required> 的 surface 元素是 label,required 在内嵌
          // 控件上、label 自身 .required 为 undefined → 漏标。同 checked 钻入内嵌
          // input/select/textarea 读(2026-06-04 审计)。
          let reqProbe: Element = el;
          if (el.tagName === "LABEL") {
            const inner = el.querySelector("input, select, textarea");
            if (inner) reqProbe = inner;
          }
          if (
            (reqProbe as HTMLInputElement).required === true ||
            reqProbe.getAttribute("aria-required") === "true" ||
            el.getAttribute("aria-required") === "true"
          ) {
            s.required = true;
          }
          // aria-current:导航/分页/面包屑/步骤条「你在这」。任何非 "false" 的
          // 取值(page/step/location/date/time/true)都表示当前项;agent 据此
          // 定位「已在哪一项」避免重复导航。值语义("false"=否)而非属性存在判定
          // (2026-06-02 dogfood)。
          const ariaCurrent = el.getAttribute("aria-current");
          if (ariaCurrent != null && ariaCurrent !== "false") {
            s.current = true;
          }
          // aria-invalid:表单字段校验失败(true/grammar/spelling 均为无效,false/
          // 缺省为有效)。agent 修表单时需知道哪些字段没通过校验,否则反复提交。
          // 只认作者显式的 aria-invalid(非 :invalid 伪类——后者对初始空 required
          // 字段也匹配,噪声大;aria-invalid 是「确实校验失败了」的明确信号)。
          // 值语义判定,aria-invalid="false" 不误标(2026-06-02 dogfood)。
          const ariaInvalid = el.getAttribute("aria-invalid");
          if (ariaInvalid != null && ariaInvalid !== "false") {
            s.invalid = true;
          }
          // aria-sort:可排序列表头的当前排序方向。排序表头 observe 输出本来完全
          // 相同,agent 不知当前按哪列、何方向(会重复点已排好的列、或漏判已排序
          // 状态)。ascending/descending → [sort:asc]/[sort:desc];none → [sortable]
          // (是排序控件但当前未排,区别于无 aria-sort 的普通表头)。aria-sort 按
          // ARIA 惯例落在 columnheader 自身,只查元素自身(2026-06-02 dogfood AC)。
          const ariaSort = el.getAttribute("aria-sort");
          if (ariaSort === "ascending" || ariaSort === "descending") {
            s.sort = ariaSort;
          } else if (ariaSort === "none" || ariaSort === "other") {
            // "other"=以非升降序排序(ARIA 合法值,罕见)。无方向可报,但仍是
            // 排序控件 → 标 sortable 保留可排序提示(评审 advisory)。
            s.sort = "none";
          }
          // AA: aria-haspopup 弹层可供性。菜单按钮/拆分按钮/combobox/"更多操作"
          // 溢出按钮点击会弹出 menu/listbox/tree/grid/dialog;agent 据此预判点击后
          // 出现弹层、规划「点开→在弹层里选」的多步交互(否则只见一个无差别 button)。
          // "true" 按 ARIA 等价规范化为 "menu";非法值兜底为 "menu"(haspopup 存在
          // 即必有弹层);"false"/缺省不发。值语义判定(2026-06-02 dogfood AA)。
          const ariaHaspopup = el.getAttribute("aria-haspopup");
          if (ariaHaspopup != null && ariaHaspopup !== "false") {
            s.haspopup =
              ariaHaspopup === "listbox" ||
              ariaHaspopup === "tree" ||
              ariaHaspopup === "grid" ||
              ariaHaspopup === "dialog"
                ? ariaHaspopup
                : "menu";
          }
          return Object.keys(s).length > 0 ? s : undefined;
        }

        // 值域控件の当前值:slider / spinbutton / progressbar / scrollbar / meter
        // 及原生 <input type=range|number> / <progress> / <meter>。
        // 同时暴露文本控件(text/email/search/tel/url/textarea/contenteditable)的
        // IDL 当前值(el.value)，使 fill→verify value 闭环成立。
        // password 类型**严格排除**：由 password 防护层(observe 后处理)统一剥除，
        // 绝不进 LLM 上下文。
        // 优先 aria-valuetext(人类可读,如 "中" / "$50"),否则 valuenow,并在
        // 有 valuemax 时拼成 "now/max"(进度/百分比靠 max 才有意义)。返回字符串
        // 或 undefined(2026-06-02 dogfood)。
        const VALUE_ROLES = new Set([
          "slider", "spinbutton", "progressbar", "scrollbar", "meter",
        ]);
        // 文本输入控件:这些类型的 IDL el.value 反映用户当前输入值，
        // 需暴露给 verify value mode 校验(fill 后 HTML 属性值不更新)。
        // password 不含：其 IDL value 不应进 LLM 上下文，由密码防护层剥除。
        const TEXT_INPUT_TYPES = new Set([
          "text", "email", "search", "tel", "url", "",
        ]);
        function getValueInfo(el: HTMLElement, role: string): string | undefined {
          const tag = el.tagName.toLowerCase();
          // AI: 原生 <select> 的当前选中项文本。select 名常无 label(saucedemo 排序
          // 下拉),其「当前选了什么」才是 agent 调它前最需要的信息。选项是有界标签
          // (非自由文本/非 password),安全暴露——与「不暴露 text/password value」不冲突。
          // multiple 列出全部选中项逗号分隔;空选返 undefined(2026-06-02 dogfood AI)。
          if (tag === "select") {
            const opts = Array.from((el as HTMLSelectElement).selectedOptions);
            if (opts.length === 0) return undefined;
            const txt = opts.map((o) => o.text).join(", ").replace(/\s+/g, " ").trim();
            return txt ? txt.slice(0, 60) : undefined;
          }
          const inputType =
            tag === "input" ? (el as HTMLInputElement).type : "";
          // 文本控件 IDL 当前值:text/email/search/tel/url 及 type 未设(""=text)。
          // password 严格排除——由 observe 后处理密码防护层剥除 valueNow。
          // 截断至 200 字符，避免大型 textarea 撑爆输出。
          if (tag === "input" && TEXT_INPUT_TYPES.has(inputType)) {
            const v = (el as HTMLInputElement).value;
            return v !== "" ? v.slice(0, 200) : undefined;
          }
          if (tag === "textarea") {
            const v = (el as HTMLTextAreaElement).value;
            return v !== "" ? v.slice(0, 200) : undefined;
          }
          if ((el as HTMLElement).isContentEditable) {
            const v = (el as HTMLElement).textContent ?? "";
            return v !== "" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
          }
          const isNativeValue =
            (tag === "input" && (inputType === "range" || inputType === "number")) ||
            tag === "progress" ||
            tag === "meter";
          if (!VALUE_ROLES.has(role) && !isNativeValue) return undefined;
          const valueText = el.getAttribute("aria-valuetext");
          // 归一化空白(换行/制表 → 单空格)再截断,避免破坏单行输出;render 侧
          // 对含空格的值加引号。
          if (valueText) return valueText.replace(/\s+/g, " ").trim().slice(0, 40);
          let now = el.getAttribute("aria-valuenow");
          let max = el.getAttribute("aria-valuemax");
          if ((now == null || now === "") && isNativeValue) {
            // indeterminate <progress>(无 value 属性,.position === -1)进度未知,
            // 不能报 .value(IDL 对 indeterminate 返 0)否则 agent 误判「卡在 0%」。
            if (tag === "progress" && (el as HTMLProgressElement).position === -1) {
              return undefined;
            }
            // 原生控件:range/number 用 .value;progress/meter 用 .value/.max。
            const v = (el as HTMLInputElement | HTMLProgressElement | HTMLMeterElement).value;
            now = v != null ? String(v) : null;
            const m = (el as HTMLProgressElement | HTMLMeterElement | HTMLInputElement).getAttribute("max");
            if (m != null && m !== "") max = m;
          }
          if (now == null || now === "") return undefined;
          return max != null && max !== "" ? `${now}/${max}` : `${now}`;
        }

        /**
         * 为特殊 input 类型构建 compound 元数据对象。
         * - date/time/datetime-local/month/week:注入格式串 formatHint。
         * - file:读 element.files 当前文件名(多文件给计数),未选显 None。
         * - range/number:读 min/max/step 属性(缺省不填)。
         * 非目标类型返回 undefined,不干扰其他控件。
         */
        function buildInputCompound(el: HTMLElement): {
          role: string; formatHint?: string;
          min?: string; max?: string; step?: string;
        } | undefined {
          if (el.tagName !== "INPUT") return undefined;
          const inputEl = el as HTMLInputElement;
          const t = inputEl.type;
          // date/time 格式族:按 type 注入对应格式串供 LLM fill 参考
          const DATE_FORMAT_MAP: Record<string, string> = {
            "date": "YYYY-MM-DD",
            "time": "HH:mm",
            "datetime-local": "YYYY-MM-DDTHH:mm",
            "month": "YYYY-MM",
            "week": "YYYY-Www",
          };
          if (t in DATE_FORMAT_MAP) {
            return { role: "date-input", formatHint: DATE_FORMAT_MAP[t] };
          }
          // file input:显示当前选中文件名;多文件计数;未选显 None
          if (t === "file") {
            const files = inputEl.files;
            let hint = "None";
            if (files && files.length > 0) {
              hint = files.length === 1
                ? files[0].name
                : `${files.length} files`;
            }
            return { role: "file-input", formatHint: hint };
          }
          // range/number:读 min/max/step 属性(缺省不显)
          if (t === "range" || t === "number") {
            const roleStr = t === "range" ? "range-input" : "number-input";
            const minV = el.getAttribute("min") ?? undefined;
            const maxV = el.getAttribute("max") ?? undefined;
            const stepV = el.getAttribute("step") ?? undefined;
            // 三属性均无时不生成 compound(避免噪声)
            if (!minV && !maxV && !stepV) return undefined;
            return {
              role: roleStr,
              ...(minV !== undefined ? { min: minV } : {}),
              ...(maxV !== undefined ? { max: maxV } : {}),
              ...(stepV !== undefined ? { step: stepV } : {}),
            };
          }
          return undefined;
        }

        // BUG-2: filter='all' previously was a dead parameter — server.ts
        // forwarded it but the handler never read args.filter, so the public
        // schema's promise of "non-interactive elements too" silently
        // degraded to the interactive whitelist. Honor it now by appending
        // structural roles that table-heavy pages expose (rows / cells /
        // column headers) so LLMs can reference data grid coordinates.
        const TABLE_EXTRA_SELECTORS =
          "tr,td,th,[role=row],[role=cell],[role=columnheader],[role=rowheader],[role=gridcell]";
        const ROOT_SELECTORS =
          filter === "all"
            ? `${INTERACTIVE_SELECTORS},${TABLE_EXTRA_SELECTORS}`
            : INTERACTIVE_SELECTORS;

        // Walk open shadow roots in addition to the light DOM. The
        // baseline 2026-05-19 run exposed that custom-element-heavy
        // pages (web components / Lit / Stencil / lots of SaaS UIs)
        // had 0 elements surfaced because document.querySelectorAll
        // does not pierce shadow boundaries — the in-shadow buttons
        // / inputs / links were invisible to observe. CDP's
        // Accessibility.getFullAXTree DOES flatten open shadow but
        // observe uses chrome.scripting.executeScript page-side scan
        // (different code path from reasoning/ax-snapshot.ts which
        // I22 covers). Closed shadow roots remain invisible per the
        // CE spec — `element.shadowRoot` returns null for closed.
        const SHADOW_WALK_MAX_DEPTH = 8;
        function querySelectorAllDeep(
          selector: string,
          root: Document | ShadowRoot,
          depth = 0,
        ): Element[] {
          const acc: Element[] = Array.from(root.querySelectorAll(selector));
          if (depth >= SHADOW_WALK_MAX_DEPTH) return acc;
          for (const host of root.querySelectorAll("*")) {
            const sr = (host as HTMLElement).shadowRoot;
            if (sr) acc.push(...querySelectorAllDeep(selector, sr, depth + 1));
          }
          return acc;
        }

        // document.elementFromPoint 对 shadow-internal 元素返回其 shadow host(composed
        // 树顶,命中重定向到 shadow 边界)。逐级下钻 open shadow root 的 elementFromPoint
        // 得到真实命中元素,使下方遮挡判定对 shadow 内可见元素成立——否则 host !== htmlEl
        // 且 host.contains(htmlEl) 不穿 shadow,三条件全成立误标 visible:false(OBS-1)。
        // 与 shadow-walk.ts:deepElementFromPoint 同语义,observe 扫描自含故内联(同
        // querySelectorAllDeep)。
        function deepElementFromPoint(cx: number, cy: number): Element | null {
          let el = document.elementFromPoint(cx, cy);
          let depth = 0;
          while (el && (el as HTMLElement).shadowRoot && depth < SHADOW_WALK_MAX_DEPTH) {
            const inner = (el as HTMLElement).shadowRoot!.elementFromPoint(cx, cy);
            if (!inner || inner === el) break;
            el = inner;
            depth++;
          }
          return el;
        }

        const nodeList = querySelectorAllDeep(ROOT_SELECTORS, document);

        // AE: aria-activedescendant 指向的「虚拟焦点」目标元素集合。combobox /
        // listbox / tree / grid 用方向键导航时,DOM 焦点停在触发器(input/容器),
        // 当前高亮项由触发器的 aria-activedescendant 指向——该项 DOM 上既无 :focus
        // 也常无 aria-selected,observe 静态扫描完全看不出「键盘光标落在哪项」。
        // 预先把每个触发器的 IDREF **在其自身 root 内**解析成真元素收进 Set,
        // getUiState 据元素身份匹配把目标标 [active](虚拟焦点)。
        // 必须在 host.getRootNode() 内解析(而非全局按 id 字符串匹配):
        // aria-activedescendant 是 scope 内 IDREF,跨 shadow/文档同名 id 全局匹配
        // 会误标无关元素;按 root 解析既 scope 正确、又天然滤掉悬空引用(评审 LOW)。
        // 用 querySelectorAllDeep 穿 open shadow 收集触发器,与主扫描一致(dogfood AE)。
        const activeDescendantEls = new Set<Element>();
        for (const host of querySelectorAllDeep("[aria-activedescendant]", document)) {
          const id = host.getAttribute("aria-activedescendant");
          if (!id) continue;
          const root = host.getRootNode() as Document | ShadowRoot;
          const target =
            typeof (root as Document).getElementById === "function"
              ? (root as Document).getElementById(id)
              : null;
          if (target) activeDescendantEls.add(target);
        }

        // BUG-1: cursor:pointer fallback for custom interactive elements.
        // bytenew / Element Plus / Ant Design 等中文 SaaS 框架普遍用
        // <li/div cursor:pointer @click=...> 而非原生 button / [role=button]，
        // 静态白名单完全捕获不到。事件挂在 Vue/React vnode 层，元素本身
        // 没 onclick 也没 framework key，所以走 computed style 兜底。
        const interactiveSet = new Set<Element>(nodeList);
        // Sweep all elements (Vue/React UI libs frequently use custom
        // tags like <el-button> / <a-link> / <van-cell> for interactive
        // widgets — bytenew testc 行操作 link is <el-button> not <div>),
        // skipping svg internals + non-rendered tags for perf. Shadow-
        // aware via querySelectorAllDeep so a button inside a custom
        // element's open shadow root is reachable through the
        // cursor:pointer fallback path too.
        const fallbackPool = querySelectorAllDeep(
          "*:not(svg *):not(script):not(style):not(meta):not(link):not(head):not(head *)",
          document,
        );
        const FALLBACK_CAP = 5000; // hard ceiling against pathological pages
        const docRoot = document.documentElement;
        const docBody = document.body;
        const cursorPointerExtras: Element[] = [];
        // 框架(React/Vue3)点击处理器探测——见 page-side/framework-handlers.ts(可单测真源,
        // 改一处须同步)。React 把 onClick 挂 `__reactProps$<后缀>`;Vue3 把 @click invoker
        // 存 `_vei.onClick`。裸 <div onClick>(cursor:auto、无 role/[onclick])靠此识别,
        // 是比继承来的 cursor:pointer 更确凿的入池信号(2026-06-04 淘宝评价区
        // 「查看全部评价」ShowButton /「切换大图模式」switchBtnWrap 真漏)。
        const hasFrameworkClick = (node: any): boolean => {
          for (const k of Object.keys(node)) {
            if (k.charCodeAt(0) === 95 && k.startsWith("__reactProps$")) {
              const p = node[k];
              if (
                p &&
                typeof p === "object" &&
                (typeof p.onClick === "function" || typeof p.onClickCapture === "function")
              )
                return true;
            }
          }
          const vei = node._vei;
          if (vei && typeof vei === "object") {
            for (const ck of ["onClick", "onClickCapture"]) {
              const inv = vei[ck];
              if (typeof inv === "function" || (inv && typeof inv.value === "function")) return true;
            }
          }
          return false;
        };
        // content-card 判据内联副本——真源见 page-side/content-card.ts(可单测),
        // inject func 自包含不能 import,改一处须同步另一处。
        const collectClickableDesc = (el: Element, cap = 200): Set<Element> => {
          const set = new Set<Element>();
          const all = el.querySelectorAll("*");
          for (let i = 0; i < all.length && i < cap; i++) {
            const d = all[i];
            if (getComputedStyle(d as Element).cursor === "pointer" || hasFrameworkClick(d)) set.add(d);
          }
          return set;
        };
        const hasOwnContentText = (el: Element, threshold = 8): boolean => {
          const clickable = collectClickableDesc(el);
          const walker = el.ownerDocument!.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let own = 0;
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const t = (node.nodeValue || "").trim();
            if (!t) continue;
            let inClickable = false;
            for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
              if (clickable.has(p)) {
                inClickable = true;
                break;
              }
            }
            if (!inClickable) {
              own += t.length;
              if (own >= threshold) return true;
            }
          }
          return own >= threshold;
        };
        const isClickableContentCard = (el: Element): boolean =>
          hasFrameworkClick(el) && hasOwnContentText(el);
        // self-clickable 内联副本——真源见 page-side/content-card.ts,改一处须同步。
        // 卡自身独立可点(cursor:pointer 或框架 onClick),用于门 1247:含交互后代但
        // 自身可点的内容卡(京东 _card)保留入池。
        const isSelfClickable = (el: Element): boolean =>
          getComputedStyle(el).cursor === "pointer" || hasFrameworkClick(el);
        // isFocusContainerOnly 内联副本——真源见导出函数(可单测),inject func 注入丢
        // 模块作用域不能 import,改一处须同步另一处(源码锁守护)。判据:祖先 role ∈
        // 容器角色集 或 仅靠 tabindex 入池(非原子控件)→ 聚焦/浮层容器(Element UI
        // el-popover/el-dialog/el-drawer 自带 tabindex=0+role=tooltip|dialog),它不
        // 描述子树,下方跨池祖先短路不应因它跳过其 cursor:pointer 子项(N0064 D6
        // columnDisplay 9 列 bnCheck 全丢)。
        const FOCUS_CONTAINER_ROLES = new Set([
          "tooltip", "dialog", "alertdialog", "group", "region", "menu",
          "listbox", "tree", "grid", "table", "tabpanel", "navigation",
          "toolbar", "document", "application", "none", "presentation",
        ]);
        const ATOMIC_INTERACTIVE_SELECTORS =
          "button,a[href],summary,input:not([type=hidden]),select,textarea,label,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=treeitem],[role=option],[contenteditable],[onclick]";
        const isFocusContainerOnly = (anc: Element): boolean => {
          const role = anc.getAttribute("role")?.trim().split(/\s+/)[0];
          if (role && FOCUS_CONTAINER_ROLES.has(role)) return true;
          return !anc.matches(ATOMIC_INTERACTIVE_SELECTORS);
        };
        for (const el of Array.from(fallbackPool)) {
          if (cursorPointerExtras.length >= FALLBACK_CAP) break;
          if (interactiveSet.has(el)) continue;
          // Skip <html> / <body> — a SPA setting cursor:pointer on the root
          // (e.g. global drag layer) would otherwise pull the entire page
          // text in as a single candidate.
          if (el === docRoot || el === docBody) continue;
          // 显式 role="text"/"paragraph" 是作者的「非控件」声明,优先于继承来的
          // cursor:pointer。跳过避免可点卡片内的观看数/时间戳文本被误收。
          // 取首个空格分隔 token 与 getRole 一致:ARIA role 是回退列表,
          // role="text button"+cursor:pointer 旧逻辑用整串 .has() 永不命中 →
          // 幽灵 [text] 续命(2026-06-04 审计 #7,youtube "2.1万 views" 多 token 变体)。
          const fallbackRole = el.getAttribute("role")?.trim().split(/\s+/)[0];
          if (fallbackRole && NON_INTERACTIVE_ROLES.has(fallbackRole)) continue;
          // Skip wrappers that already contain a real interactive child —
          // we don't want both the <li> and the <button> inside it.
          // (Use INTERACTIVE_SELECTORS, not the table-extended set, so
          // table cells with cursor:pointer still get collected when
          // filter='all'.)
          // 内容卡(自身 cursor:pointer 或 framework onClick)即使含交互后代也保留——
          // 它本身是可点击单元(京东商品卡 _card 含客服 a/addCart button,自身可点)。
          // 用 isSelfClickable 而非 isClickableContentCard:真实 _card 全文在可点子里
          // (hasOwnContentText=false),但卡自身 cursor:pointer+onClick 是确凿信号。
          if (el.querySelector(INTERACTIVE_SELECTORS) && !isSelfClickable(el)) continue;
          // Cross-pool ancestor short-circuit: 若祖先链上有 INTERACTIVE_SELECTORS
          // 元素（如 `<li role=menuitem><div cursor:pointer>`、`<label>` 包
          // `<span cursor:pointer>`、`<button>` 包装饰 span 等），整个 ARIA
          // 子树由 ARIA 池独家表述，fallback 跳过避免双现 dual-instance。
          // 走 parentElement 链，命中第一个 ARIA 祖先即停（O(depth)）。
          // 例外:仅因 tabindex 可聚焦的浮层容器(Element UI el-popover/el-dialog/
          // el-drawer:tabindex=0 + role=tooltip|dialog)不是原子点击目标,它不
          // 描述子树——isFocusContainerOnly 跳过它,否则整层弹窗 cursor:pointer 子项
          // (bnCheck/el-dropdown-menu__item)被全吞(N0064 D2/D3/D5/D6/D8)。
          let hasInteractiveAncestor = false;
          for (let p = el.parentElement; p && p !== docBody; p = p.parentElement) {
            if (interactiveSet.has(p) && !isFocusContainerOnly(p)) {
              hasInteractiveAncestor = true;
              break;
            }
          }
          if (hasInteractiveAncestor) continue;
          const htmlEl = el as HTMLElement;
          if (htmlEl.offsetWidth === 0 || htmlEl.offsetHeight === 0) continue;
          // 入池信号:cursor:pointer(常见但继承可疑)或框架确凿绑定的 onClick。
          // 后者更强,覆盖 cursor:auto 的 React/Vue 裸 div 按钮(2026-06-04 淘宝评价区
          // 真漏「查看全部评价」「切换大图模式」)。下游 require-name + 含交互后代/祖先
          // skip + 择叶 全部复用,噪声治理不变。
          if (getComputedStyle(htmlEl).cursor !== "pointer") {
            // 入池信号(cursor!=pointer 时):① framework onClick(React/Vue 委托,读
            // __reactProps$/_vei) ② data-vtx-listener(pre-scan CDP getEventListeners
            // 标记的纯 addEventListener 元素,vanilla/jQuery 直绑——见 observe-js-listener.ts)。
            // 二者并集:framework 覆盖委托型、listener 覆盖直绑型,互补无盲区(T3 discovery)。
            const __hasDirectListener = el.hasAttribute("data-vtx-listener");
            if (!hasFrameworkClick(el) && !__hasDirectListener) continue;
            // framework onClick 常挂事件委托的**容器**层;若内部已有更细 cursor:pointer
            // 子项(如多个 SKU 选项),让位给子项各自入池——否则下方择叶因容器文字最长
            // 保留容器,把多真选项合并成一个不可操作大块(2026-06-04 淘宝 SKU 区回归)。
            // **direct listener 不让位**:addEventListener 绑在元素自身,它就是精确点击
            // 目标(非委托容器),不该让位给装饰性 pointer 子项。仅 framework 委托路径让位。
            if (!__hasDirectListener) {
              const finerDesc = el.querySelectorAll("*");
              let hasFinerPointer = false;
              for (let di = 0; di < finerDesc.length && di < 200; di++) {
                if (getComputedStyle(finerDesc[di] as HTMLElement).cursor === "pointer") {
                  hasFinerPointer = true;
                  break;
                }
              }
              // 内容卡不让位——评价卡 li.item 自身有 onClick + 评价正文,内部
              // cursor:pointer 标签是附属,不该让位给标签(SKU 容器无自有文本仍让位)。
              if (hasFinerPointer && !isClickableContentCard(el)) continue;
            }
          }
          // Use textContent for the gate check — innerText forces layout
          // and we only need the gate decision here. The accessible name
          // for output goes through getAccessibleName later, which already
          // pays the layout cost only on candidates that survive.
          const textProbe = (el.textContent || "").trim().slice(0, 100);
          const ariaProbe = (el.getAttribute("aria-label") || "").trim();
          // probe 决定 candidate 是否入 cursorPointerExtras。文字/aria-label 都空
          // 时尝试 icon-only fallback（CSS Modules 类名兜底，如 close/icon button）。
          // controlRoleFromClass:给无 role/无 name 的控件类(vxe-cell--checkbox)入池信号。
          // **不**加 iconFontName——round-12 约束(装饰字体图标不得进门),它只留显示路径。
          const probe = ariaProbe || textProbe || iconNameFromClass(el) || controlRoleFromClass(el);
          // Require a name to avoid noise from purely decorative
          // cursor:pointer wrappers (e.g. close-button icons handled by
          // event delegation but visually rendered as bare divs).
          if (!probe) continue;
          cursorPointerExtras.push(el);
        }
        // [卡吸收内部] 自身可点的内容卡(isSelfClickable 且含交互后代,如京东 _card
        // 整张可点、内含 addCart button + 客服 a)吸收其内部所有 cursor:pointer 后代——
        // 卡是单一点击单元,内部 pointer 子部件(标题/标签/价格块)不是独立目标。否则
        // 京东每张卡碎成 ~9 条(整页 877 个 cursor:pointer)把 maxElements 预算炸穿。
        // addCart/客服(button/a)在 ARIA 池独立存活,不在 cursorPointerExtras,不受影响。
        // 仅 filter=interactive 启用(filter=all 保持穷尽)。
        let survivingExtras = cursorPointerExtras;
        if (filter === "interactive") {
          const cardAbsorbers = new Set<Element>(
            cursorPointerExtras.filter(
              (el) => isSelfClickable(el) && el.querySelector(INTERACTIVE_SELECTORS) != null,
            ),
          );
          const absorbedByCard = new WeakSet<Element>();
          for (const el of cursorPointerExtras) {
            if (cardAbsorbers.has(el)) continue; // 卡本身不被吸收
            for (let p = el.parentElement; p; p = p.parentElement) {
              if (cardAbsorbers.has(p)) {
                absorbedByCard.add(el);
                break;
              }
            }
          }
          survivingExtras = cursorPointerExtras.filter((el) => !absorbedByCard.has(el));
        }
        // 嵌套 cursor:pointer 时择一保留：
        // - 同文本（如 bytenew sidebar `li > div > div > div` 全是 "首页"）
        //   保留 leaf，drop ancestor；leaf 离 click 目标最近、文本无损失
        // - 异文本（如 JD 标签 `<div>全部<span>96%好评</span></div>` ancestor
        //   "全部 96%好评" 含 leaf 子串 + 主标签）保留 ancestor，drop leaf；
        //   leaf 仅含 inner span 部分文本会让 LLM 拿不到主标签
        // 走每条 candidate 至多一次到最近的 candidate ancestor (O(N·depth))。
        const candidateSet = new Set<Element>(survivingExtras);
        const dropSet = new WeakSet<Element>();
        const normText = (el: Element): string =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim();
        // #42 多 CTA 容器修复:先按「最近 candidate 祖先」把 leaves 分组,预算多 CTA 祖先。
        // isMultiCtaContainer 真源见 page-side/content-card.ts,inline 副本须同步。
        const nearestCandidateAnc = (leaf: Element): Element | null => {
          let p: Element | null = leaf.parentElement;
          while (p) {
            if (candidateSet.has(p)) return p;
            p = p.parentElement;
          }
          return null;
        };
        const ancChildren = new Map<Element, Element[]>();
        for (const leaf of survivingExtras) {
          const anc = nearestCandidateAnc(leaf);
          if (anc) {
            const arr = ancChildren.get(anc);
            if (arr) arr.push(leaf);
            else ancChildren.set(anc, [leaf]);
          }
        }
        // 多 CTA 容器:≥2 个有文本的最近 candidate 子、且自身非内容卡 → 保子、drop 容器。
        // 不查子文本互不为子串(createBox '创建'⊂'创建空白工作表'是中文巧合,仍是独立按钮)。
        const isMultiCtaContainer = (anc: Element, kids: Element[]): boolean => {
          if (kids.length < 2) return false;
          let withText = 0;
          for (const c of kids) {
            if ((c.textContent ?? "").trim().length > 0) withText++;
          }
          if (withText < 2) return false;
          return !isClickableContentCard(anc);
        };
        const multiCtaAncestors = new Set<Element>();
        for (const [anc, kids] of ancChildren) {
          if (isMultiCtaContainer(anc, kids)) multiCtaAncestors.add(anc);
        }
        for (const leaf of survivingExtras) {
          let p: Element | null = leaf.parentElement;
          while (p) {
            if (candidateSet.has(p)) {
              if (multiCtaAncestors.has(p)) {
                // 多 CTA 容器:drop 容器、保所有子 leaf(各自独立动作,如 createBox 三按钮)。
                dropSet.add(p);
              } else {
                const leafText = normText(leaf);
                const ancText = normText(p);
                if (ancText.length > leafText.length && ancText.includes(leafText)) {
                  // ancestor 有额外文本（主标签+leaf 子串），保留 ancestor
                  dropSet.add(leaf);
                } else if (isClickableContentCard(p)) {
                  // 内容卡 ancestor(评价卡/商品卡)优先保留:其正文与标签子异文本
                  // 且不含标签词,旧逻辑会误 drop 容器保留标签 → 评价卡整条丢失。
                  dropSet.add(leaf);
                } else {
                  // 文本等价（嵌套同文本 wrapper），保留 leaf
                  dropSet.add(p);
                }
              }
              break; // 链上更深 ancestor 由它们各自的 leaf 触发处理
            }
            p = p.parentElement;
          }
        }
        const cursorPointerLeaves = survivingExtras.filter(
          (el) => !dropSet.has(el),
        );

        // BUG-008 修复(V4 §7.4 淘宝评测):淘宝 sticky bar CTA 反推 — <div> 包购物车
        //   icon 类,filter=interactive 默认排除 div → 漏抓。扫 <i> className 关键词
        //   反推父 div。仅 filter=interactive 启用,避免 default 模式被噪音 div 污染。
        const STICKY_BAR_CTA_REGEX = /gouwuche|jiaRu|jiarugouwuche|addtoCart|addToCart/i;
        const knownInteractive = new Set<Element>([...Array.from(interactiveSet), ...cursorPointerLeaves]);
        const iconCtaExtras: Element[] = [];
        if (filter === "interactive") {
          for (const el of Array.from(fallbackPool)) {
            const isCtaDiv = el.tagName === "DIV" && el !== docRoot && el !== docBody;
            if (!isCtaDiv) continue;
            if (knownInteractive.has(el)) continue;
            const htmlEl = el as HTMLElement;
            if (htmlEl.offsetWidth === 0 || htmlEl.offsetHeight === 0) continue;
            if (el.querySelector(INTERACTIVE_SELECTORS)) continue;
            const iconChild = el.querySelector("i[class]");
            if (!iconChild) continue;
            if (!STICKY_BAR_CTA_REGEX.test(iconChild.getAttribute("class") || "")) continue;
            // 祖先链已入池 → 跳过避免与祖先/兄弟双现
            let anc: Element | null = el.parentElement, hasIntAnc = false;
            while (anc && anc !== docBody) { if (knownInteractive.has(anc)) { hasIntAnc = true; break; } anc = anc.parentElement; }
            if (hasIntAnc) continue;
            iconCtaExtras.push(el);
            knownInteractive.add(el);
          }
        }

        const allCandidates: Element[] = [
          ...Array.from(nodeList),
          ...cursorPointerLeaves,
          ...iconCtaExtras,
        ];

        const elements: Array<{
          index: number;
          tag: string;
          role: string;
          name: string;
          bbox: { x: number; y: number; w: number; h: number };
          visible: boolean;
          inViewport: boolean;
          occludedBy?: string;
          attrs: Record<string, string>;
          state?: { checked?: boolean; selected?: boolean; active?: boolean; disabled?: boolean; expanded?: boolean; required?: boolean; current?: boolean; invalid?: boolean; sort?: "ascending" | "descending" | "none"; haspopup?: string };
          /** 值域控件当前值,如 "30" 或 "30/100"(getValueInfo 严格限定值域控件)。 */
          valueNow?: string;
          /** 最近的已收集祖先的 frame-local index；根节点 undefined。@since a11y-tree */
          parentIndex?: number;
          /** role=link 的 href，供 compact 树渲染 /url。@since a11y-tree */
          href?: string;
          _sel: string;
        }> = [];
        // a11y-tree: 与 elements 下标对齐的 DOM 元素引用数组，供二次遍历建树。
        const collectedEls: Element[] = [];

        for (const el of allCandidates) {
          if (elements.length >= max) break;
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          // inert 子树:`inert` 属性(及其继承)让整个子树非交互——浏览器禁止
          // 点击/聚焦,并从无障碍树移除。典型用于模态背景、关闭态抽屉、loading
          // 遮罩。inert 不影响 checkVisibility(返 true)也不是 :disabled,故上面
          // 两道门都漏掉 → 不可交互元素被误报。closest("[inert]") 是可靠信号
          // (无 :inert 伪类可用),命中即整体跳过(2026-06-02 dogfood)。
          if (typeof htmlEl.closest === "function" && htmlEl.closest("[inert]")) {
            continue;
          }

          // Skip elements hidden via CSS `visibility` (inherited from
          // any ancestor). These keep layout space and a nonzero rect
          // but are not user-interactable: clicks fall through and the
          // accessible-name pipeline can only reach className garbage
          // since innerText respects visibility. Discovered against
          // notion.com/help (2026-05-20) where a hover-only mega menu
          // leaked 16 `navItem_navItem_` (CSS-module class) candidates.
          const computedStyle = getComputedStyle(htmlEl);
          if (
            computedStyle.visibility === "hidden" ||
            computedStyle.visibility === "collapse"
          ) {
            continue;
          }

          // 原生 checkbox/radio surrogate 去重:组件库(Element Plus/Ant Design
          // 等)把真 <input> 包进可点的 <label> 并 visually-hidden(opacity:0),
          // 由 label:has(input[type=checkbox/radio]) 表述外层 label。此处挡掉
          // 这两种 surrogate——(1) 有包裹 <label> 祖先的(label 已收,收 input 会
          // 双现);(2) opacity:0 的自绘 surrogate——只放行裸露的真 input
          // (兄弟式 <label for> / 纯 aria-label / 无 label),修 AB 隐形 bug 而
          // 不回归组件库单现(2026-06-02 dogfood AB)。
          if (htmlEl.tagName === "INPUT") {
            const inputType = (htmlEl as HTMLInputElement).type;
            if (inputType === "checkbox" || inputType === "radio") {
              // opacity:0 自绘 surrogate(Ant Design inset:0 opacity:0 非 0 rect):
              // 真 input 透明、可见控件是别的元素,跳过避免收进不可见的 input。
              if (parseFloat(computedStyle.opacity) === 0) {
                continue;
              }
              // 有包裹 <label> 且该 label 自身可被收(非零尺寸)→ 控件由
              // label:has(input[...]) 经外层 label 表述,跳过 input 避免双现。
              // 但 display:contents 等零尺寸 label 会被上面的 rect 门丢弃,此时
              // 不能跳——否则 input 和 label 双双消失、整控件隐形(评审 Finding 1)。
              // 零尺寸 label 时保留 input,由 input 直接代表控件。
              const wrapLabel =
                typeof htmlEl.closest === "function"
                  ? htmlEl.closest("label")
                  : null;
              if (wrapLabel) {
                const lr = wrapLabel.getBoundingClientRect();
                if (lr.width > 0 && lr.height > 0) continue;
              }
            }
          }

          // content-visibility:hidden 盲区:关闭态 <details> 的内部内容(及手动
          // content-visibility:hidden 的折叠区)保留非 0 layout rect、自身
          // getComputedStyle 的 visibility/content-visibility 仍报 "visible"
          // (隐藏施加在 ::details-content 伪元素上,子元素查不到),故上面的
          // visibility 门和下方 elementFromPoint 遮挡判定都漏掉它,导致不可达的
          // 隐藏控件被误报为可交互(2026-06-02 dogfood)。checkVisibility() 默认
          // (所有选项 false)对 content-visibility:hidden 链返回 false,而对
          // content-visibility:auto 的离屏可达内容(滚动即渲染,R1)仍返回 true,
          // 对可见 <summary> 也返回 true——正好只挡 cv:hidden,不误伤可达元素。
          if (
            typeof htmlEl.checkVisibility === "function" &&
            !htmlEl.checkVisibility()
          ) {
            continue;
          }

          const inViewport =
            rect.top < window.innerHeight &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.right > 0;
          // 缺陷② (2026-06-07 v4 淘宝评测): visually-hidden actionable 豁免。
          // CSS a11y-hidden 模式 (position:absolute|fixed + left/right 巨大值)
          // 不应被默认 viewport 过滤静默丢弃 — 这是 GitHub/MDN/Ant Design/淘宝
          // 等"用 CSS 离屏但保留可交互"站点的族级问题 (淘宝 15 个细颗粒度
          // 评分 label 案例)。元素保留, 加 offScreenActionable 标记, agent 可
          // 区分 on-screen / off-screen-but-actionable。评审校正: 放弃
          // checkVisibility 替代方案 — checkVisibility 不判位置, 对
          // left:-9999px 返 true (源码 1300-1305 checkVisibility 门专挡
          // content-visibility:hidden, 不判位置)。
          const cs = getComputedStyle(htmlEl);
          const pos = cs.position;
          const csLeft = parseFloat(cs.left);
          const csRight = parseFloat(cs.right);
          const farNeg = -1000;
          const farPos = window.innerWidth + 1000;
          const visuallyHiddenActionable =
            (pos === "absolute" || pos === "fixed") &&
            ((Number.isFinite(csLeft) && csLeft < farNeg) ||
              (Number.isFinite(csRight) && csRight < farNeg) ||
              (Number.isFinite(csLeft) && csLeft > farPos) ||
              (Number.isFinite(csRight) && csRight > farPos));
          if (
            mode === "visible" &&
            !inViewport &&
            !visuallyHiddenActionable
          )
            continue;

          let visible = true;
          let occludedBy: string | undefined;
          if (inViewport) {
            const cx = Math.max(
              0,
              Math.min(window.innerWidth - 1, rect.left + rect.width / 2),
            );
            const cy = Math.max(
              0,
              Math.min(window.innerHeight - 1, rect.top + rect.height / 2),
            );
            const topEl = deepElementFromPoint(cx, cy);
            // 复合输入控件(Element Plus el-select 等)把可见显示层作为兄弟节点叠在
            // 透明真控件之上。hit-test 命中显示层兄弟时,若它非交互且与 htmlEl 同处
            // 一个交互 widget 容器(htmlEl 最近交互祖先 contains hit),是同 widget
            // 装饰层而非真遮挡,不应把真控件标记为不可见。与 actionability/cdp/dom
            // 的 carve-out 同源(2026-06-01 el-select dogfood)。
            let sameWidgetDecoration = false;
            if (topEl && !isInteractiveEl(topEl)) {
              let w: Element | null = htmlEl.parentElement;
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
              topEl !== htmlEl &&
              !htmlEl.contains(topEl) &&
              !topEl.contains(htmlEl) &&
              !sameWidgetDecoration
            ) {
              visible = false;
              occludedBy = describeElement(topEl);
            }
          }

          const attrs: Record<string, string> = {};
          for (const attrName of COLLECTED_ATTRS) {
            const v = htmlEl.getAttribute(attrName);
            if (v) attrs[attrName] = v.slice(0, 160);
          }

          const role = withAX ? getRole(htmlEl) : htmlEl.tagName.toLowerCase();
          const name = withText ? getAccessibleName(htmlEl) : "";

          // 内容卡内「无文本 icon-link 子」(京东客服 16x16 ×60)是冗余噪声,且占
          // maxElements 预算挤掉商品卡。formLike(<a href>)绕过下方 BUG-3 的 !name
          // 过滤,置空名仍占输出 slot → 必须显式 continue 丢弃,而非置空名。
          if (filter === "interactive" && /^icon-link @/.test(name)) {
            let inCard = false;
            for (let p = htmlEl.parentElement; p; p = p.parentElement) {
              if (isSelfClickable(p)) { inCard = true; break; }
            }
            if (inCard) continue;
          }

          // BUG-3: in filter='interactive' mode, drop wrappers that the
          // selector caught structurally but carry no semantic info —
          // typically Element Plus el-popover__reference triggers
          // (`<div tabindex="0">` with no role / aria-label / text). On
          // bytenew testc this produced 3 phantom `[div]` entries on the
          // main frame that LLMs could not interpret.
          if (filter === "interactive") {
            const tag = htmlEl.tagName.toLowerCase();
            // `a` only counts as form-like when it has href — the
            // INTERACTIVE_SELECTORS whitelist also requires `a[href]`,
            // so a bare nameless <a> from the cursor:pointer fallback
            // shouldn't bypass the noise filter (review feedback on PR #19).
            // 缺陷① (2026-06-07 v4 淘宝评测): <label> 包 radio/checkbox 是
            // HTML labelable 元素的语义容器 (LABEL 关联唯一可标控件), 不应
            // 被 BUG-3 当作"含交互后代的噪声容器"丢弃。结合 getAccessibleName
            // 的兜底名生成 (wrapsCheckRadio + labelText 空 → radio/checkbox=val
            // @x,y 兜底名), LABEL 应保留在 observe 输出中, 淘宝 emoji 评分、
            // Element Plus 纯图标单选组、Ant Design 自定义单选组等同病通用。
            const wrapsFormControl =
              tag === "label" &&
              htmlEl.querySelector(
                "input[type=checkbox], input[type=radio]",
              ) != null;
            const formLike =
              tag === "input" ||
              tag === "select" ||
              tag === "textarea" ||
              tag === "button" ||
              (tag === "a" && htmlEl.hasAttribute("href")) ||
              wrapsFormControl;
            const hasExplicitRole =
              !!htmlEl.getAttribute("role") ||
              !!htmlEl.getAttribute("aria-label");
            if (!formLike && !hasExplicitRole && !name) continue;
          }

          // 这里的 index 是 frame 内局部 id，observer handler 侧重编全局 index
          const state = getUiState(htmlEl);
          const valueNow = getValueInfo(htmlEl, role);
          // V2 P0 修复 D9: applyReactClickableMarker 逻辑内联进 page-side
          // inject func (避免 background scope 模块级函数 ReferenceError)。
          // 原 export function applyReactClickableMarker() 保留 (供 V1 BUG-010
          // bench case + 单元测试仍可单测), 仅 page-side 路径不再依赖
          // background-scope 函数序列化 (它本来就不在序列化范围内)。
          // 等价函数体 inline (变量名沿用) + REACT_CLICKABLE_HINT 内联:
          const __vtxReactHint = "react onClick or cursor:pointer detected; vortex_act click may not trigger (isTrusted=false). Use vortex_mouse_drag(realMouse) or vortex_act click with useRealMouse=true to bypass.";
          let reactMarker = null;
          {
            const __hasOnClickProp = htmlEl.onclick != null;
            const __hasOnClickAttr = htmlEl.getAttribute("onclick") != null;
            const __isPointer = getComputedStyle(htmlEl).cursor === "pointer";
            if (__hasOnClickProp || __hasOnClickAttr || __isPointer) {
              htmlEl.dataset.vortexReactClickable = "1";
              reactMarker = { reactClickable: true, clickHint: __vtxReactHint };
            }
          }
          // a11y-tree: 记引用，下标严格与 elements 对齐（此处是循环内最后一个
          // 可能 continue 之后、elements.push 之前的唯一 push 点）。
          collectedEls.push(htmlEl);
          const __href = role === "link" ? (htmlEl.getAttribute("href") || undefined) : undefined;
          // T5: date/time/file/range/number input 注入 compound 元数据,供 LLM fill 参考格式/约束
          const __inputCompound = buildInputCompound(htmlEl);
          elements.push({
            index: elements.length,
            tag: htmlEl.tagName.toLowerCase(),
            role,
            name,
            bbox: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
            visible,
            inViewport,
            occludedBy,
            offScreenActionable: !inViewport && visuallyHiddenActionable,
            attrs,
            ...(state ? { state } : {}),
            ...(valueNow !== undefined ? { valueNow } : {}),
            ...(reactMarker
              ? { reactClickable: true as const, clickHint: reactMarker.clickHint }
              : {}),
            // T3 discovery: pre-scan CDP getEventListeners 标记的纯 addEventListener
            // 元素带 data-vtx-listener → 渲染 [listener] 真值信号(此处属性尚存,清理在后)。
            ...(htmlEl.hasAttribute("data-vtx-listener") ? { listenerInteractive: true as const } : {}),
            ...(__href !== undefined ? { href: __href } : {}),
            ...(__inputCompound !== undefined ? { compound: __inputCompound } : {}),
            _sel: buildSelector(htmlEl),
          });
        }

        // a11y-tree: 为每个收集元素算最近的已收集祖先（穿 shadow host）→ frame-local parentIndex。
        // 中间未收集节点折叠，得紧凑 containment 树。collectedEls 下标对齐 elements。
        // 注意:本段算法须与 tests/observe-parent-index-page-side.test.ts 的
        // COMPUTE_PARENT_INDEX 保持同步(真源+内联副本,改一处须改另一处)。
        {
          const __set = new Set(collectedEls);
          for (let i = 0; i < collectedEls.length; i++) {
            let cur =
              collectedEls[i].parentElement ||
              (collectedEls[i].getRootNode() && collectedEls[i].getRootNode().host) ||
              null;
            while (cur) {
              if (__set.has(cur)) {
                elements[i].parentIndex = collectedEls.indexOf(cur);
                break;
              }
              cur =
                cur.parentElement ||
                (cur.getRootNode() && cur.getRootNode().host) ||
                null;
            }
          }
        }

        // AX-overlay: 给每个收集元素打 frame-local 下标标记,供扩展侧 DOM.getDocument
        // 关联到 backendDOMNodeId。与 observe-ax-overlay.ts STAMP_MARKERS 同语义(内联副本)。
        for (let i = 0; i < collectedEls.length; i++) {
          collectedEls[i].setAttribute("data-vtx-ax", String(i));
        }

        return {
          url: location.href,
          title: document.title,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            scrollY: window.scrollY,
            scrollHeight: document.documentElement.scrollHeight,
          },
          elements,
          candidateCount: allCandidates.length,
          truncated: elements.length >= max,
        };
      },
      args: [maxElements, viewport, includeText, includeAX, filterMode],
      world: "MAIN",
    });
    return (results[0]?.result as FramePageResult | undefined) ?? null;
  } catch (err) {
    // 跨源 iframe 无权限 / frame 已销毁：不 throw，返回 null 让上层标记为未扫
    console.warn(`[vortex.scanOneFrame] failed fid=${frameId} err=`, err);
    return null;
  }
}

export function registerObserveHandlers(router: ActionRouter, debuggerMgr: DebuggerManager): void {
  // debuggerMgr 用于 AX overlay pass + JS listener 信号（T3）
  router.registerAll({
    [ObserveActions.SNAPSHOT]: async (args, tabId) => {
      gcSnapshots();
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      const explicitFrameId = args.frameId as number | undefined;
      if (explicitFrameId != null) await ensureFrameAttached(tid, explicitFrameId);
      const framesParamProvided = args.frames !== undefined;
      const framesParam = (args.frames as FramesParam | undefined) ?? "main";
      const maxElements = (args.maxElements as number | undefined) ?? 80;
      const viewport =
        (args.viewport as "visible" | "full" | undefined) ?? "visible";
      const includeText = (args.includeText as boolean | undefined) ?? true;
      const includeAX = (args.includeAX as boolean | undefined) ?? true;
      const format = (args.format as "compact" | "full" | undefined) ?? "full";
      // BUG-2: filter was a dead parameter — public schema exposed
      // ['interactive','all'] but the handler never read it. 'all' now
      // also collects table rows / cells / column headers.
      const filterMode =
        (args.filter as "interactive" | "all" | undefined) ?? "interactive";
      // Issue #21 — caller opts into per-element bbox emission. Default
      // false keeps wire format byte-identical to v0.8 sub-project A for
      // existing callers. Only consulted by the compact path; detail=full
      // already emits the full object bbox unconditionally.
      //
      // Strict `=== true` mirrors server.ts:348 so both layers reject
      // non-boolean values (e.g. `"true"`, `1`, `{}`) identically. The
      // schema declares `type: "boolean"` but the router does no runtime
      // validation; without strict equality the JSON payload could carry
      // bbox while the compact-text renderer didn't (or vice versa),
      // creating a silent cross-layer inconsistency.
      const includeBoxes = args.includeBoxes === true;

      const frameTargets = await resolveTargetFrames(tid, explicitFrameId, framesParam);
      if (frameTargets.length === 0) {
        throw vtxError(
          VtxErrorCode.IFRAME_NOT_READY,
          "No target frames resolved (tab may be uninitialized)",
          { tabId: tid, frameId: explicitFrameId },
        );
      }

      // 跨 frame：每个 frame 独立扫描；offset 用 getIframeOffset 算一次
      const scans: Array<{
        frameId: number;
        url: string;
        parentFrameId: number;
        offset: { x: number; y: number };
        page: FramePageResult | null;
      }> = [];
      // T3 discovery(pre-scan):CDP getEventListeners 给主 frame 内纯 addEventListener
      // 点击元素打 data-vtx-listener,随后 scanOneFrame 把它当入池信号 → DISCOVER 漏网
      // vanilla/jQuery div(无 cursor:pointer/role/框架 prop)。召回零回退:失败标 0 个,
      // scan 退回现有启发式。属性在 scan 后随 data-vtx-ax 一并清理。
      try {
        await markListenerElements(debuggerMgr, tid);
      } catch {
        /* markListenerElements 内置兜底,理论不抛;防御性吞掉不阻断 observe */
      }
      for (const f of frameTargets) {
        const offset = await getIframeOffset(tid, f.frameId);
        const page = await scanOneFrame(
          tid,
          f.frameId,
          maxElements,
          viewport,
          includeText,
          includeAX,
          filterMode,
        );
        if (page === null) {
          console.warn(`[vortex.observe] scanOneFrame null fid=${f.frameId} url=${f.url}`);
        }
        scans.push({
          frameId: f.frameId,
          url: f.url,
          parentFrameId: f.parentFrameId,
          offset,
          page,
        });
      }

      // Auto-fallback for shell+iframe sites (Zentao/JIRA Cloud/phpMyAdmin):
      // when caller didn't pin `frames` and main frame returns near-empty
      // (typically 10-15 nav links), retry with all-permitted to surface
      // iframe content. Three gates prevent false positives: (1) caller
      // omitted `frames` arg (didn't ask for main only), (2) interactive
      // mode (default), (3) child iframes exist on page.
      let autoFallback = false;
      if (
        !framesParamProvided &&
        explicitFrameId == null &&
        filterMode === "interactive"
      ) {
        const mainScan = scans.find((s) => s.frameId === 0);
        // 仅当 main scan 成功（page !== null）才考虑 fallback。main 扫描失败
        // （跨域权限拒绝 / frame 已销毁 / page-side 异常）应保留为顶层错误，
        // 而非通过 child fallback 静默掩盖（reflexion 反馈：page=null 时
        // page?.elements.length 走 ?? 0 误触发 fallback）。
        const mainScannedOk = mainScan?.page != null;
        const mainElementCount = mainScannedOk ? mainScan!.page!.elements.length : Number.POSITIVE_INFINITY;
        if (mainScannedOk && mainElementCount < FALLBACK_INTERACTIVE_THRESHOLD) {
          // 复用一次 chrome.webNavigation.getAllFrames 调用同时做 child 检测和
          // all-permitted 过滤，避免 resolveTargetFrames 内部再次拉取（review 反馈）
          const allFrames = (await chrome.webNavigation.getAllFrames({ tabId: tid })) ?? [];
          const hasChildFrames = allFrames.some((f) => f.frameId !== 0);
          if (hasChildFrames) {
            // 同源 srcdoc(about:srcdoc)的 url 非 http,isFrameInPermissions 会拒掉。
            // 补一条 inherited same-origin 通道,让 auto-fallback 与 all-same-origin
            // 模式一致地纳入 srcdoc 子框(judge iframe-srcdoc-inherit fixture 暴露:
            // 主框近空触发 fallback 时,srcdoc 内的子按钮被静默丢弃 → observe 漏报)。
            const byId = new Map(allFrames.map((f) => [f.frameId, f]));
            const mainOrigin = safeOrigin(allFrames.find((f) => f.frameId === 0)?.url);
            const newTargets = allFrames
              .filter((f) => {
                if (f.frameId === 0) return false;
                if (isFrameInPermissions(f.url)) return true;
                // 仅对 srcdoc 子框走 inherited same-origin 兜底:about:srcdoc 自身 url
                // 无法匹配 host_permissions,但继承父文档源且与父同 tree(注入权限随父)。
                // 按 url 精确限定为 about:srcdoc,排除同为 opaque-origin 的 about:blank /
                // data: 子框(它们不继承父源,不应被同源放宽)。独立 http 子框仍以
                // host_permissions 为准。注:sandbox srcdoc(无 allow-same-origin)url 同为
                // about:srcdoc 但运行时为 unique origin,会被纳入并在注入时失败兜底(非泄露)。
                if (f.url !== "about:srcdoc") return false;
                return mainOrigin != null && inheritedOrigin(f, byId) === mainOrigin;
              })
              .filter((f) => !scans.some((s) => s.frameId === f.frameId))
              .map((f) => ({
                frameId: f.frameId,
                url: f.url,
                parentFrameId: f.parentFrameId ?? 0,
              }));
            if (newTargets.length > 0) {
              autoFallback = true;
              for (const f of newTargets) {
                const offset = await getIframeOffset(tid, f.frameId);
                const page = await scanOneFrame(
                  tid,
                  f.frameId,
                  maxElements,
                  viewport,
                  includeText,
                  includeAX,
                  filterMode,
                );
                if (page === null) {
                  console.warn(
                    `[vortex.observe] auto-fallback scanOneFrame null fid=${f.frameId} url=${f.url}`,
                  );
                }
                scans.push({
                  frameId: f.frameId,
                  url: f.url,
                  parentFrameId: f.parentFrameId,
                  offset,
                  page,
                });
              }
            }
          }
        }
      }

      // AX 语义覆盖层(v1 仅主 frame frameId 0):采 AX tree + DOM.getDocument 关联 →
      // 原地覆盖 role/name/state/value/关系。任一步失败该 frame 优雅回退纯启发式(不报错)。
      if (includeAX) {
        const mainScan = scans.find((s) => s.frameId === 0);
        if (mainScan?.page && mainScan.page.elements.length > 0) {
          try {
            const { byBackend, byNodeId } = await captureAXNodeMap(debuggerMgr, tid, 0);
            const doc = (await debuggerMgr.sendCommand(tid, "DOM.getDocument", {
              depth: -1,
              pierce: true,
            })) as { root?: unknown };
            if (doc?.root) {
              const indexToBackend = buildIndexToBackend(doc.root as never);
              applyOverlay(
                mainScan.page.elements as unknown as OverlayableElement[],
                indexToBackend,
                byBackend,
                byNodeId,
              );
            }
          } catch (err) {
            console.warn(
              `[vortex.observe] AX overlay skipped fid=0: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      // 注:JS 监听器真值信号已迁移到 pre-scan discovery(markListenerElements,
      // 见上方 frame 循环前)——listenerInteractive 在 scan 输出构造时由
      // data-vtx-listener 属性直接生成,不再需要事后 CDP pass。

      // marker 清理(无条件):data-vtx-ax(scan stamping)+ data-vtx-listener
      // (pre-scan discovery)。两者无条件打,故清理也须无条件,防标记残留。清理失败不致命。
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tid, allFrames: true },
          func: () => {
            for (const el of document.querySelectorAll("[data-vtx-ax]")) el.removeAttribute("data-vtx-ax");
            for (const el of document.querySelectorAll("[data-vtx-listener]"))
              el.removeAttribute("data-vtx-listener");
          },
        });
      } catch {
        /* 标记仅 observe 内部用,下轮 scan 覆盖 */
      }

      // password 防护:type=password 的 valueNow 剥除,防敏感值泄露进下一个 prompt。
      for (const s of scans) {
        for (const e of s.page?.elements ?? []) {
          if ((e.attrs?.type ?? "").toLowerCase() === "password") e.valueNow = undefined;
        }
      }

      // 分配跨 frame 全局 index（按 frameTargets 顺序）
      // 每个元素附加 suggestedUsage：给 LLM 直接可用的下一步命令，避免再自行推断应传 frameId。
      type CompactElementOut = {
        index: number;
        tag: string;
        role: string;
        name: string;
        state?: { checked?: boolean | "mixed"; selected?: boolean; active?: boolean; disabled?: boolean; expanded?: boolean; required?: boolean; current?: boolean; invalid?: boolean; sort?: "ascending" | "descending" | "none"; haspopup?: string; readonly?: boolean };
        /** 值域控件当前值,如 "30" 或 "30/100"(getValueInfo 严格限定值域控件)。 */
        valueNow?: string;
        /** BUG-010 N0060 京东评测: onClick 桩 / cursor:pointer 命中 (compact 也透传) */
        reactClickable?: true;
        clickHint?: string;
        /** CDP getEventListeners 真值信号，透传渲染层。@since T3 */
        listenerInteractive?: true;
        frameId: number;
        // Issue #21 — populated only when input.includeBoxes && e.inViewport (T4).
        bbox?: [number, number, number, number];
        parentIndex?: number;
        href?: string;
        offScreenActionable?: boolean;
        nameSource?: string;
        controls?: number[];
        owns?: number[];
        errorMessage?: string;
        description?: string;
        compound?: {
          role: string;
          count?: number;
          options?: string[];
          formatHint?: string;
          min?: string;
          max?: string;
          step?: string;
        };
      };
      type FullElementOut = Omit<ScannedElement, "_sel"> & {
        frameId: number;
        ref: string;
        suggestedUsage: { act: string; mouseClick: string };
      };
      const elementsOut: Array<CompactElementOut | FullElementOut> = [];
      const elementMap: SnapshotElement[] = [];
      let cursor = 0;
      let totalCandidates = 0;
      let anyTruncated = false;
      const framesOut: Array<{
        frameId: number;
        parentFrameId: number;
        url: string;
        offset: { x: number; y: number };
        elementCount: number;
        truncated: boolean;
        /** null 表示跨源 / 销毁导致无法扫描 */
        scanned: boolean;
      }> = [];

      for (const s of scans) {
        if (!s.page) {
          framesOut.push({
            frameId: s.frameId,
            parentFrameId: s.parentFrameId,
            url: s.url,
            offset: s.offset,
            elementCount: 0,
            truncated: false,
            scanned: false,
          });
          continue;
        }
        totalCandidates += s.page.candidateCount;
        anyTruncated = anyTruncated || s.page.truncated;
        // a11y-tree: 该 frame 首元素的全局 index，用于把 frame-local parentIndex 重映射成全局 index。
        const frameBase = cursor;
        for (const e of s.page.elements) {
          const globalIdx = cursor++;
          // a11y-tree: frame-local parentIndex → global parentIndex（globalParent = frameBase + localParent）。
          const globalParentIndex =
            e.parentIndex !== undefined ? frameBase + e.parentIndex : undefined;
          const centerX = e.bbox.x + Math.round(e.bbox.w / 2);
          const centerY = e.bbox.y + Math.round(e.bbox.h / 2);
          if (format === "compact") {
            // Issue #21 — emit bbox tuple in compact path only when
            // (1) caller asked, (2) element intersects frame viewport,
            // (3) rect has positive area. Page-side scan already
            // discards 0-area rects (observe.ts:608) and rounds
            // coordinates (observe.ts:680-685), but rounding again
            // here defends against test fixtures that mock e.bbox
            // with floats and keeps the contract self-evident.
            const bboxTuple: [number, number, number, number] | undefined =
              includeBoxes &&
              e.inViewport &&
              e.bbox.w > 0 &&
              e.bbox.h > 0
                ? [
                    Math.round(e.bbox.x),
                    Math.round(e.bbox.y),
                    Math.round(e.bbox.w),
                    Math.round(e.bbox.h),
                  ]
                : undefined;
            elementsOut.push({
              index: globalIdx,
              tag: e.tag,
              role: e.role,
              name: e.name,
              ...(e.state ? { state: e.state } : {}),
              ...(e.valueNow !== undefined ? { valueNow: e.valueNow } : {}),
              // 缺陷② (2026-06-07 v4 淘宝评测): compact 模式也透传
              // offScreenActionable 标记, agent 用 compact 也能识别离屏可交互。
              offScreenActionable: e.offScreenActionable,
              // BUG-010 N0060 京东评测: compact 模式也透传 reactClickable + clickHint,
              // 评测者读 clickHint 即可知用 vortex_mouse_drag / useRealMouse=true。
              ...(e.reactClickable
                ? { reactClickable: true as const, clickHint: e.clickHint! }
                : {}),
              // T3: CDP getEventListeners 真值信号透传渲染层（并集增强）。
              ...(e.listenerInteractive ? { listenerInteractive: true as const } : {}),
              // a11y-tree: 全局重映射后的父指针 + href（link 元素）。
              ...(globalParentIndex !== undefined ? { parentIndex: globalParentIndex } : {}),
              ...(e.href ? { href: e.href } : {}),
              ...(e.nameSource ? { nameSource: e.nameSource } : {}),
              ...(e.controls ? { controls: e.controls } : {}),
              ...(e.owns ? { owns: e.owns } : {}),
              ...(e.errorMessage ? { errorMessage: e.errorMessage } : {}),
              ...(e.description ? { description: e.description } : {}),
              ...(e.compound ? { compound: e.compound } : {}),
              frameId: s.frameId,
              ...(bboxTuple ? { bbox: bboxTuple } : {}),
            });
          } else {
            // v0.6 full 结构：携带 ref 字符串（@eN / @fNeM）+ suggestedUsage 直接给
            // v0.6 工具门面命令。v0.5 风格 hint（vortex_dom_click / vortex_mouse_click）
            // 已下线，旧 hint 会让 LLM 错猜 "snap_xxx#N" 形态触发 page-side 的
            // querySelector SyntaxError → null.ok JS_EXECUTION_ERROR。
            const ref = s.frameId === 0 ? `@e${globalIdx}` : `@f${s.frameId}e${globalIdx}`;
            elementsOut.push({
              index: globalIdx,
              tag: e.tag,
              role: e.role,
              name: e.name,
              bbox: e.bbox,
              visible: e.visible,
              inViewport: e.inViewport,
              occludedBy: e.occludedBy,
              // 缺陷② (2026-06-07 v4 淘宝评测): 透传 offScreenActionable
              // 标记, agent 可区分 on-screen / off-screen-but-actionable
              // 两类。page-side 已生成 (observe.ts:1443), 此处补 push。
              offScreenActionable: e.offScreenActionable,
              attrs: e.attrs,
              ...(e.state ? { state: e.state } : {}),
              ...(e.valueNow !== undefined ? { valueNow: e.valueNow } : {}),
              // BUG-010 N0060 京东评测: 透传 reactClickable + clickHint,
              // 评测者读 clickHint 知该 ref 需用 vortex_mouse_drag / useRealMouse=true。
              ...(e.reactClickable
                ? { reactClickable: true as const, clickHint: e.clickHint! }
                : {}),
              // T3: CDP getEventListeners 真值信号透传渲染层（并集增强）。
              ...(e.listenerInteractive ? { listenerInteractive: true as const } : {}),
              // a11y-tree: 全局重映射后的父指针 + href（link 元素）。
              ...(globalParentIndex !== undefined ? { parentIndex: globalParentIndex } : {}),
              ...(e.href ? { href: e.href } : {}),
              ...(e.nameSource ? { nameSource: e.nameSource } : {}),
              ...(e.controls ? { controls: e.controls } : {}),
              ...(e.owns ? { owns: e.owns } : {}),
              ...(e.errorMessage ? { errorMessage: e.errorMessage } : {}),
              ...(e.description ? { description: e.description } : {}),
              ...(e.compound ? { compound: e.compound } : {}),
              frameId: s.frameId,
              ref,
              suggestedUsage: {
                // 首选：act 门面 + ref（最稳，不怕选择器变化）
                act: `vortex_act({ target: "${ref}", action: "click" })`,
                // 需要真实鼠标事件时：frame-local 坐标 + frameId（mouse 不在 v0.6 11
                // 工具门面里，但 server 内部 action 仍叫 mouse.click —— 留作 escape hatch）
                mouseClick: `mouse.click({ x: ${centerX}, y: ${centerY}, frameId: ${s.frameId} })`,
              },
            });
          }
          elementMap.push({
            index: globalIdx,
            selector: e._sel,
            frameId: s.frameId,
          });
        }
        framesOut.push({
          frameId: s.frameId,
          parentFrameId: s.parentFrameId,
          url: s.page.url,
          offset: s.offset,
          elementCount: s.page.elements.length,
          truncated: s.page.truncated,
          scanned: true,
        });
      }

      const snapshotId = newSnapshotId();
      // entry.frameId：单 frame 时保留向后兼容 hint；多 frame 时不填（路由走 element.frameId）
      const isSingleFrame = framesOut.length === 1;
      setSnapshot(snapshotId, {
        tabId: tid,
        frameId: isSingleFrame ? framesOut[0].frameId : undefined,
        capturedAt: Date.now(),
        elements: elementMap,
      });

      // Top-level url/title/viewport ALWAYS reflect the main frame, even
      // when its page-side scan failed. Issue #15-2: previously the
      // fallback `scans.find((s) => s.page)` would promote the first
      // scanned child frame (e.g. a cross-origin iframe) to "primary",
      // making the LLM see the iframe origin as if it were the whole
      // page. URL has two sources: the page-side `location.href` (when
      // scan succeeded — preserves any client-side route changes) and
      // chrome.webNavigation's reported URL (always available, even
      // when scan failed). Title/viewport require a successful scan;
      // fall back to empty / zeros so the renderer can still emit a
      // header without misrepresenting which origin we're on.
      const mainScan = scans.find((s) => s.frameId === 0);
      return {
        snapshotId,
        version: 2,
        url: mainScan?.page?.url ?? mainScan?.url ?? "",
        title: mainScan?.page?.title ?? "",
        viewport: mainScan?.page?.viewport ?? {
          width: 0,
          height: 0,
          scrollY: 0,
          scrollHeight: 0,
        },
        frames: framesOut,
        elements: elementsOut,
        meta: {
          capturedAt: Date.now(),
          candidateCount: totalCandidates,
          returnedCount: elementsOut.length,
          truncated: anyTruncated,
          frameCount: framesOut.length,
          scannedFrames: framesOut.filter((f) => f.scanned).length,
          ...(autoFallback ? { autoFallback: true as const } : {}),
        },
      };
    },
  });
}
