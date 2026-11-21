import { ObserveActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import { getActiveTabId, buildExecuteTarget, ensureFrameAttached } from "../lib/tab-utils.js";
import { getIframeOffset } from "../lib/iframe-offset.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";
import { raceTimeout, TIMED_OUT } from "../lib/race-timeout.js";
import {
  gcSnapshots,
  getSnapshotEntry,
  deleteSnapshot,
  newSnapshotId,
  setSnapshot,
  type SnapshotElement,
} from "../lib/snapshot-store.js";
import { resolveTarget } from "../lib/resolve-target.js";
import { captureAXNodeMap } from "../reasoning/ax-snapshot.js";
import { buildIndexToBackend, resolveFrameDocument, applyOverlay, type OverlayableElement } from "./observe-ax-overlay.js";
import { markListenerElements } from "./observe-js-listener.js";
import { updateListenerOwnership, type ListenerRequest } from "./observe-listener-ownership.js";
import { recoverDocumentOwnership } from "./observe-ownership-recovery.js";
import { updateScanOwnership, updatePageSnapshot, type ScanRequest } from "./observe-scan-ownership.js";

import {
  collectHoverRevealPairs,
  type HoverRevealPair,
} from "./observe-hover-reveal.js";
import {
  ARIA_ROLE_TAXONOMY,
  RECALL_ROLES,
  categoryOf,
  isContainerRole,
} from "../reasoning/aria-taxonomy.js";

const listenerEpoch = crypto.randomUUID();
let listenerOrder = 0;
const scanEpoch = crypto.randomUUID();
let scanOrder = 0;

/**
 * 仅供单测:复刻 inject 内联 getRole 真源(改一处须同步 inject 内联副本,
 * observe-role-gate.test.ts 锁守护)。@author qingwa
 */
export function getRoleForTest(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) {
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
    if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
    if (t === "range") return "slider";
    if (t === "number") return "spinbutton";
    return "textbox";
  }
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "iframe") {
    return el.hasAttribute("title") ? "region" : "iframe";
  }
  if (tag === "summary") return "button";
  // HTML-AAM 隐式映射(Task 3 新增)
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "aside") return "complementary";
  if (tag === "fieldset") return "group";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  // header/footer 仅当非 article/section/aside/main/nav 后代时为 banner/contentinfo
  if (tag === "header" && !el.closest("article,section,aside,main,nav")) return "banner";
  if (tag === "footer" && !el.closest("article,section,aside,main,nav")) return "contentinfo";
  // section 仅在有可及名称(aria-label/aria-labelledby)时为 region
  if (tag === "section" && (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"))) return "region";
  return tag;
}

/**
 * 仅供单测:复刻 inject 内联 passesRoleGate 真源(改一处须同步 inject 内联副本与
 * aria-taxonomy.ts RECALL_ROLES 真源,observe-role-gate.test.ts 锁守护)。
 * 真源 = reasoning/aria-taxonomy.ts RECALL_ROLES(getRoleForTest 出 role,过门判断)。
 * @author qingwa
 */
export function passesRoleGateForTest(el: Element): boolean {
  return RECALL_ROLES.has(getRoleForTest(el));
}

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
const PAGE_CAPTURE_LIMIT = 500;
const PAGE_TTL_MS = 60_000;
const observeGenerations = new Map<number, object>();
const observeQueues = new WeakMap<object, Map<number, Promise<void>>>();
const pageSnapshots = new Map<string, {
  tabId: number; frameId: number; request: ScanRequest; capturedAt: number; pageSize: number;
  result: { elements: unknown[]; meta: { returnedCount: number }; [key: string]: unknown };
}>();

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
  documentId?: string;
  documentLifecycle?: string;
  url: string;
  parentFrameId: number;
  ancestorFrameIds: number[];
}

interface AXRequest {
  scanToken?: string;
  frameId: number;
  ancestorFrameIds: number[];
  documentId: string;
  epoch: string;
  order: number;
  token: string;
  deadline: number;
}

// Each worker sequences its own epoch; cross-epoch recovery requires document CAS.
const axEpoch = crypto.randomUUID();
let axOrder = 0;

/** Serialized MAIN-world operation: no extension closures or asynchronous page work. */
function updateAXOwnership(action: "claim" | "check" | "retire", request: AXRequest, paginationToken: string | null = null): boolean {
  const doc = document as Document & {
    __vortexAXOwner?: Partial<AXRequest> & { epoch: string; highWater: number; owner: string | null; deadline: number; retired?: boolean; revision?: number };
    __vortexAXExitedEpochs?: Set<string>;
  };
  const old = doc.__vortexAXOwner;
  if (doc.__vortexAXExitedEpochs?.has(request.epoch) || (old && (old.epoch !== request.epoch ||
      (old.documentId !== undefined && old.documentId !== request.documentId) ||
      (old.frameId !== undefined && old.frameId !== request.frameId)))) return false;
  if (action === "check") {
    return !!old && old.highWater === request.order && old.owner === request.token &&
      old.deadline === request.deadline && Date.now() < old.deadline;
  }
  if (action === "claim") {
    if (Date.now() >= request.deadline || (old && request.order <= old.highWater)) return false;
    doc.__vortexAXOwner = { ...request, highWater: request.order, owner: request.token, deadline: request.deadline, retired: false, revision: (old?.revision ?? 0) + 1 };
    return true;
  }
  // Retire can arrive before claim, or after expiry. Never erase the high-water tombstone.
  if (!old || request.order > old.highWater || (request.order === old.highWater && old.owner === request.token)) {
    doc.__vortexAXOwner = { ...request, highWater: request.order, owner: null, deadline: request.deadline, retired: true, revision: (old?.revision ?? 0) + 1 };
  }
  const scan = (document as any).__vortexScanOwner;
  if (!scan || scan.owner !== request.scanToken || scan.documentId !== request.documentId ||
      scan.frameId !== request.frameId || scan.retired || Date.now() >= scan.deadline) return false;
  const item = paginationToken && (window as any).__vortexPageSnapshots?.[paginationToken];
  const cleanupDeadline = Date.now() + 200;
  const roots: Array<Document | ShadowRoot> = [document];
  while (roots.length) {
    for (const el of roots.pop()!.querySelectorAll("*") as NodeListOf<Element> & Iterable<Element>) {
      if (Date.now() >= cleanupDeadline || (doc as any).__vortexScanOwner !== scan || Date.now() >= scan.deadline) return false;
      if (el.shadowRoot) roots.push(el.shadowRoot);
      for (const name of ["data-vtx-ax", "data-vtx-frame-ax"]) {
        const value = el.getAttribute(name);
        if (name === "data-vtx-ax" ? value?.startsWith(`${request.token}:`) : value === request.token) {
          if ((doc as any).__vortexScanOwner !== scan || scan.owner !== request.scanToken || Date.now() >= scan.deadline) return false;
          if (item) item.marker(el, name, null, scan); else el.removeAttribute(name);
        }
      }
    }
  }
  return true;
}

interface ScannedElement {
  maskedContent?: boolean;
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
  /** 同快照内 role+name 重名时,能把本元素与同组区分开的祖先文本。@since dup-context */
  valueNow?: string;
  dupContext?: string;
  /** 值域控件最小值/最大值。@since N0002 B006 — agent 看到 slider "0" 不知范围, 加 min/max 字段。 */
  valueMin?: string;
  valueMax?: string;
  /** aria-keyshortcuts 显式声明的键盘快捷键(空格分隔), 渲染 [keyshortcuts=...] 标记。
   *  @since N0002 B010/B016 — 让 AT 用户知道 "⌘K" 触发的可访问名。 */
  keyshortcuts?: string;
  /** BUG-010 N0060 京东评测: el 含 onClick 桩 / cursor:pointer 时标 true,
   * 提示 LLM 评测者该 ref 走真实 mouse (vortex_mouse_drag 或 useRealMouse=true)
   * 兜底, 不要直接 el.click() (isTrusted=false 拦截)。 */
  reactClickable?: true;
  /** reactClickable=true 时给 LLM 的可读提示, 含具体兜底命令名。 */
  clickHint?: string;
  /** CDP getEventListeners 确认有 click/mousedown/pointerdown 监听器。
   * 高优先交互判定信号（优先级高于 cursor:pointer 启发），并集增强不删元素。@since T3 */
  listenerInteractive?: true;
  /** CDP getEventListeners 确认有 drop/dragenter/dragover 监听器 → 投放区,渲染 [dropzone]。
   * 入池信号(否则无 role/cursor 的 drop 区不可见),与 listenerInteractive 正交。@since dropzone-discovery */
  dropzoneInteractive?: true;
  /** 显式 draggable=true 拖拽源 → 渲染 [draggable](vortex_drag startRef 源)。[draggable=true]
   * 已在 INTERACTIVE_SELECTORS 白名单入池,此字段仅透传渲染标识,与 dropzoneInteractive 正交。@since draggable-source */
  draggableInteractive?: true;
  /** 最近的已收集祖先的 frame-local index；根节点 undefined。@since a11y-tree */
  parentIndex?: number;
  /** role=link 的 href，供 compact 树渲染 /url。@since a11y-tree */
  href?: string;
  /** 离屏但可交互(visually hidden actionable)标记。@since v0.7 */
  offScreenActionable?: boolean;
  /** AX nameSource：名称来源(label/placeholder/title/heuristic 等)。@since ax-overlay */
  nameSource?: string;
  semanticSource?: "ax" | "dom" | "heuristic";
  /** aria-controls / aria-owns 关联。@since B008: number[] 指向已收集元素下标。
   *  @since B009: 含 id 字符串 fallback — 当目标元素(region/tabpanel/listbox)非 interactive
   *  不在 collectedEls 时, 仍记 id 字符串, agent 至少看到关联 id 可 querySelector 找目标。
   *  type 改 Array<{id?: string; index?: number}> 保持 B008 ref + 加 id。 */
  controls?: Array<{ id?: string; index?: number }>;
  /** aria-owns 指向的 frame-local 元素下标列表。@since ax-overlay */
  owns?: Array<{ id?: string; index?: number }>;
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
  /** 盲区降级信号:虚拟列表/canvas/closed-shadow。@since blindspot */
  blindspot?: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low"; readback?: "component" | "screenshot" | "chart"; chartLib?: string };
  /** 模态弹层外的背景元素(filter=all 逃生口信号)。@since modal-scope */
  behindModal?: boolean;
  _sel: string;
}

interface FramePageResult {
  axIdentity?: AXRequest;
  axStamped?: boolean;
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
  monitorBudgetExceeded?: boolean;
  /** 虚拟列表 + 图表 canvas + 无 alt 图盲区(容器常不被 elements 收集,独立扫描)。@since blindspot */
  blindspots?: Array<
    | { kind: "virtual"; total: number; rendered: number; name: string; confidence?: "low" }
    | { kind: "canvas"; name: string; chartLib: string; readback: "chart" }
    | { kind: "image"; name: string; src: string }
    | { kind: "occlusion"; name: string }
  >;
  /** 模态作用域信号(aria-modal 弹层打开,裁剪了背景)。@since modal-scope */
  modal?: { name: string; role: string; suppressed: number };
  /** 空壳 SPA/渲染失败 frame 级信号。@since blank-shell */
  blankShell?: { root: string; rootLen: number; framework: string };
  /** scope 定位失败(找不到 / 命中多个 / 选择器非法):该帧没有有效结果,由上层报错。@since target-scope */
  scopeError?: { code: string; message: string };
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

function ancestorFrameIds(
  frame: chrome.webNavigation.GetAllFrameResultDetails,
  byId: Map<number, chrome.webNavigation.GetAllFrameResultDetails>,
): number[] {
  const ancestors: number[] = [];
  const seen = new Set([frame.frameId]);
  let parent: number | undefined = frame.parentFrameId;
  while (parent != null && parent >= 0 && !seen.has(parent)) {
    ancestors.push(parent);
    seen.add(parent);
    parent = byId.get(parent)?.parentFrameId;
  }
  return ancestors;
}

/** Exported for unit tests; production callers go through the snapshot handler. */
export async function resolveTargetFrames(
  tabId: number,
  explicitFrameId: number | undefined,
  framesParam: FramesParam,
): Promise<FrameTarget[]> {
  const all = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const allById = new Map(all.map((f) => [f.frameId, f]));
  const asTargets = (ff: chrome.webNavigation.GetAllFrameResultDetails[]): FrameTarget[] =>
    ff.map((f) => ({
      frameId: f.frameId,
      documentId: f.documentId,
      documentLifecycle: f.documentLifecycle,
      ancestorFrameIds: ancestorFrameIds(f, allById),
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
    // about:srcdoc 子框的 protocol 是 "about:" —— 按 raw url 判会被 isFrameInPermissions
    // 直接拒，但 srcdoc 据 HTML spec 恒继承父文档 origin(同源可注入)。改按继承源判权限,
    // 使 all-permitted 对 srcdoc 与 all-same-origin 一致(否则 TinyMCE 等把 contenteditable
    // 体放在 about:srcdoc iframe 的富文本编辑器,all-permitted 漏扫编辑器内容。Issue #15 同源
    // 逻辑此前只覆盖 all-same-origin。2026-06-22 tiny.cloud dogfood)。about:blank 不算
    // 「作者刻意内容」(常为空/广告/瞬态占位),保持排除以免噪声。
    const byId = new Map(all.map((f) => [f.frameId, f]));
    return asTargets(
      all.filter((f) => {
        if (isFrameInPermissions(f.url)) return true;
        if (f.url === "about:srcdoc") {
          const origin = inheritedOrigin(f, byId);
          return origin != null && isFrameInPermissions(origin);
        }
        return false;
      }),
    );
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
  ...Object.keys(ARIA_ROLE_TAXONOMY).filter(isContainerRole),
  "none", "presentation", // 装饰占位:同样不该触发短路
]);
export const ATOMIC_INTERACTIVE_SELECTORS =
  "button,a[href],summary,input:not([type=hidden]),select,textarea,label,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=treeitem],[role=option],[contenteditable],[onclick]";
// 信号二(portal overlay)「含交互后代」门专用:ATOMIC 基础上补 menuitemcheckbox/menuitemradio。
// Cascader/多选菜单弹层只含这两类 role(ATOMIC 漏),不补则弹层被判「无交互后代」装饰浮层而不前置。
// 仅用于 overlay 根判定,不改全局收集语义(blast radius 受守)。collectPortalOverlayRoots 默认值用它。
export const OVERLAY_DESCENDANT_SELECTORS =
  ATOMIC_INTERACTIVE_SELECTORS + ",[role=menuitemcheckbox],[role=menuitemradio]";
export function isFocusContainerOnly(el: Element): boolean {
  const role = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (role && FOCUS_CONTAINER_ROLES.has(role)) return true;
  return !el.matches(ATOMIC_INTERACTIVE_SELECTORS);
}

/**
 * 嵌套 cursor:pointer 择叶里「单一复合控件」否决判据(FullCalendar `<a.fc-event>` dogfood 根因)。
 *
 * isMultiCtaContainer 把「≥2 个有文本 cursor:pointer 子」的祖先当多 CTA 布局容器拆分
 * (drop 容器、保所有子,#42 班牛 createBox 三独立按钮)。但**原生交互元素**
 * (`<a>`/`<button>`/`<summary>` 或交互 role)是单一复合控件:其 cursor:pointer 子
 * (FullCalendar 事件的 `.fc-event-time` "4p" + `.fc-event-title` "Repeating Event")是
 * 视觉部件、非独立动作。误拆会让一个事件碎成两 ref、"4p" 成误导性局部。多 CTA 真容器
 * 恒为非交互布局层(div/span/li 无交互 role)。命中本判据 → 该祖先不可当多 CTA 容器拆分,
 * 保留祖先(其文本含各子文本)、drop 视觉部件子项。
 *
 * Why export:供 `observe-compound-control.test.ts` jsdom 直测真源;inject func 内联同语义
 * 副本(closure 注入无法 import),改一处须同步另一处,源码锁守护。
 */
/** 区分上下文的长度上限。日志行「13:22:01 ERROR order not found: SO-001」= 38 字,
 * 表格行「SO-20260811-001 苏菲官方旗舰店」= 24 字,60 足够且把最坏情况
 * (39 成员的重名组)的增量压在 ~2.3KB。 */
export const DUP_CTX_MAX_LEN = 60;

/** 祖先上下文文本的原始长度上限(挑中后还会按 DUP_CTX_MAX_LEN 再截)。 */
export const DUP_ANCESTOR_TEXT_MAX = 200;

/**
 * 取祖先的「身份文本」:剔除交互后代(它们的名字属于控件不属于行),并在元素边界补空格。
 *
 * 补空格是 live 实测出来的:直接 textContent 会把 `<td>SO-001</td><td>苏菲</td>` 拼成
 * "SO-001苏菲",日志行拼成 "13:22:01ERRORorder not found" —— agent 要拿这段去对用户的
 * 自然语言描述,粘连显著影响匹配(2026-08-11)。
 *
 * Why export:供 `observe-duplicate-context.test.ts` jsdom 直测真源;inject func 内联同语义
 * 副本,改一处须同步另一处,源码锁守护。
 */
export function ancestorContextText(anc: Element): string {
  let out = "";
  try {
    const clone = anc.cloneNode(true) as Element;
    for (const c of Array.from(
      clone.querySelectorAll("a[href],button,input,select,textarea,[role=button]"),
    )) c.remove();
    const parts: string[] = [];
    const walk = (n: Node): void => {
      const kids = n.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c.nodeType === 3) parts.push(c.nodeValue ?? "");
        else if (c.nodeType === 1) { parts.push(" "); walk(c); parts.push(" "); }
      }
    };
    walk(clone);
    out = parts.join("").replace(/\s+/g, " ").trim().slice(0, DUP_ANCESTOR_TEXT_MAX);
  } catch { out = ""; }
  return out;
}

/**
 * 从祖先文本链里挑一段能把本元素与同组重名成员区分开的上下文。
 *
 * 为什么不发序号:ref 已经唯一寻址了,序号不多给任何信息;agent 缺的是「该点哪一个」
 * 的**语义**。日志实测 731 个重名元素中 90.6% 沿父链找不到区分信息,因为能区分它们的
 * 行内容是非交互文本、被 filter=interactive 滤掉了(log.bytenew.com 三个
 * `button "复制此行"` 平铺顶层即典型)。
 *
 * @param mineChain  本元素由近及远的祖先文本(调用方逐跳提取)
 * @param otherChains 同组其他成员的同构文本链
 * @param ownName    本元素自身的名字,从上下文里剔除(否则「详情」这类只会回显自己)
 * @returns 首个「本组唯一且剔名后非空」的祖先文本;都不行返回 undefined(宁缺勿误导)
 *
 * Why export:供 `observe-duplicate-context.test.ts` 直测真源;inject func 内联同语义
 * 副本(closure 注入无法 import),改一处须同步另一处,源码锁守护。
 */
export function pickDistinguishingContext(
  mineChain: string[],
  otherChains: string[][],
  ownName: string,
): string | undefined {
  if (otherChains.length === 0) return undefined;
  const norm = (s: string): string => (s ?? "").replace(/\s+/g, " ").trim();
  const strip = (s: string): string =>
    ownName ? norm(norm(s).split(norm(ownName)).join(" ")) : norm(s);
  for (let hop = 0; hop < mineChain.length; hop++) {
    const mine = norm(mineChain[hop] ?? "");
    if (!mine) continue;
    // 同跳有任一成员文本相同 → 该跳区分不了
    if (otherChains.some((c) => norm(c[hop] ?? "") === mine)) continue;
    const ctx = strip(mine);
    if (!ctx) continue; // 剔掉自身名字后没剩下信息,再往上找
    return ctx.slice(0, DUP_CTX_MAX_LEN);
  }
  return undefined;
}

/**
 * 非原生 ARIA combobox 的「当前值」兜底:显示文本即当前选中项。
 *
 * ARIA 规定 combobox 的可及名来自 label/aria-label,当前值来自显示内容——组件库
 * (Element Plus el-select 等)普遍不给 aria-label,于是这类下拉在 observe 里既无名
 * 也无值。主 frame 靠 AX 覆盖层补上 value,但覆盖层只跑 frameId 0(见下方 applyOverlay
 * 调用处),iframe 内的 combobox 因此完全不透明 —— 真实日志里 iframe 内 46 个 combobox
 * 无一带 value,91% 名值皆无(2026-08-11,live A/B 已复现)。
 *
 * 纯决策:文本由调用方传入(提取用 visibleTextContent,排除隐藏子树)。
 * Why export:供 `observe-aria-combobox-value.test.ts` 直测真源;inject func 内联同语义
 * 副本(closure 注入无法 import),改一处须同步另一处,源码锁守护。
 */
export function ariaComboboxValue(
  role: string,
  tagName: string,
  visibleText: string,
): string | undefined {
  if (role !== "combobox") return undefined;
  const tag = tagName.toUpperCase();
  // 原生控件有更准的真值来源(selectedOptions / IDL value),不接管
  if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return undefined;
  const txt = visibleText.replace(/\s+/g, " ").trim();
  return txt ? txt.slice(0, 80) : undefined;
}

export const SINGLE_CONTROL_ROLES = new Set<string>([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
  "checkbox",
  "radio",
  "switch",
]);
export function isCompoundControlSelf(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY") return true;
  const role = el.getAttribute("role")?.trim().split(/\s+/)[0];
  return !!role && SINGLE_CONTROL_ROLES.has(role);
}

/**
 * 截断优先级 rank:rank 越小越优先保留。widget 最高,landmark 最先丢。
 * 接入 allCandidates 排序的次级 key,不破坏既有两层正交排序(overlay + main-content)。
 * 真源见 reasoning/aria-taxonomy.ts(categoryOf);inject 内联副本 closure 注入无法 import,
 * 改此处须同步 inject 内联副本,observe-truncation-priority.test.ts 源码锁守护同义。
 * @author qingwa
 */
export function truncationRank(role: string): number {
  switch (categoryOf(role)) {
    case "widget": return 0;
    case "composite": return 1;
    case "range":
    case "live":
    case "window": return 2;
    case "structure": return 3;
    case "landmark": return 4;
    default: return 5;
  }
}

/**
 * Tailwind / 原子 CSS 工具类判据 —— iconNameFromClass 的 className 兜底否决用
 * (swiperjs.com / tiptap.dev dogfood 2026-06-22)。
 *
 * 现象:无 aria-label/title/alt 的图标元素(`<a class="mb-4"><img alt=""></a>`、
 * `<button class="p-0.5"><svg lucide></button>`)落到 className 兜底,正则
 * `^_?([a-zA-Z][a-zA-Z0-9_-]{2,})` 把 Tailwind 布局类(`mb-4`/`p-0`/`block`/`size-12`/
 * `text-grayAlpha-600`)当语义名返回,对 agent 是噪声且误导。
 *
 * 判据:精确匹配显示/定位/排版关键字集,或前缀匹配间距/尺寸/颜色/层叠等工具类族。
 * 真语义图标类(`icon-search`/`close`/`chevron-down`/`arrow-left`)不命中——它们不以
 * Tailwind 前缀起、不在关键字集。命中 → 视为非语义,className 兜底跳过该 token。
 *
 * Why export:供 `observe-tailwind-utility-name.test.ts` jsdom 直测真源;inject func
 * 内联同语义副本(closure 注入无法 import),改一处须同步另一处,源码锁守护。
 */
const TW_UTILITY_KEYWORDS = new Set<string>([
  "block", "inline", "inline-block", "inline-flex", "inline-grid", "flex", "grid",
  "hidden", "contents", "table", "flow-root", "flex-row", "flex-col", "flex-wrap",
  "absolute", "relative", "fixed", "sticky", "static",
  "truncate", "grow", "shrink", "italic", "underline", "uppercase", "lowercase",
  "capitalize", "antialiased", "rounded", "border", "shadow", "transition",
]);
const TW_UTILITY_PREFIX_RE =
  /^-?(?:m|p)[trblxyse]?-\d|^(?:w|h|size|min-w|max-w|min-h|max-h|gap|space-x|space-y|inset|top|bottom|left|right|order|basis|col-span|row-span|grid-cols|grid-rows|text|bg|border|ring|rounded|shadow|opacity|z|leading|tracking|translate|scale|rotate|skew|origin|font|placeholder|caret|accent|outline|animate|select|resize|appearance|duration|delay|ease|justify|items|self|place|flex|will-change|cursor|transition|content|decoration|snap|overscroll|whitespace|break|columns|aspect|object|pointer-events|touch|hyphens|word|fill|stroke)-/;
// 关键字带值后缀:`shrink-0` / `rounded-none` / `grow-[2]`。关键字集只收了裸词,
// 实测 `shrink-0` ×28 泄漏成按钮名(2026-08-11 使用日志)。只在关键字后才算,
// 否则 `step-0` / `badge-none` 这类语义类会被误杀。
const TW_VALUE_SUFFIX_RE = /^(.+?)-(?:\d+(?:\.\d+)?|none|full|auto|px|\[[^\]]*\])$/;
export function isTailwindUtilityClass(token: string): boolean {
  const t = token.toLowerCase();
  // 变体类含冒号分隔符(hover:opacity-75 / md:flex / dark:bg-gray-800 / group-hover:…)——
  // 整体非语义。冒号在 CSS class 标识符里仅 Tailwind/UnoCSS 变体使用(BEM/语义类不含)。
  if (t.includes(":")) return true;
  if (TW_UTILITY_KEYWORDS.has(t)) return true;
  if (TW_UTILITY_PREFIX_RE.test(t)) return true;
  const m = TW_VALUE_SUFFIX_RE.exec(t);
  return m != null && TW_UTILITY_KEYWORDS.has(m[1]);
}

/**
 * 角色同义词:名字里的这些词说的就是 role 本身。
 * 键是归一化 role,值是「名字末段命中即视为重述」的词。
 */
const ROLE_SYNONYMS: Record<string, readonly string[]> = {
  button: ["button", "btn"],
  link: ["link", "anchor"],
  group: ["group"],
  radiogroup: ["radiogroup", "group"],
  paragraph: ["paragraph", "text", "txt"],
  list: ["list"],
  listitem: ["listitem", "item"],
  checkbox: ["checkbox"],
  radio: ["radio"],
  textbox: ["textbox", "input", "field"],
  image: ["image", "img"],
  heading: ["heading", "title"],
};

/**
 * 名字是否只是 CSS 类噪声 —— 要么把 role 又说了一遍，要么带随渲染变化的生成 id。
 *
 * 这两类都比无名更糟：零信息、必然重名、还顶掉真名字的位置；生成 id 更是按名定位
 * 必然失效。纯图标按钮的语义类名(icon-search / closeIcon / chevron-down)不在此列，
 * 它们是那些元素唯一的名字来源。
 *
 * Why export：inject func 内联同语义副本(注入体不能 import)，改一处须同步另一处。
 * @param name 已生成的可及名
 * @param role 该元素最终对外的 role
 */
export function isNoisyClassName(name: string, role: string): boolean {
  const t = name.trim().toLowerCase();
  // 含空格 = 真实文案,不是类名;非 ASCII 同理(类名不会是中文)
  if (!t || /\s/.test(t) || /[^\x20-\x7e]/.test(t)) return false;
  const segs = t.split(/[-_]|(?<=[a-z])(?=[0-9])/).filter(Boolean);
  // 生成 id:词段 + ≥3 位数字段(common_251604984266 / item-4821)。**必须有非数字段**
  // ——裸数字串是内容不是类名,班牛商品表的 商品ID/SKUID 就长这样,当成生成 id
  // 会把整列真值抹掉(2026-08-11 生产数据回放实测 ~200 条)。
  if (segs.some((s) => !/^\d+$/.test(s)) && segs.some((s) => /^\d{3,}$/.test(s))) return true;
  const r = role.trim().toLowerCase();
  if (t === r) return true;
  const syn = ROLE_SYNONYMS[r];
  return syn != null && syn.includes(segs[segs.length - 1] ?? "");
}

/**
 * 是否该把这个名字置空。在 isNoisyClassName 之上加一道**内容优先**的闸:
 * 名字若出现在元素可见文本里,它就是内容而非类名,再像类名也不能动。
 * @param visibleText 元素的可见文本
 */
export function shouldDropClassName(name: string, role: string, visibleText: string): boolean {
  if (!isNoisyClassName(name, role)) return false;
  return !visibleText.includes(name.trim());
}

/**
 * overlay-priority(DEFECT-1):弹层语义 role 集——可见且脱流时,其交互后代前置免遭
 * maxElements 截断(portal 弹层挂 body 末尾,DOM 序最后,密集页上点开即被截掉)。
 * 注意:inject func(scanOneFrame)内联同名副本,closure 注入无法 import,**改一处须
 * 同步另一处**;`observe-overlay-priority.test.ts` jsdom 直测本导出锁守护。
 */
export const OVERLAY_POPUP_ROLES = new Set<string>([
  "dialog", "alertdialog", "listbox", "menu", "tree", "grid", "tooltip",
]);

/**
 * 元素是否"脱离正常流"——自身或近祖先(≤maxHops 跳,到 body 止)position fixed/absolute。
 * 把静态在流内的 role=grid/tree/listbox(数据表/侧栏树/常驻列表)排除出前置,只前置
 * 真正的弹出层(浮层),保护 baseline 不漂移。inject func 内联同名副本,改一处须同步。
 */
export function isOverlayFloating(el: Element, maxHops = 6): boolean {
  let cur: Element | null = el;
  let hops = 0;
  const body = el.ownerDocument?.body;
  while (cur && cur !== body && hops < maxHops) {
    const pos = getComputedStyle(cur as HTMLElement).position;
    if (pos === "fixed" || pos === "absolute") return true;
    cur = cur.parentElement;
    hops++;
  }
  return false;
}

/**
 * 持久导航菜单判据(overlay 误判修复):role=menu/tree 的常驻结构(侧栏导航 / 常驻树)由
 * 用户主动导航而非触发器打开,不是临时弹层,却可能因常驻容器 position:fixed(粘性滚动)
 * 误过 isOverlayFloating。判据:真弹层由触发器(combobox/按钮)经 aria-controls/aria-owns
 * 关联;无控制器即持久结构;在 <nav>/[role=navigation] landmark 内同样视为导航。
 * listbox/dialog/tooltip 等本质临时,不在此列。inject func 内联同名逻辑,改一处须同步。
 * (semi.design 侧栏 ul[role=menu].semi-navigation-list 实证:228 项被误前置吞掉 maxElements。)
 */
export function isPersistentNavMenu(el: Element, role: string): boolean {
  if (role !== "menu" && role !== "tree") return false;
  if (el.closest('nav,[role="navigation"]')) return true;
  const id = el.id;
  if (id && el.ownerDocument?.querySelector('[aria-controls~="' + id + '"],[aria-owns~="' + id + '"]')) {
    return false;
  }
  return true;
}

/**
 * overlay-priority 候选重排:把"在任一浮层根内"的候选(含浮层根自身)前置到最前,保持
 * 其相对 DOM 序;其余保持原序。**无浮层根 → 返回原数组同序(零漂移,baseline 不变)**。
 * inject func 内联同名逻辑,改一处须同步。
 */
export function partitionOverlayFirst(candidates: Element[], overlayRoots: Element[]): Element[] {
  if (overlayRoots.length === 0) return candidates;
  const inOverlay = (el: Element): boolean =>
    overlayRoots.some((root) => root === el || root.contains(el));
  const front: Element[] = [];
  const rest: Element[] = [];
  for (const el of candidates) (inOverlay(el) ? front : rest).push(el);
  return front.length > 0 ? [...front, ...rest] : candidates;
}

/**
 * 模态作用域(Modal Scoping,N002 T2-2):aria-modal="true" 弹层打开时,ARIA 语义要求 AT 把
 * 模态外内容视为 inert。observe 默认行为是把模态控件与整页背景平铺混合(Element Plus dialog
 * 实测:模态 3 按钮混进 56 个背景元素),且与 actionability 的 OBSCURED 口径自相矛盾。
 * 判据硬门=aria-modal="true"(可见性由 overlayRoots 收集时已保证);role=dialog 无 aria-modal
 * 的伪模态不裁剪,仍走 overlay-priority 前置。inject func 内联同名逻辑,改一处须同步;本组导出
 * 由 observe-modal-scope.test.ts 锁守护。
 */
export function isModalOverlayRoot(
  el: Element,
  getAttr: (e: Element, n: string) => string | null = (e, n) => e.getAttribute(n),
): boolean {
  return getAttr(el, "aria-modal") === "true";
}

/**
 * N0002 B002:多信号 modal 判定。isModalOverlayRoot(仅 aria-modal=true)是硬门,但漏掉
 *   1) role=dialog/alertdialog 但没标 aria-modal(老代码库常见,antd 老 Dialog / shadcn AlertDialog
 *      默认无 aria-modal,仅 role);
 *   2) 全屏 overlay(Element Plus `.el-overlay` 罩层)——挡 el-dialog 整屏,但 el-dialog 自身
 *      才有 role,罩层无任何 ARIA 信号,只能靠尺寸判断。
 * 三门按顺序:aria-modal 严格门 → role 语义门 → 覆盖门(全屏,>=80% 视口宽高)。
 * 覆盖门须配「含交互后代」,由 overlayRoots 收集阶段保证,本函数只判单元素尺寸不再查子元素。
 * inject func(scanOneFrame)内联同名逻辑,改一处须同步;本导出由 observe-modal-scope.test.ts 锁守护。
 * @author qingwa
 */
export function isModalLikeOverlay(
  el: Element,
  getAttr: (e: Element, n: string) => string | null = (e, n) => e.getAttribute(n),
  viewport: () => { w: number; h: number } = () => ({ w: innerWidth, h: innerHeight }),
): boolean {
  if (getAttr(el, "aria-modal") === "true") return true;
  const role = (getAttr(el, "role") || "").trim().split(/\s+/)[0];
  if (role === "dialog" || role === "alertdialog") return true;
  const r = el.getBoundingClientRect();
  const { w, h } = viewport();
  return r.width >= w * 0.8 && r.height >= h * 0.8;
}

/**
 * N0002 B004:大页 candidate 遍历的时间预算早退。密集型 SPA(antd Pro / bytenew 工单详情)
 * 单帧可扫到 4000+ 候选,后续评估循环累加主线程耗时 → Tab 卡顿。
 * 修复:遍历带 max + budgetMs 双门控,max 命中或超时即停止收集。
 * 本导出是纯函数版供单测;scanOneFrame 注入体内联同名逻辑由人工后续接入。
 * inject func(scanOneFrame)内联同名逻辑,改一处须同步;本导出由 observe-time-budget.test.ts 锁守护。
 * @author qingwa
 */
export function collectWithBudget<T>(
  cands: T[],
  max: number,
  budgetMs: number,
  now: () => number,
): { processed: number; timeBudgetHit: boolean; limit: number } {
  const t0 = now();
  let i = 0;
  let timeBudgetHit = false;
  for (; i < cands.length; i++) {
    if (i >= max) break;
    if (now() - t0 > budgetMs) {
      timeBudgetHit = true;
      break;
    }
  }
  return { processed: i, timeBudgetHit, limit: max };
}

/**
 * N0002 B003:pre/code/samp/kbd 的 tabindex=0 仅用于聚焦滚动(常见 dev 文档站 Prism/
 * highlight.js 给 <pre> 加 tabindex="0" 让人能滚长代码块),不是真正可交互控件。
 * 例外:contenteditable="true"——罕见的 Monaco/CodeMirror 把 pre 设为可编辑,保留为控件。
 * inject func(scanOneFrame)内联同名逻辑,改一处须同步;本导出由 observe-readonly-tag.test.ts 锁守护。
 * @author qingwa
 */
export function isReadonlyScrollTag(
  tag: string,
  contenteditable: string | null,
): boolean {
  if (contenteditable === "true") return false;
  return tag === "pre" || tag === "code" || tag === "samp" || tag === "kbd";
}

/**
 * N0002 B005:treeitem 嵌套深度推断。Element Plus / antd Tree 等组件忘记在 DOM 写
 *   aria-level,但 DOM 嵌套 group → treeitem 嵌套能反映层级。沿 [role=tree] 祖先
 *   上溯,每穿过一个 [role=group] 累加 1。tree 顶层 level=1,嵌 1 个 group = 2,嵌 2 = 3。
 *   aria-level attribute 优先(更准确,作者显式声明),此函数仅作 fallback。
 *   无 [role=tree] 祖先 → undefined(非树形控件,不输出 level)。
 *   注入体(scanOneFrame)内联同名逻辑,改一处须同步;本导出由 observe-treeitem-level.test.ts 锁守护。
 * @author qingwa
 */
export function inferTreeitemLevel(
  el: Element,
  closest: (sel: string) => Element | null = (s) => el.closest(s),
): number | undefined {
  const treeRoot = closest("[role=tree]");
  if (!treeRoot) return undefined;
  let level = 1;
  let n: Element | null = el.parentElement;
  while (n && n !== treeRoot) {
    if (n.getAttribute("role") === "group") level++;
    n = n.parentElement;
  }
  return level;
}

/**
 * 从 overlayRoots(已是可见脱流浮层根)中挑出 active modal:aria-modal=true 的根。多个(嵌套
 * 对话框 Outer+Inner)取 overlayRoots 中最后一个——信号一按 querySelectorAllDeep 文档序收集,
 * 后者即 DOM 序更后/更顶层的模态。无模态根返回 null(短路 → 零漂移)。
 */
export function selectActiveModal(
  overlayRoots: Element[],
  getAttr: (e: Element, n: string) => string | null = (e, n) => e.getAttribute(n),
): Element | null {
  let found: Element | null = null;
  for (const el of overlayRoots) {
    if (isModalOverlayRoot(el, getAttr)) found = el;
  }
  return found;
}

/**
 * 运行时(inject func)实际用的多信号 active modal 选择——分层优先级:
 *   ① 优先 aria-modal=true 的最后一个(ARIA 权威信号,嵌套对话框取顶层);
 *   ② 无任何 aria-modal=true 时,才回退到 isModalLikeOverlay 多信号(role=dialog/
 *      alertdialog / 视口≥80% 覆盖)的最后一个,兜底 antd 老 Dialog / shadcn AlertDialog /
 *      Element Plus .el-overlay 罩层。
 *
 * 修复(2026-06-29 modal-scope bench live 实测):旧 inline 对 isModalLikeOverlay 命中者
 * 一律 last-wins、不区分信号强度 → 真模态(aria-modal=true "Tips")被 DOM 序靠后、仅
 * role=dialog 的伪模态("Hint")夺位,真模态反被裁剪抑制。分层后 aria-modal=true 权威优先。
 *
 * inject func(scanOneFrame)内联同名逻辑(__activeModal/__activeStrictModal),改一处须同步;
 * 本导出由 observe-modal-scope.test.ts 锁守护。
 * @author qingwa
 */
export function selectActiveModalLike(
  overlayRoots: Element[],
  getAttr: (e: Element, n: string) => string | null = (e, n) => e.getAttribute(n),
  viewport: () => { w: number; h: number } = () => ({ w: innerWidth, h: innerHeight }),
): Element | null {
  let strict: Element | null = null;
  let like: Element | null = null;
  for (const el of overlayRoots) {
    if (getAttr(el, "aria-modal") === "true") {
      strict = el;
      like = el;
    } else if (isModalLikeOverlay(el, getAttr, viewport)) {
      like = el;
    }
  }
  return strict ?? like;
}

/**
 * 把候选裁剪到模态子树:保留 modalRoot 内(含自身)的候选,统计被抑制的背景数。保持候选相对序。
 */
export function scopeCandidatesToModal(
  candidates: Element[],
  modalRoot: Element,
): { kept: Element[]; suppressed: number } {
  const kept: Element[] = [];
  let suppressed = 0;
  for (const el of candidates) {
    if (el === modalRoot || modalRoot.contains(el)) kept.push(el);
    else suppressed++;
  }
  return { kept, suppressed };
}

/**
 * 信号二:portal 弹层根收集(无 ARIA 弹层 role 时的兜底,如 el-select popper)。
 * 判据:脱流(position absolute/fixed)+ z-index 抬升(>0)+ 可见 + 含交互后代。
 *
 * **扫描深度=body 直接子 + 直接子的直接子(body 孙)**:rc-component(antd Cascader/Dropdown/
 * Popover/Tooltip 等)经 rc-trigger 把真正定位(z 抬升)的弹层嵌在 body 直接子的「static 透明
 * 包裹层」下一层(`body > div(static) > div.popup(absolute,z:1050)`),只扫 body 直接子会漏掉
 * 整层 portal → 其交互后代不前置、密集页上遭 maxElements 截断(2026-06-23 Cascader dogfood
 * R24 实证:role=menu 列又被 isPersistentMenu 排除,signal-1 也漏 → 选项 observe 完全不可见)。
 * static 透明 wrapper / SPA app-root 自身因不满足 absolute+z>0 不会被误纳,blast radius 受守。
 * inject func(scanOneFrame)内联同名逻辑,改一处须同步;本导出由 observe-overlay-priority.test.ts 锁守护。
 */
export function collectPortalOverlayRoots(
  body: Element,
  isVisibleForOverlay: (el: Element) => boolean,
  atomicSelector: string = OVERLAY_DESCENDANT_SELECTORS,
  alreadyRoots: Element[] = [],
): Element[] {
  const roots: Element[] = [];
  // body 直接子 + rc-trigger 透明包裹层下一层(body 孙)。
  const cands: Element[] = [];
  for (const child of Array.from(body.children)) {
    cands.push(child);
    for (const gc of Array.from(child.children)) cands.push(gc);
  }
  for (const el of cands) {
    if (alreadyRoots.includes(el) || roots.includes(el)) continue;
    const cs = getComputedStyle(el as HTMLElement);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    const z = parseInt(cs.zIndex, 10);
    if (!(z > 0)) continue;
    if (!isVisibleForOverlay(el)) continue;
    if (!el.querySelector(atomicSelector)) continue;
    roots.push(el);
  }
  return roots;
}

/**
 * 导航菜单根识别(A-1 main 层降权,ant.design dogfood):<main> 内常驻 role=menu/tree
 * 侧栏导航(ant.design ant-menu-inline:74 项跨页链接、position static、无 fixed 祖先,
 * 既不走 overlay 也不在 <nav> landmark 内,却 DOM 序前于 demo 霸占 maxElements)。
 * 判据:① 在 nav/navigation/menubar landmark 内,或 ② 菜单项 ≥5 且多数(≥60%)为
 * 跨页 <a href>(非 #/锚点)链接。②把"被演示的 Menu 组件"(项无跨页链接)排除在外,
 * 只降权真站点导航。inject func 内联同名逻辑,改一处须同步。
 */
export function isNavMenuRoot(el: Element, role: string): boolean {
  if (role !== "menu" && role !== "tree") return false;
  if (el.closest('nav,[role="navigation"],[role="menubar"]')) return true;
  const items = el.querySelectorAll('[role="menuitem"],[role="treeitem"]');
  if (items.length < 5) return false;
  let links = 0;
  for (const it of Array.from(items)) {
    const a = it.matches("a[href]") ? it : it.querySelector("a[href]");
    const href = a?.getAttribute("href") ?? "";
    if (href.length > 1 && !href.startsWith("#")) links++;
  }
  return links >= items.length * 0.6;
}

// curated 展开图标类(antd/rc-tree/element-plus):switcher caret / expand-icon。
const TREE_SWITCHER_CLASS_RE =
  /(?:^|[\s_-])(?:ant-tree-switcher|rc-tree-switcher|el-tree-node__expand-icon)(?:[\s_-]|$)/;
// noop/leaf 占位(无子可展开):明确非 toggle。
const TREE_SWITCHER_NOOP_RE = /(?:switcher-noop|is-leaf)/;
function elClass(n: Element): string {
  return typeof n.className === "string" ? n.className : n.getAttribute("class") || "";
}

/**
 * tree 展开/折叠 switcher 识别(R25 dogfood:antd Tree 点 treeitem-title 仅选中、点 switcher
 * caret 才展开;switcher 因祖先 treeitem ∈ ATOMIC_INTERACTIVE_SELECTORS 被 cursor:pointer
 * fallback 的跨池祖先短路吸收 → 无独立 ref,纯 observe agent 无法展开/折叠树节点)。
 *
 * Hybrid 检测(用户拍板):① ARIA 门——必在「带 aria-expanded 的 treeitem」内(只对可展开节点
 * 生效,叶子无 aria-expanded → 零噪声);② curated 类优先(antd/rc-tree/element-plus,排除
 * noop/is-leaf 占位);③ 几何兜底——curated 漏(未知库)时,treeitem 内 DOM 序首个小图标
 * (≤32×32)cursor:pointer 非 checkbox 元素(caret 通常是行首最左小图标)。命中者豁免祖先短路、
 * surface 成独立 toggle ref(naming 见 getAccessibleName:按 treeitem aria-expanded 给 expand/collapse)。
 * 几何路用注入 getter(cursorOf/rectOf)以便 jsdom 直测;浏览器默认 getComputedStyle/bbox。
 * inject func 内联同名逻辑,改一处须同步;本导出由 observe-tree-switcher.test.ts 锁守护。
 */
export function isTreeExpandToggle(
  el: Element,
  cursorOf: (e: Element) => string = (e) => getComputedStyle(e as HTMLElement).cursor,
  rectOf: (e: Element) => { width: number; height: number } = (e) => e.getBoundingClientRect(),
): boolean {
  const treeitem = el.closest('[role="treeitem"]');
  if (!treeitem || !treeitem.hasAttribute("aria-expanded") || el === treeitem) return false;
  // checkbox/radio/原生 input 各有独立 ref,不当 toggle。
  if (el.matches('[role="checkbox"],[role="radio"],input')) return false;
  // ② curated 类:自身或到 treeitem 的祖先链命中 switcher 类。
  for (let n: Element | null = el; n && n !== treeitem; n = n.parentElement) {
    const cls = elClass(n);
    if (TREE_SWITCHER_NOOP_RE.test(cls)) return false; // noop 占位明确非 toggle
    if (TREE_SWITCHER_CLASS_RE.test(cls)) return true;
  }
  // ③ 几何兜底(未知库):el 是小图标 cursor:pointer,且是 treeitem 内 DOM 序首个这样的非 checkbox 图标。
  const r = rectOf(el);
  if (cursorOf(el) !== "pointer" || r.width === 0 || r.width > 32 || r.height > 32) return false;
  const icons = Array.from(treeitem.querySelectorAll("*")).filter((c) => {
    if (c === el) return true;
    if (c.matches('[role="checkbox"],[role="radio"],input')) return false;
    const cr = rectOf(c);
    return cursorOf(c) === "pointer" && cr.width > 0 && cr.width <= 32 && cr.height <= 32;
  });
  return icons.length > 0 && icons[0] === el;
}

/**
 * main-content-priority(A-1):文档站「左导航 + 右主内容」布局下,导航(DOM 序在前)
 * 霸占 maxElements 配额、主内容 0 召回(semi.design Select dogfood 实证:154 个 nav
 * 排在 244 个 Select demo 之前,maxElements=80/100 全给 nav)。用 WAI-ARIA landmark
 * <main>/[role=main] 锁定内容区,把其内候选前置,保持相对 DOM 序;无 landmark
 * (mainEl=null)或候选全在/全不在 main 内 → 返回原数组同序(零漂移)。仅在无浮层根时
 * 生效(overlay-priority 优先级更高)。inject func 内联同名逻辑,改一处须同步。
 */
export function partitionMainContentFirst(candidates: Element[], mainEl: Element | null): Element[] {
  // 内容区(<main>/[role=main])元素恒前置;无语义 landmark 时(多数文档站如 semi.design
  // 用 <div id=main-content> 而非 <main>)退而把导航区(<nav>/[role=navigation|menubar])元素
  // 后置。二者都把长导航挤出 maxElements 前缀,让主内容召回;只重排不丢弃(空则原数组同序)。
  const isNav = (el: Element): boolean =>
    !!el.closest('nav,[role="navigation"],[role="menubar"]');
  // 持久导航菜单(role=menu/tree 跨页链接侧栏)即便落在 <main> 内也须降权——否则
  // ant.design 侧栏 74 项排在 demo 之前霸占 maxElements。向上找最近的导航菜单根。
  const inNavMenu = (el: Element): boolean => {
    let cur: Element | null = el;
    while (cur) {
      const r = cur.getAttribute("role")?.trim().split(/\s+/)[0] ?? "";
      if ((r === "menu" || r === "tree") && isNavMenuRoot(cur, r)) return true;
      cur = cur.parentElement;
    }
    return false;
  };
  const inMain: Element[] = [];
  const mid: Element[] = [];
  const nav: Element[] = [];
  for (const el of candidates) {
    if (inNavMenu(el)) nav.push(el);
    else if (mainEl && mainEl.contains(el)) inMain.push(el);
    else if (isNav(el)) nav.push(el);
    else mid.push(el);
  }
  // 仅当跨 ≥2 个分桶才重排,否则原数组同序(零漂移)。
  const buckets = (inMain.length > 0 ? 1 : 0) + (mid.length > 0 ? 1 : 0) + (nav.length > 0 ? 1 : 0);
  return buckets <= 1 ? candidates : [...inMain, ...mid, ...nav];
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
  target: FrameTarget,
  maxElements: number,
  viewport: "visible" | "full",
  includeText: boolean,
  includeAX: boolean,
  filterMode: "interactive" | "all",
  scopeSelector: string | null,
  scopePagination: { snapshotId: string; nodeIndex: number } | null,
  paginationToken: string | null,
  deadline: number,
  onPermissionDenied: () => void,
  axRequests: AXRequest[],
  listenerRequests: ListenerRequest[],
  scanRequests: ScanRequest[],
  track: <T>(promise: Promise<T>) => Promise<T>,
): Promise<FramePageResult | null> {
  const { frameId } = target;
  const scanRequest = scanRequests.find((request) => request.frameId === frameId && request.documentId === target.documentId);
  if (!scanRequest) return null;
  try {
    let axRequest: AXRequest | null = null;
    if (includeAX && typeof target.documentId === "string" && target.documentId.trim() &&
        (!target.documentLifecycle || target.documentLifecycle === "active")) {
      const request: AXRequest = { frameId, ancestorFrameIds: target.ancestorFrameIds, documentId: target.documentId, epoch: axEpoch, order: ++axOrder, token: crypto.randomUUID(), deadline, scanToken: scanRequest.token };
      // Register before sending: retire must be possible even when claim never returns.
      axRequests.push(request);
      try {
        const claimed = await chrome.scripting.executeScript({
          target: { tabId, documentIds: [request.documentId] }, world: "MAIN",
          func: updateAXOwnership, args: ["claim", request],
        });
        if (claimed.length === 1 && claimed[0].documentId === request.documentId && claimed[0].frameId === frameId &&
            (claimed[0].result === true || (claimed[0].result === false && await recoverDocumentOwnership("ax", tabId, request)))) axRequest = request;
      } catch (err) {
        console.warn(`[vortex.observe] AX claim skipped fid=${frameId}`, err);
      }
    }
    // 遮挡判定要用 dom-resolve 的 classifyHit;注入失败不拖垮整帧扫描
    await loadPageSideModule(tabId, frameId, "dom-resolve", { request: scanRequest, track }).catch(() => {});
    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [scanRequest.documentId] },
      func: (
        max: number,
        mode: string,
        withText: boolean,
        withAX: boolean,
        filter: "interactive" | "all",
        scopeSelector: string | null,
        scopePagination: { snapshotId: string; nodeIndex: number } | null,
        paginationToken: string | null,
        deadline: number,
        scanRequest: ScanRequest,
        listenerRequest: ListenerRequest | null,
        axRequest: AXRequest | null,
      ) => {
        const scanDocument = document;
        // 注入侧跑在页面上下文里，拿不到模块作用域的 vtxError：裸 Error 过不了仓库的
        // 抛错纪律门禁（scripts/check-throw-discipline.mjs）。改抛同形的 Error（带 code
        // 属性），code 取 @vortex-browser/shared 的 VtxErrorCode 同值。
        const __vtxFail = (code: string, msg: string): never => {
          const e = new Error(msg) as Error & { code?: string };
          e.code = code;
          throw e;
        };
        const ownsScan = (request = scanRequest) => {
          const owner = (document as any).__vortexScanOwner;
          return document === scanDocument && !!owner && owner.documentId === request.documentId && owner.frameId === request.frameId &&
            owner.epoch === request.epoch && owner.highWater === request.order && owner.owner === request.token &&
            !owner.retired && owner.deadline === request.deadline && Date.now() < request.deadline;
        };
        const owner = (document as any).__vortexScanOwner;
        if (Date.now() >= deadline || !ownsScan() || owner.scanned) return null;
        // Consume the capture once; duplicate scans cannot rebuild an existing item.
        owner.scanned = true;
        let scanInvalid = false;
        const ownsListenerMarkers = () => {
          const owner = (document as any).__vortexListenerOwner;
          return !!listenerRequest && !!owner && owner.documentId === listenerRequest.documentId &&
            owner.frameId === listenerRequest.frameId && owner.epoch === listenerRequest.epoch &&
            owner.highWater === listenerRequest.order && owner.owner === listenerRequest.token &&
            !owner.retired && owner.deadline === listenerRequest.deadline && Date.now() < listenerRequest.deadline;
        };
        const hasListenerMarker = (el: Element, name: string) =>
          ownsListenerMarkers() && el.getAttribute(name) === listenerRequest!.token;
        const listenerSelector = ownsListenerMarkers() ? `[data-vtx-listener="${listenerRequest!.token}"]` : ":not(*)";
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
        const SHADOW_WALK_MAX_DEPTH = 8;
        function querySelectorAllDeep(selector: string, root: Document | ShadowRoot | Element, depth = 0, walkDeadline = deadline): Element[] {
          const acc: Element[] = root instanceof Element && root.matches(selector) ? [root] : [];
          acc.push(...Array.from(root.querySelectorAll(selector)));
          if (depth >= SHADOW_WALK_MAX_DEPTH) return acc;
          if (root instanceof Element && root.shadowRoot) acc.push(...querySelectorAllDeep(selector, root.shadowRoot, depth + 1, walkDeadline));
          for (const host of root.querySelectorAll('*')) {
            if (Date.now() >= walkDeadline) __vtxFail("TIMEOUT", "Observe deadline expired");
            if (host.shadowRoot) acc.push(...querySelectorAllDeep(selector, host.shadowRoot, depth + 1, walkDeadline));
          }
          return acc;
        }
        // 目标局部观察:先定位 scope 容器。**必须在清理 data-vortex-rid 之前**——
        // 上一轮 observe 给歧义元素打的 rid 标记本身可能就是 scope 选择器。
        let scopeEl: Element | null = null;
        let scopeError: { code: string; message: string } | null = null;
        if (scopeSelector && scopePagination) {
          const item = (window as any).__vortexPageSnapshots?.[scopePagination.snapshotId];
          try {
            scopeEl = item?.check?.() ? item.validate?.(scopePagination.nodeIndex, scopeSelector) ?? null : null;
          } catch (err) {
            console.warn("[vortex.observe] pagination target validation failed", err);
          }
          if (!scopeEl) scopeError = { code: "STALE_SNAPSHOT", message: "Page changed since the snapshot was captured" };
        } else if (scopeSelector) {
          let matches: Element[] = [];
          try {
            matches = querySelectorAllDeep(scopeSelector, document);
          } catch {
            scopeError = {
              code: "INVALID_SELECTOR",
              message: `Invalid selector: ${scopeSelector}`,
            };
          }
          if (!scopeError) {
            if (matches.length === 0) {
              scopeError = {
                code: "ELEMENT_NOT_FOUND",
                message: `Element not found: ${scopeSelector}`,
              };
            } else if (matches.length > 1) {
              scopeError = {
                code: "SELECTOR_AMBIGUOUS",
                message: `Selector matched ${matches.length} elements: ${scopeSelector}`,
              };
            } else {
              scopeEl = matches[0];
            }
          }
        }
        if (scopeError) {
          return { url: location.href, title: document.title, viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight }, elements: [], candidateCount: 0, truncated: false, scopeError };
        }
        const scanRoot = scopeEl ?? document;
        // Clear stale rids from previous observes on this frame so the
        // attribute set never accumulates across long-lived SPA sessions
        // and stale snapshot refs can't silently resolve to mis-rendered
        // elements (review feedback on PR #19).
        for (const stale of document.querySelectorAll("[data-vortex-rid]")) {
          if (Date.now() >= deadline || !ownsScan()) return null;
          stale.removeAttribute("data-vortex-rid");
        }
        if (Date.now() >= deadline || !ownsScan()) return null;
        if (paginationToken) {
          const states = ((window as any).__vortexPageSnapshots ??= {});
          let navigation = (window as any).__vortexNavigationIdentity;
          if (!navigation || navigation.document !== document) {
            navigation = { document, revision: 0 };
            (window as any).__vortexNavigationIdentity = navigation;
            for (const method of ["pushState", "replaceState"] as const) {
              const original = window.history[method];
              window.history[method] = function (...args: Parameters<History[typeof method]>) {
                const result = original.apply(this, args);
                navigation.revision++;
                return result;
              };
            }
            window.addEventListener("popstate", () => { navigation.revision++; });
            window.addEventListener("hashchange", () => { navigation.revision++; });
          }
          const revision = navigation.revision;
          const url = location.href;
          const navigationValid = () => navigation.document === document && navigation.revision === revision && location.href === url;
          const oldest = Object.keys(states);
          if (oldest.length >= 16) {
            const entry = states[oldest[0]];
            clearTimeout(entry.timer);
            entry.state.observer.disconnect();
            delete states[oldest[0]];
          }
          const state = { changed: false, observer: null as MutationObserver | null,
            hosts: [] as Array<{ element: Element; root: ShadowRoot | null }>,
            controls: [] as Array<{ element: Element; value: string; checked: boolean; selected: boolean }> };
          const expiresAt = Date.now() + 60_000;
          const relevant = (records: MutationRecord[]) => records.length > 0;
          if (!ownsScan()) return null;
          const observer = new MutationObserver((records) => { if (relevant(records)) state.changed = true; });
          state.observer = observer;
          const roots: Array<Document | ShadowRoot> = [document];
          const monitorDeadline = performance.now() + 200;
          let exceeded = false;
          let controlChars = 0;
          while (roots.length && !exceeded) {
            const root = roots.pop()!;
            if (!ownsScan()) { observer.disconnect(); return null; }
            observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
              if (Date.now() >= deadline || !ownsScan()) { observer.disconnect(); return null; }
              if (state.hosts.length >= 10000 || performance.now() > monitorDeadline) { exceeded = true; break; }
              const el = node as Element;
              state.hosts.push({ element: el, root: el.shadowRoot });
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.tagName === "OPTION") {
                const control = el as HTMLInputElement & HTMLOptionElement;
                state.controls.push({ element: el, value: control.value, checked: !!control.checked, selected: !!control.selected });
                controlChars += control.value.length;
                if (controlChars > 1_000_000) { exceeded = true; break; }
              }
              if (el.shadowRoot) roots.push(el.shadowRoot);
            }
          }
          if (exceeded) {
            state.changed = true;
            state.hosts.length = 0;
            state.controls.length = 0;
            observer.disconnect();
          }
          if (Date.now() >= deadline || !ownsScan()) { observer.disconnect(); return null; }
          const timer = setTimeout(() => {
            observer.disconnect();
            if (document === scanDocument && states[paginationToken] === item) delete states[paginationToken];
          }, 60_000);
          const marker = (el: Element, name: string, value: string | null, request = scanRequest) => {
            if (!ownsScan(request) || states[paginationToken] !== item || item.document !== document) __vtxFail("STALE_SNAPSHOT", "Observe lease revoked");
            if (relevant(observer.takeRecords())) state.changed = true;
            if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
            const records = observer.takeRecords();
            const own = records.findIndex((r) => r.type === "attributes" && r.target === el && r.attributeName === name);
            if (own >= 0) records.splice(own, 1);
            if (relevant(records)) state.changed = true;
          };
          const check = (includeControls = true, ignoreValue?: Element) => {
            const until = performance.now() + 200;
            if (relevant(observer.takeRecords())) state.changed = true;
            for (const host of state.hosts) {
              if (performance.now() > until || host.element.shadowRoot !== host.root) { state.changed = true; break; }
            }
            for (const saved of includeControls ? state.controls : []) {
              const el = saved.element as HTMLInputElement & HTMLOptionElement;
              if (performance.now() > until || (el !== ignoreValue && el.value !== saved.value) || !!el.checked !== saved.checked || !!el.selected !== saved.selected) {
                state.changed = true;
                break;
              }
            }
            return states[paginationToken] === item && item.document === document && Date.now() <= item.expiresAt && navigationValid() && !state.changed && !exceeded;
          };
          if (!ownsScan()) { clearTimeout(timer); observer.disconnect(); return null; }
          const item = { state, relevant, exceeded, timer, expiresAt, marker, navigationValid, check,
            document, documentId: scanRequest.documentId, frameId: scanRequest.frameId, captureToken: scanRequest.token };
          states[paginationToken] = item;
        }
        const setMarker = (el: Element, name: string, value: string) => {
          if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
          if (!ownsScan()) { scanInvalid = true; __vtxFail("STALE_SNAPSHOT", "Observe lease revoked"); }
          const item = paginationToken && (window as any).__vortexPageSnapshots[paginationToken];
          if (item) item.marker(el, name, value); else el.setAttribute(name, value);
        };

const INTERACTIVE_SELECTORS = [
          "button",
          "a[href]",
          // N0002 B017:iframe 元素收集。MDN 文档页 / PDF embed / video / 跨源 widget
          // 都有 <iframe>, INTERACTIVE_SELECTORS 不收 → 不进 baseCandidates → agent
          // 完全不知道页面含 iframe, 跨 frame 关联丢失。filter=all 时 TABLE_EXTRA_SELECTORS
          // 不含 iframe, 同样丢。直接收 (与 select / textarea 一致, 默认非 interactive 但
          // selector 收), getRole 推断 role=iframe (无 title) / region (有 title)。sandbox / src
          // 走 attributes 透传, agent 知道跨源风险。
          "iframe",
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
          // 原生 disclosure 触发器:<details> 的首个 <summary> 是可点开合的控件
          // (GitHub 菜单 / MDN / 文档站 FAQ 折叠大量使用)。它本身是交互入口,
          // 而关闭态 <details> 的内部内容由下方 checkVisibility 门挡掉
          // (content-visibility:hidden,2026-06-02 dogfood)。:first-of-type 限定
          // 首个——HTML 规范里仅第一个 <summary> 是 disclosure 控件,第 2+ 个是
          // 普通流内容点了无效,收进来会误导 agent(评审 #1 LOW)。
          "details > summary:first-of-type",
          "label:has(input[type=radio]), label:has(input[type=checkbox])",
          // Task 4 召回决策改造:不再逐个枚举 [role=X] 选择器,而是用 `[role]` 一网打尽
          // 所有显式 ARIA role,再走下方 RECALL_ROLES 召回门过滤(presentation/none/generic
          // 不召回)。新增 role 类型(ARIA 1.3 升版)无需再补 selector — 改一处 taxonomy
          // 即可生效(2026-06-28 a11y 评测 R1–R17 收敛)。
          "[role]",
          // 原生 HTML 语义容器:经 getRole HTML-AAM 隐式映射到 ARIA landmark/structure,
          // 同样走 RECALL_ROLES 召回门。这些 tag 历史上是「被忽视的容器」,Agent 看不到
          // 它们的 landmark/分组结构;现统一召回,与显式 [role=X] 形式等价。
          // 注意:section 仅在有 aria-label/aria-labelledby 时才为 region(无名称时
          // getRole 返 tag name "section" 不在 RECALL_ROLES),召回门会自然过滤掉
          // 装饰用 section;但下方收集循环加过门成本几乎为零,统一收也无副作用。
          "table,nav,main,header,footer,aside,fieldset,ul,ol,li,section",
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
          // [data-vtx-listener] 是 pre-scan CDP getEventListeners 标的纯 addEventListener
          // 元素(vanilla/jQuery 直绑 —— 见 observe-js-listener.ts)。data-vtx-listener
          // 必须独立选择器,无法被 [role] 或原生 tag 覆盖。
          listenerSelector,
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

        function getRole(el: Element, source?: { value: "dom" | "heuristic" }): string {
          if (source) source.value = "dom";
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
          // N0002 B017: <iframe> role 推断。无 title 时按 ARIA 1.2 / HTML-AAM role=iframe,
          // 有 title 时按 region (frame landmark) — 与 browser accessibility tree 一致。
          // 单纯暴露 role 不够, 还要透传 src + sandbox 给 agent, 走 attrs 字段。
          if (tag === "iframe") {
            return el.hasAttribute("title") ? "region" : "iframe";
          }
          // <summary> 是 disclosure 开合控件,交互模型等同按钮,role 报 button 让
          // LLM 直接理解为可点(原生 <details>/<summary>,2026-06-02 dogfood)。
          if (tag === "summary") return "button";
          // HTML-AAM 隐式映射(Task 3 新增,与上方导出 getRoleForTest 须同步)
          if (tag === "nav") return "navigation";
          if (tag === "main") return "main";
          if (tag === "aside") return "complementary";
          if (tag === "fieldset") return "group";
          if (tag === "ul" || tag === "ol") return "list";
          if (tag === "li") return "listitem";
          // header/footer 仅当非 article/section/aside/main/nav 后代时为 banner/contentinfo
          if (tag === "header" && !el.closest("article,section,aside,main,nav")) return "banner";
          if (tag === "footer" && !el.closest("article,section,aside,main,nav")) return "contentinfo";
          // section 仅在有可及名称(aria-label/aria-labelledby)时为 region
          if (tag === "section" && (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"))) return "region";
          // 班牛 bnCheck 自定义勾选控件(无 role/无原生 input)→ checkbox(N0064 P2-1)。
          if (source) source.value = "heuristic";
          if (bnCheckInfo(el)) return "checkbox";
          return tag;
        }

        // Task 4 召回门 passesRoleGate(真源:reasoning/aria-taxonomy.ts RECALL_ROLES)
        //
        // inject func 内联副本(真源见 aria-taxonomy.ts,改一处须同步 inject 内联副本与
        // handler 顶层 passesRoleGateForTest,源码锁守护,observe-taxonomy-inlined.test.ts +
        // observe-role-gate.test.ts 锁)。66 项,从 ARIA_ROLE_TAXONOMY 67 项扣 EXPLICIT_DENY
        // 唯一交集 caption;presentation/none/generic 不在(EXPLICIT_DENY 召回门过滤)。
        //
        // 召回决策:命中 [role] 或原生语义容器选择器时,只有 role ∈ RECALL_ROLES 才入池。
        // 原生交互元素(a/button/input/select/textarea/summary/label:has/input)+ 启发式
        // 入口(contenteditable/onclick/draggable/tabindex/listener marker)直接收,
        // 不走此门(curosr:pointer fallback 路径同理,不入池不需门)。
        // DERIVED_FROM_ARIA_TAXONOMY
        const __RECALL_ROLES = new Set([
          // widget(19):原子交互控件
          "button","checkbox","link","menuitem","menuitemcheckbox","menuitemradio",
          "option","radio","scrollbar","searchbox","slider","spinbutton","switch",
          "tab","textbox","treeitem","gridcell","columnheader","rowheader",
          // composite(9):管理一组 widget 的容器
          "combobox","grid","listbox","menu","menubar","radiogroup","tablist","tree","treegrid",
          // structure(21):文档结构容器(caption 在 EXPLICIT_DENY,排除)
          "group","toolbar","table","tabpanel","row","rowgroup","cell","article",
          "list","listitem","feed","figure","separator","tooltip","note","term",
          "definition","directory","document","application","blockquote",
          // landmark(8):地标
          "banner","complementary","contentinfo","form","main","navigation","region","search",
          // range(2):值域/进度
          "progressbar","meter",
          // live(5):实时区
          "alert","log","marquee","status","timer",
          // window(2):窗口
          "dialog","alertdialog",
        ]);
        function passesRoleGate(el: Element): boolean {
          return __RECALL_ROLES.has(getRole(el));
        }
        // 召回门触发条件:命中 [role] 或原生语义容器选择器(命中后才过门)。
        // 原生交互元素 / 启发式入口不命中此选择器 → 不过门,直接入池。
        const ROLE_GATE_TRIGGER_SELECTORS =
          "[role],table,nav,main,header,footer,aside,fieldset,ul,ol,li,section";

        // Icon-only fallback：先 svg `<title>` / img alt / aria-label，失败再 className。
        // 触发条件：元素含 svg/img 后代（典型 svg/img 图标按钮）。
        // **不**包含 `<i>` 标签兜底——空 `<i>` 多为 CSS pseudo-element 渲染的装饰。
        // className 路径带 denylist，过滤掉 Element Plus / Ant / Vant / Mantine 等框架前缀类
        // 和通用泛词 (icon/iconfont/btn/button/wrapper/container)——它们对 LLM 等同
        // "icon"/"button"，零信息（testc 实测 `el-icon` × 3 + `el-popover_*` × 2）。
        // 以及生成式原子类（emotion `css-*` / styled-components `sc-*`）纯 hash，
        // 否决以免框架前缀被否后级联回退到 emotion token（preview.pro.ant.design dogfood）。
        // CSS Modules `_closeIcon_1ygkr_39` → `closeIcon` 仍正常保留（不在 denylist）。
        // 共用于：(1) cursor:pointer fallback gate (2) getAccessibleName 末尾兜底。
        const ICON_CLASS_DENY_PREFIXES = ["el-", "ant-", "anticon", "van-", "mantine-"];
        // 否决一个 token 会**级联**到下一个 class token —— 实测 `shrink-0 box` 被否后
        // 名字落到 `box`。纯结构词整词命中才否决,`imt-fb-btn-content` 一类不受影响。
        const ICON_CLASS_DENY_NAMES = new Set([
          "icon", "iconfont", "btn", "button", "wrapper", "container",
          "box", "inner", "outer", "content", "body", "root", "item",
        ]);
        // isTailwindUtilityClass 内联副本(真源见导出函数,可单测;注入体不能 import,
        // 改一处须同步,源码锁守护)。Tailwind/原子 CSS 工具类(mb-4/p-0/block/size-12/
        // text-grayAlpha-600)非语义,className 兜底命中即跳过,防当图标名泄漏。
        const TW_UTILITY_KEYWORDS = new Set([
          "block", "inline", "inline-block", "inline-flex", "inline-grid", "flex", "grid",
          "hidden", "contents", "table", "flow-root", "flex-row", "flex-col", "flex-wrap",
          "absolute", "relative", "fixed", "sticky", "static",
          "truncate", "grow", "shrink", "italic", "underline", "uppercase", "lowercase",
          "capitalize", "antialiased", "rounded", "border", "shadow", "transition",
        ]);
        const TW_UTILITY_PREFIX_RE =
          /^-?(?:m|p)[trblxyse]?-\d|^(?:w|h|size|min-w|max-w|min-h|max-h|gap|space-x|space-y|inset|top|bottom|left|right|order|basis|col-span|row-span|grid-cols|grid-rows|text|bg|border|ring|rounded|shadow|opacity|z|leading|tracking|translate|scale|rotate|skew|origin|font|placeholder|caret|accent|outline|animate|select|resize|appearance|duration|delay|ease|justify|items|self|place|flex|will-change|cursor|transition|content|decoration|snap|overscroll|whitespace|break|columns|aspect|object|pointer-events|touch|hyphens|word|fill|stroke)-/;
        // 关键字带值后缀 shrink-0 / rounded-none(实测泄漏成按钮名),只在关键字后才算
        const TW_VALUE_SUFFIX_RE = /^(.+?)-(?:\d+(?:\.\d+)?|none|full|auto|px|\[[^\]]*\])$/;
        const isTailwindUtilityClass = (token: string): boolean => {
          const t = token.toLowerCase();
          if (t.includes(":")) return true; // 变体类 hover:/md:/dark: 等
          if (TW_UTILITY_KEYWORDS.has(t)) return true;
          if (TW_UTILITY_PREFIX_RE.test(t)) return true;
          const vm = TW_VALUE_SUFFIX_RE.exec(t);
          return vm != null && TW_UTILITY_KEYWORDS.has(vm[1]);
        };
        // isNoisyClassName 内联副本(真源见导出函数,可单测;改一处须同步)。
        // 名字只重述 role 或含生成 id → 零信息且必然重名,置空好过留着。
        const ROLE_SYNONYMS: Record<string, string[]> = {
          button: ["button", "btn"],
          link: ["link", "anchor"],
          group: ["group"],
          radiogroup: ["radiogroup", "group"],
          paragraph: ["paragraph", "text", "txt"],
          list: ["list"],
          listitem: ["listitem", "item"],
          checkbox: ["checkbox"],
          radio: ["radio"],
          textbox: ["textbox", "input", "field"],
          image: ["image", "img"],
          heading: ["heading", "title"],
        };
        const isNoisyClassName = (name: string, role: string): boolean => {
          const t = name.trim().toLowerCase();
          if (!t || /\s/.test(t) || /[^\x20-\x7e]/.test(t)) return false;
          const segs = t.split(/[-_]|(?<=[a-z])(?=[0-9])/).filter(Boolean);
          // 须有非数字段:裸数字串是内容(商品ID/SKUID),不是生成类名
          if (segs.some((s) => !/^\d+$/.test(s)) && segs.some((s) => /^\d{3,}$/.test(s))) return true;
          const r = role.trim().toLowerCase();
          if (t === r) return true;
          const syn = ROLE_SYNONYMS[r];
          return syn != null && syn.indexOf(segs[segs.length - 1] ?? "") >= 0;
        };
        // 内容优先闸:名字出现在可见文本里就是内容,再像类名也不能动
        const shouldDropClassName = (name: string, role: string, visibleText: string): boolean =>
          isNoisyClassName(name, role) && visibleText.indexOf(name.trim()) < 0;
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
          // 1b. svg 图标库类名(lucide `lucide lucide-chevron-right` / feather
          //     `feather feather-x`):图标语义名在 svg 自身 class,远胜按钮的
          //     Tailwind 布局类——否则下方 className 兜底把 `p-0.5` 截成噪声名 "p-0"
          //     (2026-06-22 tiptap.dev dogfood:侧栏 chevron 展开按钮命名 "p-0")。
          //     取 `<lib>-<name>` 的 name,hyphen→空格。lucide 广用于 shadcn/ui 等。
          if (inner.tagName === "svg") {
            const svgCls = inner.getAttribute("class") || "";
            for (const tok of svgCls.split(/\s+/)) {
              const lm = tok.match(/^(?:lucide|feather)-(.+)$/);
              if (lm && lm[1]) return lm[1].replace(/-/g, " ").slice(0, 80);
            }
          }
          // 2. className 兜底，带 denylist
          const cls =
            el.className && typeof el.className === "string" ? el.className : "";
          for (const c of cls.split(/\s+/).filter(Boolean)) {
            // Tailwind/原子工具类(mb-4/block/size-12/text-*/hover:opacity-75)非语义,
            // 整体跳过——对原始 token 检测(变体类的冒号在裁剪前才在)。否则无 aria-label
            // 的图标元素命名退化到布局/变体类(swiperjs/tiptap dogfood)。
            if (isTailwindUtilityClass(c)) continue;
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
            // 无框架前缀的高熵随机类名(CSS-modules 默认 [hash] / 各家构建产物,如
            // DuckDuckGo `w0GlwvoHJHjX9o0DVIaL`、`YZxymVMEkIDA0nZSt_Pm`)零语义,当名
            // 比无名更糟(噪声 + 假名击败 require-name 过滤,见下方 getAccessibleName
            // isContainer 注释 AJ),否决 → 元素回退到无名被噪声过滤器丢弃。
            // **按段检测**:按 -/_ 切段,任一段长 ≥8 且大小写混合 + 含数字 = 哈希
            // (覆盖无分隔符整段哈希与含 _/- 的哈希段 `YZxymVMEkIDA0nZSt_Pm`)。
            // 语义名不误伤:kebab/snake 段为纯小写、camelCase 无数字(`closeIcon` 保留)。
            const isHashSeg = cleaned
              .split(/[-_]/)
              .some(
                (seg) =>
                  seg.length >= 8 && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && /[0-9]/.test(seg),
              );
            if (isHashSeg) continue;
            // CSS Modules 打包哈希类(vanilla-extract / Mantine：`Name-module__HASH__part`,
            // 如 `MdxLlmAffix-module__OdnXjG__control`)是 build 期 scramble,零语义。
            // 否决以免框架前缀(mantine-)被否后级联回退到此类哈希名,泄漏成
            // `mdxllmaffix-module__odnxjg` 等噪声(mantine.dev ActionIcon dogfood 2026-06-22);
            // cleaning 仅剥尾段 `__part`,核心 `-module__hash` 仍在 lower 中可判定。
            if (/-module__[a-z0-9]/.test(lower)) continue;
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
          "bi-", "fa-", "glyphicon-", "vxe-icon-", "van-icon-", "pi-",
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
          // PrimeIcons 动画/布局修饰(非图标名,与 pi-<icon> 同形)
          "pi-spin", "pi-pulse", "pi-fw",
        ]);
        // 纯图标按钮的末位兜底:图标用 CSS 字体字形渲染(Bootstrap Icons `bi-gear`、
        // FontAwesome `fa-gear`、Glyphicons `glyphicon-cog`),无 inner svg/img 故
        // iconNameFromClass 吃不到,且无 aria-label/title/text → accessible name 真空。
        // 仅匹配已知 icon-font 前缀时取名(strip 前缀、hyphen→空格),避免泛 className
        // 噪声(2026-06-03 Monaco editor dogfood AP)。
        function iconFontNameFromClassStr(cls: string): string {
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
        function iconFontName(el: Element): string {
          // el 自身 class 优先(Bootstrap `<button class="bi bi-gear">`、Monaco AP 场景)。
          const own = iconFontNameFromClassStr(
            el.className && typeof el.className === "string" ? el.className : "",
          );
          if (own) return own;
          // 再回退到内部图标元素(<i>/<span>)的 class——很多库把字体图标类放在子 <i>:
          // PrimeVue/PrimeReact `<a><i class="pi pi-github">`、FA `<button><i class="fa fa-x">`。
          // 无 aria/title/text 的图标链接/按钮(github/discord/cog)否则全无名
          // (primevue.org dogfood 2026-06-22)。display-path 末位兜底,不进 gate(round-12)。
          // 遍历**全部** i/span(非仅首个):图标 <i> 常排在装饰 span 之后
          // (PrimeVue cog 按钮:animate-spin 装饰 span 在前、pi-cog 图标 <i> 在后)。
          for (const innerIcon of el.querySelectorAll("i[class], span[class]")) {
            if (innerIcon === el) continue;
            const n = iconFontNameFromClassStr(
              typeof innerIcon.className === "string" ? innerIcon.className : "",
            );
            if (n) return n;
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

        // 取元素后代文本但排除 visibility:hidden / display:none 子树(对齐 ACCNAME 规范:
        // 隐藏子树不计入可及名)。getAccessibleName 末位兜底刻意用 textContent(绕过
        // text-overflow:ellipsis 截断,见上方注释)——副作用是连 visibility:hidden 的镜像
        // 文本也拼进去。Radix header「hover-swap」用 visible + visibility:hidden 两份同文
        // span,textContent 得 "ThemesThemes";平时 AX overlay(CDP,正确排除 hidden)盖住,
        // 但 Select/Dialog 打开等致 AX overlay 跳过、回退本启发式时叠字暴露(2026-06-23
        // radix-ui.com Select-open dogfood)。本函数保留 visibility:visible 元素被 ellipsis
        // 裁剪的文本(其 computed visibility 仍 visible,不排除),兼顾两者。
        // perf:叶子(无子元素)走 textContent 快路径;text 超 96(normName 截 80 留余量)
        // 或访问超 250 元素节点即停,防大容器/深树拖慢扫描热路径。
        const isTextMasked = (el: Element): boolean => {
          const value = getComputedStyle(el).getPropertyValue("-webkit-text-security");
          return !!value && value !== "none";
        };
        const maskedSubtrees = new WeakMap<Element, boolean>();
        const containsMaskedText = (root: Element): boolean => {
          const stack: Array<{ el: Element; expanded: boolean }> = [{ el: root, expanded: false }];
          const pending = new WeakSet<Element>();
          while (stack.length) {
            if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
            const current = stack.pop()!;
            if (maskedSubtrees.has(current.el)) continue;
            if (isTextMasked(current.el)) { maskedSubtrees.set(current.el, true); continue; }
            const ownerRoot = current.el.getRootNode() as Document | ShadowRoot;
            const owned = ["aria-owns", "aria-labelledby"]
              .flatMap((attr) => (current.el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean))
              .map((id) => ownerRoot.getElementById(id));
            if (owned.some((el) => !el)) { maskedSubtrees.set(current.el, true); continue; }
            const children = [
              ...Array.from(current.el.children),
              ...Array.from(current.el.shadowRoot?.children ?? []),
              ...(current.el.tagName === "SLOT" ? (current.el as HTMLSlotElement).assignedElements({ flatten: true }) : []),
              ...owned.filter((el): el is HTMLElement => !!el),
            ];
            if (current.expanded) {
              maskedSubtrees.set(current.el, children.some((child) => maskedSubtrees.get(child) !== false));
              continue;
            }
            if (pending.has(current.el)) { maskedSubtrees.set(current.el, true); continue; }
            pending.add(current.el);
            stack.push({ el: current.el, expanded: true });
            for (const child of children) if (!maskedSubtrees.has(child)) stack.push({ el: child, expanded: false });
          }
          return maskedSubtrees.get(root) !== false;
        };
        const maskedTextNode = (node: Node): boolean => {
          const slot = (node as Text).assignedSlot;
          return (slot ? isTextMasked(slot) : node.parentElement ? isTextMasked(node.parentElement) : true);
        };
        const visibleTextContent = (el: Element, excludeControls = false, forValue = false): string => {
          let out = "";
          let count = 0;
          const visit = (node: Node): void => {
            const kids = node.childNodes;
            for (let i = 0; i < kids.length; i++) {
              if (forValue ? out.replace(/\s+/g, " ").trim().length >= 200 : out.length > 96 || count > 250) return;
              if (forValue && Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              const child = kids[i];
              if (child.nodeType === 3) {
                if (!maskedTextNode(child)) out += child.nodeValue || "";
                continue;
              }
              if (child.nodeType !== 1) continue;
              if (excludeControls && (child as Element).matches("input,textarea,select")) continue;
              count++;
              const cs = getComputedStyle(child as Element);
              if (cs.visibility === "hidden" || cs.display === "none") continue;
              visit(child);
            }
          };
          visit(el);
          return out;
        };

        // <label for=X> 指向零尺寸(visually-hidden)表单控件时,label 是该控件的可见代理。
        // CSS-only 自定义 radio / Mantine Rating 星星把真 radio 设 0x0(被尺寸门跳过),
        // 用 label[for] 关联的可见星星承接点击;label 自身无文本/aria-label → require-name
        // 门挡掉 → 整控件 observe 隐形(2026-06-23 mantine.dev/core/rating dogfood)。
        // 从关联控件继承可及名(aria-label/value),让可见 label 通过门并显示语义名。
        // 限定 control 零尺寸:可见 control 自己召回,label 不代理(防双现)。
        function labelForHiddenControlName(el: Element): string {
          if (el.tagName !== "LABEL") return "";
          const forId = el.getAttribute("for");
          if (!forId) return "";
          const root = el.getRootNode() as Document | ShadowRoot;
          const ctrl =
            typeof (root as Document).getElementById === "function"
              ? (root as Document).getElementById(forId)
              : document.getElementById(forId);
          if (!ctrl) return "";
          const h = ctrl as HTMLElement;
          if (h.offsetWidth !== 0 || h.offsetHeight !== 0) return "";
          const input = h as HTMLInputElement;
          return normName(h.getAttribute("aria-label") || (input.type !== "password" && !isTextMasked(h) && !containsMaskedText(el) ? input.value : "") || "");
        }

        // tree 展开/折叠 switcher 识别(R25)——模块级 isTreeExpandToggle 同名,改一处须同步。
        // Hybrid:ARIA 门(带 aria-expanded 的 treeitem 内)+ curated 类(antd/rc-tree/element-plus,
        // 排除 noop/is-leaf 占位)+ 几何兜底(treeitem 内首个 ≤32×32 cursor:pointer 非 checkbox 图标)。
        // 命中者:① getAccessibleName 给 expand/collapse 名;② 豁免 cursor:pointer fallback 的跨池祖先
        // 短路(否则被祖先 treeitem ∈ ATOMIC 吞掉无独立 ref,纯 observe agent 无法展开)。
        const TREE_SWITCHER_CLASS_RE =
          /(?:^|[\s_-])(?:ant-tree-switcher|rc-tree-switcher|el-tree-node__expand-icon)(?:[\s_-]|$)/;
        const TREE_SWITCHER_NOOP_RE = /(?:switcher-noop|is-leaf)/;
        const treeElClass = (n: Element): string =>
          typeof n.className === "string" ? n.className : n.getAttribute("class") || "";
        const isTreeExpandToggle = (el: Element): boolean => {
          const treeitem = el.closest('[role="treeitem"]');
          if (!treeitem || !treeitem.hasAttribute("aria-expanded") || el === treeitem) return false;
          if (el.matches('[role="checkbox"],[role="radio"],input')) return false;
          for (let n: Element | null = el; n && n !== treeitem; n = n.parentElement) {
            const cls = treeElClass(n);
            if (TREE_SWITCHER_NOOP_RE.test(cls)) return false;
            if (TREE_SWITCHER_CLASS_RE.test(cls)) return true;
          }
          const r = el.getBoundingClientRect();
          if (getComputedStyle(el as HTMLElement).cursor !== "pointer" || r.width === 0 || r.width > 32 || r.height > 32)
            return false;
          const icons = Array.from(treeitem.querySelectorAll("*")).filter((c) => {
            if (c === el) return true;
            if (c.matches('[role="checkbox"],[role="radio"],input')) return false;
            const cr = c.getBoundingClientRect();
            return (
              getComputedStyle(c as HTMLElement).cursor === "pointer" &&
              cr.width > 0 &&
              cr.width <= 32 &&
              cr.height <= 32
            );
          });
          return icons.length > 0 && icons[0] === el;
        };
        function getAccessibleName(el: HTMLElement): string {
          // tree 展开 toggle:无文本 caret,按父 treeitem aria-expanded 给动作名(expand/collapse),
          // 否则落到下方图标/坐标兜底得 "caret-down"/坐标名(R25,agent 一眼识别是展开控件)。
          if (isTreeExpandToggle(el)) {
            const ti = el.closest('[role="treeitem"]');
            return ti?.getAttribute("aria-expanded") === "true" ? "collapse" : "expand";
          }
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
              if (label) parts.push(visibleTextContent(label));
            }
            if (parts.length) return normName(parts.join(" "));
          }
          // <label for=X> 代理零尺寸 control 时,可及名取自关联控件(见 helper 注释)。
          const __hiddenCtrlName = labelForHiddenControlName(el);
          if (__hiddenCtrlName) return __hiddenCtrlName;
          if (
            el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.tagName === "SELECT"
          ) {
            const id = el.id;
            if (id) {
              const lbl = document.querySelector(`label[for="${id}"]`);
              if (lbl) return normName(visibleTextContent(lbl));
            }
            // radio / checkbox 通常包在 <label> 里（Element Plus el-radio / el-checkbox 风格）
            const t = (el as HTMLInputElement).type;
            if (t === "radio" || t === "checkbox") {
              const wrapLabel = el.closest("label");
              if (wrapLabel) return normName(visibleTextContent(wrapLabel, true));
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
              const v = isTextMasked(el) ? "" : (el as HTMLInputElement).value;
              if (v) return normName(v);
              if (t === "submit") return "Submit";
              if (t === "reset") return "Reset";
              if (t === "image") return "Submit Query";
            }
            // <label> 包裹的 labelable 控件(无 id 关联、非 radio/checkbox/按钮):
            // 按 HTML <label> 语义,控件的可及名 = 包裹 label 的文本。手写表单极常见
            // (httpbin <label>Customer name: <input></label>),此前仅 radio/checkbox
            // 命中,text/email/tel/textarea 全落到下方 placeholder 兜底 → 空名。
            // 关键:AX 语义覆盖层仅施加于主 frame 0,iframe 子框(同源/跨域皆然)的
            // 此类控件只能靠本启发式命名——缺这一支会让所有 iframe 表单字段无名
            // (2026-06-22 跨域/iframe dogfood)。克隆 label 后剥除嵌套表单控件,避免
            // textarea 的当前文本 / <select> 的 option 文本拼接污染名(AI 噪声同理规避)。
            {
              const wrapLabel = el.closest("label");
              if (wrapLabel) {
                const txt = normName(visibleTextContent(wrapLabel, true));
                if (txt) return txt;
              }
            }
            // <select> 无包裹 label 时不落 textContent 兜底——select 的 textContent 是
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
            if (content) return normName(visibleTextContent(content));
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
              const labelText = normName(visibleTextContent(el));
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
              const val = containsMaskedText(el) ? "?" : inp.value || "?";
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
          const text = normName(visibleTextContent(el));
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
            setMarker(el, "data-vortex-rid", rid);
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
            // 反斜杠须先于引号转义(与下方 aria-label 路径一致)。漏转义反斜杠时,
            // data-testid 含 `\` 的元素(page 可控)会让 CSS 把 `\x` 当转义符 → 选择器
            // 错配(实测 `a\b` → 旧选择器匹配 0、去转义后若碰撞他元素则返回错误 ref =
            // silent wrong-target);CodeQL CWE-116 incomplete-escaping 捕获,2026-06-20。
            const testSel = `[${attr}="${testId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
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
            /** aria-level, tree/heading 层级数字 (0=outermost 合法值). N0002 B001. */
            level?: number;
            /** aria-autocomplete=list/both/none/inline, combobox 自动补全语义. R1 B003. */
            autocomplete?: "list" | "both" | "none" | "inline";
            /** aria-pressed=true, toggle button 标准状态. R1 B004. */
            pressed?: boolean;
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
            level?: number;
            autocomplete?: "list" | "both" | "none" | "inline";
            pressed?: boolean;
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
              // aria-pressed 不再合并到 [active](R1 B004):aria-pressed 是 toggle
              // button 标准状态(Bold/Italic/MUI ToggleButton),与 [active] 不同源
              // (active 来自 aria-activedescendant 虚拟焦点 + is-active 类,表达
              // "一组里当前激活的那个")。aria-pressed 在下方独立判为 [pressed]。
              if (cls.includes("is-active")) {
                s.active = true;
              }
            }
            // R1 B004: aria-pressed=true 独立标 [pressed](toggle button)。
            // 仅查自身(aria-pressed 按 ARIA 惯例落在角色元素自身),与 aria-checked
            // / aria-selected 同 i===0 门控。
            if (s.pressed === undefined && selfAria && cur.getAttribute("aria-pressed") === "true") {
              s.pressed = true;
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
          // R1 B003: aria-autocomplete=list/both/none/inline, combobox 自动补全
          // 语义。MUI Autocomplete / WAI-ARIA combobox pattern 必报字段——list=弹
          // listbox、both=inline+list、inline=inline 提示、none=无补全。仅取合法
          // token,其他值丢弃避免误导(2026-06-28 a11y 评测 R1)。
          const ariaAutocomplete = el.getAttribute("aria-autocomplete");
          if (ariaAutocomplete === "list" || ariaAutocomplete === "both" || ariaAutocomplete === "none" || ariaAutocomplete === "inline") {
            s.autocomplete = ariaAutocomplete;
          }
          // aria-level: tree/treeitem/heading 层级数字。CDP AX tree properties.level
          // 反映原生 ARIA 树深度。Element Plus / antd Tree 树形组件忘记在 DOM 上写
          // aria-level 时, observe 拿不到, agent 无法判断节点深度 + 多层缩进难分辨。
          // !isNaN 守护:非数字字符串("3.5"/"abc") 拒绝。0 是合法值(outermost),保留。
          // 仅查自身——aria-level 按 ARIA 惯例落在角色元素自身,上溯会把父级层数错配。
          const ariaLevel = el.getAttribute("aria-level");
          if (ariaLevel != null && ariaLevel !== "" && !isNaN(Number(ariaLevel))) {
            s.level = Number(ariaLevel);
          } else if (el.getAttribute("role") === "treeitem") {
            // N0002 B005: treeitem 嵌套深度 fallback。EP / antd Tree 在 DOM 上未写
            // aria-level, 但 group→treeitem 嵌套能反映层级。沿 [role=tree] 祖先上溯
            // 每穿过 [role=group] 累加 1。注入体内联:与模块级 inferTreeitemLevel 同步。
            let __lvl = 1;
            const __treeRoot = el.closest("[role=tree]");
            if (__treeRoot) {
              let __n = el.parentElement;
              while (__n && __n !== __treeRoot) {
                if (__n.getAttribute("role") === "group") __lvl++;
                __n = __n.parentElement;
              }
              s.level = __lvl;
            }
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
        // 内联副本:模块级 ariaComboboxValue 的同语义复刻(closure 注入无法 import)。
        // 语义与理由见模块级真源的 Javadoc,源码锁守护两处同步。
        function __ariaComboboxValue(
          role: string, tagName: string, visibleText: string,
        ): string | undefined {
          if (role !== "combobox") return undefined;
          const t = tagName.toUpperCase();
          if (t === "SELECT" || t === "INPUT" || t === "TEXTAREA") return undefined;
          const txt = visibleText.replace(/\s+/g, " ").trim();
          return txt ? txt.slice(0, 80) : undefined;
        }
        function getValueInfo(el: HTMLElement, role: string): string | undefined {
          const tag = el.tagName.toLowerCase();
          if (isTextMasked(el)) return undefined;
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
            const v = visibleTextContent(el, false, true);
            return v !== "" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
          }
          const isNativeValue =
            (tag === "input" && (inputType === "range" || inputType === "number")) ||
            tag === "progress" ||
            tag === "meter";
          // 非原生 ARIA combobox:显示文本即当前值。必须在 VALUE_ROLES 门之前——
          // combobox 不在该集合里,落到门上就直接 undefined。模块级真源
          // ariaComboboxValue 同语义(源码锁守护)。
          const __cbValue = __ariaComboboxValue(role, tag, visibleTextContent(el));
          if (__cbValue !== undefined) return __cbValue;
          if (!VALUE_ROLES.has(role) && !isNativeValue) return undefined;
          // N0002 B006: 同时返回 min/max 给 elements.valueMin / elements.valueMax,
          // 即便 valuetext 命中也输出 min/max(原逻辑只输出 valuetext 字符串, agent 丢范围)。
          // 优先 aria-valuetext(更人性化, 如 "中" / "$50"), fallback valuenow。
          // B006 修复: valuetext 不再短路 min/max 返回——三字段独立输出。
          const valueText = el.getAttribute("aria-valuetext");
          let now = el.getAttribute("aria-valuenow");
          let min = el.getAttribute("aria-valuemin");
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
            const mn = (el as HTMLInputElement | HTMLMeterElement).getAttribute("min");
            if (mn != null && mn !== "") min = mn;
          }
          if (now == null || now === "") return undefined;
          // 归一化空白(换行/制表 → 单空格)再截断,避免破坏单行输出;render 侧
          // 对含空格的值加引号。
          if (valueText) return valueText.replace(/\s+/g, " ").trim().slice(0, 40);
          // valueMin / valueMax 写全局, render 侧读 el.valueMin/valueMax
          // 注入体收集时另设 (N0002 B006): 在 collect 路径额外读 el.getAttribute("aria-valuemin/max")
          // 并赋给 elements.valueMin/valueMax, 不依赖 getValueInfo 返回结构。
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
          // 原生 <table> 容器已并入 INTERACTIVE_SELECTORS(Task 4):HTML-AAM 隐式映射
          // getRole <table> → "table" ∈ RECALL_ROLES,过召回门入池。此处只补行/列等
          // 内部 cell 结构与显式 row/cell/gridcell role(原生 tr/td/th 的 getRole 返
          // tag name 不在 RECALL_ROLES,无法过门,需 selector 直收;filter=all 时
          // 才用,普通观察不影响)。
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

        // 遮挡判定缺席要出声:注入快失败被吞掉时,整帧元素会静默翻成 visible:true
        let __hitOwnMissing = false;

        const nodeList = querySelectorAllDeep(ROOT_SELECTORS, scanRoot);

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
        for (const host of querySelectorAllDeep("[aria-activedescendant]", scanRoot)) {
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
        // Task 4 召回门:nodeList 中 [role] / 原生语义容器命中元素需过 passesRoleGate
        // (RECALL_ROLES 判据)才入池——presentation/none/generic 等装饰角色直接过滤。
        // 原生交互元素(a/button/input/select/textarea/summary/label:has(input))与
        // 启发式入口(tabindex≥0/contenteditable/onclick/draggable/listener marker)不
        // 命中 ROLE_GATE_TRIGGER_SELECTORS,直接入池(curosr:pointer fallback 路径同理)。
        const interactiveSet = new Set<Element>();
        for (const el of nodeList) {
          if (el.matches(ROLE_GATE_TRIGGER_SELECTORS) && !passesRoleGate(el)) continue;
          interactiveSet.add(el);
        }
        // Sweep all elements (Vue/React UI libs frequently use custom
        // tags like <el-button> / <a-link> / <van-cell> for interactive
        // widgets — bytenew testc 行操作 link is <el-button> not <div>),
        // skipping svg internals + non-rendered tags for perf. Shadow-
        // aware via querySelectorAllDeep so a button inside a custom
        // element's open shadow root is reachable through the
        // cursor:pointer fallback path too.
        const fallbackPool = querySelectorAllDeep(
          "*:not(svg *):not(script):not(style):not(meta):not(link):not(head):not(head *)",
          scanRoot,
        );
        // SVG 内部交互元素补集:上面 `:not(svg *)` 把 svg 后代整类排除(防装饰 path/g
        // 刷屏),但带交互信号的 svg 子元素(role/onclick/直绑 listener/可聚焦)是真控件——
        // recharts/d3 可点 rect·circle、draw.io/流程图形状、地图可点区域。无 role 仅靠
        // listener/cursor 信号的 svg 控件此前整类漏(2026-06-22 APG/recharts dogfood,
        // act 侧 SVG click 崩溃的 observe 对偶)。仅选带信号者控开销,仍走下方同一入池门
        // (cursor/framework/listener + require-name)过滤装饰。
        const svgInteractivePool = querySelectorAllDeep(
          `svg [role],svg [onclick],svg ${listenerSelector},svg [tabindex]:not([tabindex='-1'])`,
          scanRoot,
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
        // isFocusContainerOnly 内联副本——真源见 reasoning/aria-taxonomy.ts
        // (ARIA_ROLE_TAXONOMY + isContainerRole) + 导出函数 isFocusContainerOnly
        // (jsdom 单测锁)。inject func 注入丢模块作用域不能 import,改此处须同步
        // aria-taxonomy.ts + 源码锁测试守护(observe-focus-container-suppress.test.ts
        // 检 DERIVED_FROM_ARIA_TAXONOMY marker + 派生角色。判据:祖先 role ∈ 容器
        // 角色集 或 仅靠 tabindex 入池(非原子控件)→ 聚焦/浮层容器(Element UI
        // el-popover/el-dialog/el-drawer 自带 tabindex=0+role=tooltip|dialog),它不
        // 描述子树,下方跨池祖先短路不应因它跳过其 cursor:pointer 子项(N0064 D6
        // columnDisplay 9 列 bnCheck 全丢)。
        // DERIVED_FROM_ARIA_TAXONOMY
        const __ARIA_ROLE_TAXONOMY = {
          button:["widget"], checkbox:["widget"], link:["widget"], menuitem:["widget"],
          menuitemcheckbox:["widget"], menuitemradio:["widget"], option:["widget"],
          radio:["widget"], scrollbar:["widget"], searchbox:["widget"], slider:["widget","range"],
          spinbutton:["widget","range"], switch:["widget"], tab:["widget"], textbox:["widget"],
          treeitem:["widget"], gridcell:["widget"], columnheader:["widget"], rowheader:["widget"],
          combobox:["composite","widget"], grid:["composite"], listbox:["composite"],
          menu:["composite"], menubar:["composite"], radiogroup:["composite"],
          tablist:["composite"], tree:["composite"], treegrid:["composite"],
          group:["structure"], toolbar:["structure"], table:["structure"], tabpanel:["structure"],
          row:["structure"], rowgroup:["structure"], cell:["structure"], article:["structure"],
          list:["structure"], listitem:["structure"], feed:["structure"], figure:["structure"],
          separator:["structure"], tooltip:["structure"], note:["structure"], term:["structure"],
          definition:["structure"], directory:["structure"], document:["structure"],
          application:["structure"], caption:["structure"], blockquote:["structure"],
          banner:["landmark"], complementary:["landmark"], contentinfo:["landmark"],
          form:["landmark"], main:["landmark"], navigation:["landmark"], region:["landmark"],
          search:["landmark"],
          progressbar:["range"], meter:["range"],
          alert:["live"], log:["live"], marquee:["live"], status:["live"], timer:["live"],
          dialog:["window"], alertdialog:["window","live"],
        };
        const __CATEGORY_PRIORITY = ["composite","window","landmark","structure","live","range","widget"];
        const __CONTAINER_CATS = new Set(["composite","structure","landmark","window"]);
        const __isContainerRole = (role) => {
          const cats = __ARIA_ROLE_TAXONOMY[role];
          if (!cats) return false;
          let main;
          for (const c of __CATEGORY_PRIORITY) if (cats.includes(c)) { main = c; break; }
          return main != null && __CONTAINER_CATS.has(main);
        };
        // truncationRank 内联副本(真源:导出函数 truncationRank in observe.ts)。inject
        // closure 注入无法 import,改一处须同步。语义同源:rank 越小越优先保留,token 压力
        // 下 widget 必留,landmark/structure 先丢。未知 role 返默认 5,落到桶尾。
        const __truncationRank = (role) => {
          const cats = __ARIA_ROLE_TAXONOMY[role];
          if (!cats) return 5;
          let main;
          for (const c of __CATEGORY_PRIORITY) if (cats.includes(c)) { main = c; break; }
          switch (main) {
            case "widget": return 0;
            case "composite": return 1;
            case "range":
            case "live":
            case "window": return 2;
            case "structure": return 3;
            case "landmark": return 4;
            default: return 5;
          }
        };
        const FOCUS_CONTAINER_ROLES = new Set([
          ...Object.keys(__ARIA_ROLE_TAXONOMY).filter(__isContainerRole),
          "none", "presentation",
        ]);
        const ATOMIC_INTERACTIVE_SELECTORS =
          "button,a[href],summary,input:not([type=hidden]),select,textarea,label,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=treeitem],[role=option],[contenteditable],[onclick]";
        // 信号二 portal overlay「含交互后代」门专用(补 menuitemcheckbox/menuitemradio,Cascader/
        // 多选菜单弹层只含这两类 role)。模块级 OVERLAY_DESCENDANT_SELECTORS 同名,改一处须同步。
        const OVERLAY_DESCENDANT_SELECTORS =
          ATOMIC_INTERACTIVE_SELECTORS + ",[role=menuitemcheckbox],[role=menuitemradio]";
        const isFocusContainerOnly = (anc: Element): boolean => {
          const role = anc.getAttribute("role")?.trim().split(/\s+/)[0];
          if (role && FOCUS_CONTAINER_ROLES.has(role)) return true;
          return !anc.matches(ATOMIC_INTERACTIVE_SELECTORS);
        };
        for (const el of [...Array.from(fallbackPool), ...Array.from(svgInteractivePool)]) {
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
          // tree 展开 toggle 豁免:祖先 treeitem ∈ ATOMIC 本会短路吸收它,但 switcher 是独立动作
          // (点 title 仅选中、点 switcher 才展开),须 surface 成独立 ref(R25)。只在确有交互祖先
          // 时调用(限可展开 treeitem 内的 cursor:pointer 小图标子集),开销受控。
          if (hasInteractiveAncestor && !isTreeExpandToggle(el)) continue;
          const htmlEl = el as HTMLElement;
          // SVG 元素无 offsetWidth/offsetHeight(undefined),退回 getBoundingClientRect 测尺寸,
          // 否则 `undefined === 0` 恒 false 使零尺寸 svg defs/clip 漏过尺寸门。
          if (typeof htmlEl.offsetWidth === "number") {
            if (htmlEl.offsetWidth === 0 || htmlEl.offsetHeight === 0) continue;
          } else {
            const __r = el.getBoundingClientRect();
            if (__r.width === 0 || __r.height === 0) continue;
          }
          // 入池信号:cursor:pointer(常见但继承可疑)或框架确凿绑定的 onClick。
          // 后者更强,覆盖 cursor:auto 的 React/Vue 裸 div 按钮(2026-06-04 淘宝评价区
          // 真漏「查看全部评价」「切换大图模式」)。下游 require-name + 含交互后代/祖先
          // skip + 择叶 全部复用,噪声治理不变。
          if (getComputedStyle(htmlEl).cursor !== "pointer") {
            // 入池信号(cursor!=pointer 时):① framework onClick(React/Vue 委托,读
            // __reactProps$/_vei) ② data-vtx-listener(pre-scan CDP getEventListeners
            // 标记的纯 addEventListener 元素,vanilla/jQuery 直绑——见 observe-js-listener.ts)。
            // 二者并集:framework 覆盖委托型、listener 覆盖直绑型,互补无盲区(T3 discovery)。
            const __hasDirectListener = hasListenerMarker(el, "data-vtx-listener");
            // 投放区(drop target)入池信号:pre-scan CDP 标的 data-vtx-dropzone(见
            // observe-js-listener.ts)。body/html 排除——全局 file-drop 监听常绑在
            // 文档根,不该把整页当 drop 区。drop 区不是点击目标,渲染 [dropzone] 而非
            // [listener](透传见下方 entry 构造)。
            const __hasDropzone =
              hasListenerMarker(el, "data-vtx-dropzone") && el.tagName !== "BODY" && el.tagName !== "HTML";
            if (!hasFrameworkClick(el) && !__hasDirectListener && !__hasDropzone) continue;
            // framework onClick 常挂事件委托的**容器**层;若内部已有更细 cursor:pointer
            // 子项(如多个 SKU 选项),让位给子项各自入池——否则下方择叶因容器文字最长
            // 保留容器,把多真选项合并成一个不可操作大块(2026-06-04 淘宝 SKU 区回归)。
            // **direct listener / dropzone 不让位**:addEventListener / drop 监听绑在元素自身,
            // 它就是精确目标(非委托容器),不该让位给装饰性 pointer 子项。仅 framework 委托路径让位。
            if (!__hasDirectListener && !__hasDropzone) {
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
          // labelForHiddenControlName:<label for=零尺寸 control> 从关联控件继承名(同 getAccessibleName),
          // 让 Mantine Rating 等「可见 label 代理 0x0 radio」的星星过门(否则无名被 require-name 挡)。
          const probe = ariaProbe || textProbe || iconNameFromClass(el) || controlRoleFromClass(el) || labelForHiddenControlName(el);
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
        // isCompoundControlSelf 内联副本——真源见导出函数(可单测),inject func 注入丢
        // 模块作用域不能 import,改一处须同步另一处(源码锁守护)。原生 <a>/<button>/
        // <summary> 或交互 role 是单一复合控件,其 cursor:pointer 子是视觉部件非独立 CTA
        // (FullCalendar `<a.fc-event>` 的 .fc-event-time + .fc-event-title),不可当多 CTA
        // 容器拆分。多 CTA 真容器恒为非交互布局层(div/span/li)。
        const SINGLE_CONTROL_ROLES = new Set([
          "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
          "option", "tab", "treeitem", "checkbox", "radio", "switch",
        ]);
        const isCompoundControlSelf = (anc: Element): boolean => {
          const tag = anc.tagName;
          if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY") return true;
          const role = anc.getAttribute("role")?.trim().split(/\s+/)[0];
          return !!role && SINGLE_CONTROL_ROLES.has(role);
        };
        const isMultiCtaContainer = (anc: Element, kids: Element[]): boolean => {
          if (kids.length < 2) return false;
          // 原生交互祖先(单一复合控件)不拆分——其文本部件子(时间/标题/图标)非独立动作。
          if (isCompoundControlSelf(anc)) return false;
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

        let baseCandidates: Element[] = (() => {
          // 召回门接线:渲染候选池用过门的 interactiveSet(= nodeList ∩ passesRoleGate,
          // 保 DOM 序),不用未过门的原始 nodeList。Task 4 把选择器拓宽为裸 [role] 后,
          // presentation/none/generic/text/paragraph/heading 等非召回角色 + 无名
          // section/header 全进 nodeList;若此处展开 nodeList 则召回门被旁路、装饰角色
          // 泄漏进输出(youtube role=text "2.1万次观看" 回归,2026-06-29 APG live spike)。
          const raw: Element[] = [
            ...Array.from(interactiveSet),
            ...cursorPointerLeaves,
            ...iconCtaExtras,
          ];
          // tree 展开/折叠 toggle 排序(R25):cursorPointerLeaves 排在 nodeList 之后,密集树上
          // toggle 遭 maxElements 截断、与其 treeitem 远隔。把每个 toggle 重排到其 treeitem 紧后,
          // 二者随后续 overlay/main-content 分区同进退,toggle 与已召回的 treeitem 同框免截断。
          // 无 toggle → 原数组同序(零漂移)。
          const toggles: Element[] = [];
          const rest: Element[] = [];
          for (const el of raw) (isTreeExpandToggle(el) ? toggles : rest).push(el);
          if (toggles.length === 0) return raw;
          const byTreeitem = new Map<Element, Element[]>();
          for (const t of toggles) {
            const ti = t.closest('[role="treeitem"]');
            if (ti) {
              const arr = byTreeitem.get(ti) || [];
              arr.push(t);
              byTreeitem.set(ti, arr);
            }
          }
          const out: Element[] = [];
          for (const el of rest) {
            out.push(el);
            const ts = byTreeitem.get(el);
            if (ts) {
              out.push(...ts);
              byTreeitem.delete(el);
            }
          }
          for (const ts of byTreeitem.values()) out.push(...ts); // treeitem 未入候选的孤儿 toggle 兜底
          return out;
        })();

        // ── overlay-priority(DEFECT-1):可见浮层的交互后代前置,免遭 maxElements 截断 ──
        // Portal 弹层(下拉/菜单/Modal)挂 body 末尾,DOM 序排最后。密集页(交互元素
        // >maxElements)上按 DOM 序取前 N 会把刚打开、视口内的弹层选项整体截掉——agent
        // 「点开了却找不到选项」(ant.design Select dogfood 实证:782 候选,80 全是顶部
        // 导航,刚开的下拉 Jack/Lucy 被丢)。检测可见浮层根 → 把其内交互后代前置到候选
        // 最前。**无浮层时候选顺序零改动**(baseline 零漂移)。框架无关:ARIA 弹层语义
        // role + portal 定位双信号取并集。
        // ⚠ 内联副本:逻辑须与模块级 OVERLAY_POPUP_ROLES / isOverlayFloating /
        // partitionOverlayFirst 保持一致(observe-overlay-priority.test.ts 锁),改一处须同步。
        const OVERLAY_POPUP_ROLES = new Set([
          "dialog", "alertdialog", "listbox", "menu", "tree", "grid", "tooltip",
        ]);
        const isVisibleForOverlay = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const cs = getComputedStyle(el as HTMLElement);
          return cs.visibility !== "hidden" && cs.visibility !== "collapse" && cs.display !== "none";
        };
        // 浮层根须"脱离正常流"——自身或近祖先(到 body,≤6 跳)position:fixed/absolute。
        // 这把静态在流内的 role=grid/tree/listbox(ag-grid、文件树、常驻列表)排除在外,
        // 只前置真正的弹出层,保护 baseline 不漂移。
        const isFloatingOverlay = (el: Element): boolean => {
          let cur: Element | null = el;
          let hops = 0;
          while (cur && cur !== docBody && hops < 6) {
            const pos = getComputedStyle(cur as HTMLElement).position;
            if (pos === "fixed" || pos === "absolute") return true;
            cur = cur.parentElement;
            hops++;
          }
          return false;
        };
        // 持久导航菜单误判修复:role=menu/tree 的常驻结构(侧栏导航/常驻树)无触发器打开,
        // 不是临时弹层,却因常驻容器 position:fixed(粘性滚动)误过 isFloatingOverlay。
        // 真弹层由触发器(combobox/按钮)经 aria-controls/aria-owns 关联;无控制器即持久
        // 结构;在 nav landmark 内同样视为导航。listbox/dialog/tooltip 不在此列。
        const isPersistentMenu = (el: Element, role: string): boolean => {
          if (role !== "menu" && role !== "tree") return false;
          if (el.closest('nav,[role="navigation"]')) return true;
          const id = el.id;
          if (id && document.querySelector('[aria-controls~="' + id + '"],[aria-owns~="' + id + '"]')) return false;
          return true;
        };
        // 导航菜单根:role=menu/tree 侧栏导航,即便在 <main> 内、position static(ant.design
        // ant-menu-inline)也须从 main 层降权。判据=在 nav landmark 内,或菜单项 ≥5 且多数为
        // 跨页 <a href> 链接(把"被演示的 Menu 组件"排除)。模块级 isNavMenuRoot 同名,改一处须同步。
        const isNavMenuRoot = (el: Element, role: string): boolean => {
          if (role !== "menu" && role !== "tree") return false;
          if (el.closest('nav,[role="navigation"],[role="menubar"]')) return true;
          const items = el.querySelectorAll('[role="menuitem"],[role="treeitem"]');
          if (items.length < 5) return false;
          let links = 0;
          for (const it of Array.from(items)) {
            const a = it.matches("a[href]") ? it : it.querySelector("a[href]");
            const href = a?.getAttribute("href") ?? "";
            if (href.length > 1 && !href.startsWith("#")) links++;
          }
          return links >= items.length * 0.6;
        };
        const inNavMenu = (el: Element): boolean => {
          let cur: Element | null = el;
          while (cur && cur !== docBody) {
            const r = cur.getAttribute("role")?.trim().split(/\s+/)[0] ?? "";
            if ((r === "menu" || r === "tree") && isNavMenuRoot(cur, r)) return true;
            cur = cur.parentElement;
          }
          return false;
        };
        const overlayRoots: Element[] = [];
        // 信号一:ARIA 弹层语义 role + 脱流定位(穿 open shadow,与主扫描一致)。
        for (const el of querySelectorAllDeep("[role]", scanRoot)) {
          const role = el.getAttribute("role")?.trim().split(/\s+/)[0];
          if (!role || !OVERLAY_POPUP_ROLES.has(role)) continue;
          if (isVisibleForOverlay(el) && isFloatingOverlay(el) && !isPersistentMenu(el, role)) overlayRoots.push(el);
        }
        // 信号二:portal 弹层(脱流 + z-index 抬升 + 含交互后代),兜住无 ARIA 弹层 role 的
        // 自定义弹层(如 el-select popper)。扫描深度=body 直接子 + 直接子的直接子(body 孙):
        // rc-component(antd Cascader/Dropdown/Popover 等)经 rc-trigger 把真正定位(z 抬升)的弹层
        // 嵌在 body 直接子的 static 透明包裹层下一层,只扫 body 直接子会整层漏掉(2026-06-23
        // Cascader dogfood R24 实证)。「含交互后代」门用 OVERLAY_DESCENDANT_SELECTORS:在 ATOMIC
        // 基础上补 menuitemcheckbox/menuitemradio(Cascader/多选菜单弹层只含这两类 role,ATOMIC 漏),
        // 否则弹层因「无交互后代」被判装饰浮层而不前置。模块级 collectPortalOverlayRoots 同名,改一处须同步。
        if (docBody && !scopeEl) {
          const portalCands: Element[] = [];
          for (const child of Array.from(docBody.children)) {
            portalCands.push(child);
            for (const gc of Array.from(child.children)) portalCands.push(gc);
          }
          for (const el of portalCands) {
            if (overlayRoots.includes(el)) continue;
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.position !== "fixed" && cs.position !== "absolute") continue;
            const z = parseInt(cs.zIndex, 10);
            if (!(z > 0)) continue;
            if (!isVisibleForOverlay(el)) continue;
            if (!el.querySelector(OVERLAY_DESCENDANT_SELECTORS)) continue;
            overlayRoots.push(el);
          }
        }
        // ── 模态作用域(Modal Scoping,N002 T2-2)──
        // aria-modal=true 弹层打开时,ARIA 要求模态外内容视为 inert。默认裁剪 baseCandidates 到
        // 模态子树 + 发 # modal: meta;filter==='all' 时不裁剪、背景打 behindModal 标(Task 4)。
        // ⚠ inject func 第 5 形参名是 `filter`(非外层的 filterMode);误用 filterMode 会 ReferenceError。
        // ⚠ 内联副本:与模块级 selectActiveModal / scopeCandidatesToModal 同步(observe-modal-scope.test.ts 锁)。
        // 多信号 active modal 选择内联副本(与模块级 selectActiveModalLike 同步,源码锁守护)。
        // 分层优先级:aria-modal=true 是 ARIA 权威信号,优先于仅 role=dialog / 覆盖门的弱信号。
        // ① __activeStrictModal:aria-modal=true 的最后一个(嵌套对话框取顶层);
        // ② __activeLikeModal:isModalLikeOverlay 多信号的最后一个(兜底 antd 老 Dialog /
        //    Element Plus .el-overlay 罩层 / shadcn AlertDialog,默认无 aria-modal)。
        // 最终 __activeModal = strict ?? like —— 防真模态(aria-modal=true)被 DOM 序靠后、
        // 仅 role=dialog 的伪模态夺位、反遭裁剪抑制(2026-06-29 modal-scope bench live 实测)。
        let __activeModal: Element | null = null;
        let __activeStrictModal: Element | null = null;
        let __activeLikeModal: Element | null = null;
        for (const el of overlayRoots) {
          if (el.getAttribute("aria-modal") === "true") {
            __activeStrictModal = el;
            __activeLikeModal = el;
            continue;
          }
          const __role = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
          if (__role === "dialog" || __role === "alertdialog") {
            __activeLikeModal = el;
            continue;
          }
          const __r = el.getBoundingClientRect();
          if (__r.width >= innerWidth * 0.8 && __r.height >= innerHeight * 0.8) {
            __activeLikeModal = el;
          }
        }
        __activeModal = __activeStrictModal ?? __activeLikeModal;
        let __modalMeta: { name: string; role: string; suppressed: number } | null = null;
        // filter=all 逃生口:不裁剪,但记录模态根供元素装配时给背景打 behindModal 标。
        const __behindModalRoot: Element | null =
          __activeModal && filter === "all" ? __activeModal : null;
        if (__activeModal && filter !== "all") {
          const __mRoot = __activeModal;
          const __kept: Element[] = [];
          let __suppressed = 0;
          for (const el of baseCandidates) {
            if (el === __mRoot || __mRoot.contains(el)) __kept.push(el);
            else __suppressed++;
          }
          if (__suppressed > 0) {
            baseCandidates = __kept;
            const __nm = __mRoot.getAttribute("aria-label")
              || (__mRoot.getAttribute("aria-labelledby")
                  ? (() => { const label = document.getElementById(__mRoot.getAttribute("aria-labelledby")!); return label ? visibleTextContent(label) : ""; })()
                  : "")
              || "";
            __modalMeta = {
              name: String(__nm).trim().slice(0, 40),
              role: __mRoot.getAttribute("role") || "dialog",
              suppressed: __suppressed,
            };
          }
        }
        // R3 B010 修复: 真 modal 容器 (role=dialog aria-modal=true) 自身
        // 不在 INTERACTIVE_SELECTORS(只收 button/link/input 等),进不了
        // baseCandidates → modal-scope 裁剪/注入都对"已在 baseCandidates
        // 的元素"生效 → activeModal 自身在 observe 输出中**完全丢失**。
        // 修复:filter==="all" 时(背景元素已保留),把 __activeModal 显式
        // unshift 进 baseCandidates 头部。精准:仅真 modal 进,普通嵌套
        // dialog(无 aria-modal)不被识别为 activeModal,不受影响,避免污染。
        // dialog 自身不会被 [behind-modal] 标(它就是 __behindModalRoot)。
        if (filter === "all" && __activeModal && !baseCandidates.includes(__activeModal)) {
          baseCandidates = [__activeModal, ...baseCandidates];
        }
        const allCandidates: Element[] = ((): Element[] => {
          // 两层正交排序(组合 overlay-priority + main-content-priority):
          // ① 浮层(DEFECT-1):可见浮层内元素前置免遭截断;
          // ② 非浮层部分(A-1):内容区(<main>/[role=main]/#main-content)前置 + 导航区
          //    (<nav>/[role=navigation|menubar])降权。二者正交:组件库 demo 页常驻 ARIA 浮层
          //    (overlayRoots>0)时主内容仍须召回,故 main/nav 排序不能只在无浮层时跑。
          //    须与模块级 partitionOverlayFirst ∘ partitionMainContentFirst 同步。
          const inOverlay = (el: Element): boolean =>
            overlayRoots.length > 0 && overlayRoots.some((root) => root === el || root.contains(el));
          const overlayEls: Element[] = [];
          const nonOverlay: Element[] = [];
          for (const el of baseCandidates) (inOverlay(el) ? overlayEls : nonOverlay).push(el);
          const mainElA1 = document.querySelector("main") ?? document.querySelector('[role="main"]') ?? document.querySelector("#main-content");
          const isNavA1 = (el: Element): boolean =>
            !!el.closest('nav,[role="navigation"],[role="menubar"]');
          const a1Main: Element[] = [];
          const a1Mid: Element[] = [];
          const a1Nav: Element[] = [];
          for (const el of nonOverlay) {
            if (inNavMenu(el)) a1Nav.push(el);
            else if (mainElA1 && mainElA1.contains(el)) a1Main.push(el);
            else if (isNavA1(el)) a1Nav.push(el);
            else a1Mid.push(el);
          }
          // 零漂移:无浮层且主/导航未跨 ≥2 桶 → 原数组同序。
          const a1Buckets = (a1Main.length > 0 ? 1 : 0) + (a1Mid.length > 0 ? 1 : 0) + (a1Nav.length > 0 ? 1 : 0);
          if (overlayEls.length === 0 && a1Buckets <= 1) return baseCandidates;
          // Task 6 截断优先级:同桶内按 ARIA category rank 升序,token 压力下 widget 优先保留,
          // landmark/structure 先丢。同 rank 用原序稳定排序,不破坏桶间主序(overlay > main >
          // mid > nav)。role 推导走 inject 内联 getRole 真源(与导出 getRoleForTest 同义)。
          const sortByTruncationRank = (els: Element[]): Element[] => {
            return els
              .map((el, i) => ({ el, i, rank: __truncationRank(getRole(el)) }))
              .sort((a, b) => a.rank - b.rank || a.i - b.i)
              .map(({ el }) => el);
          };
          return [...sortByTruncationRank(overlayEls), ...sortByTruncationRank(a1Main), ...sortByTruncationRank(a1Mid), ...sortByTruncationRank(a1Nav)];
        })();

        const elements: Array<{
          index: number;
          tag: string;
          role: string;
          name: string;
          semanticSource?: "dom" | "heuristic";
          bbox: { x: number; y: number; w: number; h: number };
          visible: boolean;
          inViewport: boolean;
          occludedBy?: string;
          attrs: Record<string, string>;
          state?: { checked?: boolean; selected?: boolean; active?: boolean; disabled?: boolean; expanded?: boolean; required?: boolean; current?: boolean; invalid?: boolean; sort?: "ascending" | "descending" | "none"; haspopup?: string; level?: number };
          /** 值域控件当前值,如 "30" 或 "30/100"(getValueInfo 严格限定值域控件)。 */
          valueNow?: string;
          /** 同快照内 role+name 重名时的区分性祖先文本。@since dup-context */
          dupContext?: string;
          /** 最近的已收集祖先的 frame-local index；根节点 undefined。@since a11y-tree */
          parentIndex?: number;
          /** role=link 的 href，供 compact 树渲染 /url。@since a11y-tree */
          href?: string;
          _sel: string;
        }> = [];
        // a11y-tree: 与 elements 下标对齐的 DOM 元素引用数组，供二次遍历建树。
        const collectedEls: Element[] = [];

        // N0002 B004: candidate 遍历加 8s 时间预算。密集 SPA 单帧 4000+ 候选,后续
        // getBoundingClientRect/getComputedStyle/checkVisibility/elementFromPoint 累加
        // 主线程耗时 → Tab 卡顿 + 30s MCP 超时。早退保证 worst-case 也回,truncated 信号
        // 双门 (max 或 timeBudgetHit)。内联副本,与模块级 collectWithBudget 同步。
        const __t0 = performance.now();
        let __timeBudgetHit = false;
        for (const el of allCandidates) {
          if (Date.now() >= deadline) return null;
          if (elements.length >= max) break;
          if (performance.now() - __t0 > 8000) {
            __timeBudgetHit = true;
            break;
          }
          const htmlEl = el as HTMLElement;
          // N0002 B003:pre/code/samp/kbd 的 tabindex=0 仅用于聚焦滚动(dev 文档站
          // Prism/highlight.js/shiki 给代码块加 tabindex=0 让人能滚),不是交互控件。
          // 误入池会把 HTML 源码当可访问名、挤占 maxElements 截断预算把真控件挤掉
          // (Tailwind 首页实测 6 个 pre + truncated 80/120)。contenteditable 例外
          // (罕见的 Monaco/CodeMirror 把 pre 设为可编辑,保留为控件)。⚠ 内联实现:
          // 注入体丢模块作用域,不能调模块级 isReadonlyScrollTag(由该导出 + 单测守护同义)。
          const __roTag = htmlEl.tagName.toLowerCase();
          if (
            htmlEl.getAttribute("contenteditable") !== "true" &&
            (__roTag === "pre" || __roTag === "code" || __roTag === "samp" || __roTag === "kbd")
          ) {
            continue;
          }
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
            // 命中归属与 act 的门共用 classifyHit,自持拷贝必然分叉
            const hitOwn = (
              window as unknown as {
                __vortexDomResolve?: { classifyHit?: (el: Element, hit: Element | null) => { ok: boolean } };
              }
            ).__vortexDomResolve?.classifyHit;
            // 模块缺失时不猜:只读快照宁可不标遮挡也不放第二份判据
            if (!hitOwn && topEl) __hitOwnMissing = true;
            const own = hitOwn && topEl ? hitOwn(htmlEl, topEl) : undefined;
            if (own && !own.ok) {
              visible = false;
              occludedBy = describeElement(topEl!);
            }
          }

          const masked = isTextMasked(htmlEl);
          const root = htmlEl.getRootNode() as Document | ShadowRoot;
          const related = ["aria-labelledby", "aria-describedby", "aria-errormessage", "aria-owns"]
            .flatMap((key) => (htmlEl.getAttribute(key) ?? "").split(/\s+/).filter(Boolean))
            .map((id) => root.getElementById(id)).filter((el): el is HTMLElement => !!el);
          if (htmlEl instanceof HTMLInputElement || htmlEl instanceof HTMLTextAreaElement || htmlEl instanceof HTMLSelectElement) {
            related.push(...Array.from(htmlEl.labels ?? []));
          }
          const maskedContent = masked || containsMaskedText(htmlEl) || related.some(containsMaskedText);
          const attrs: Record<string, string> = {};
          for (const attrName of COLLECTED_ATTRS) {
            if (maskedContent && attrName === "value") continue;
            const v = htmlEl.getAttribute(attrName);
            if (v) attrs[attrName] = v.slice(0, 160);
          }

          // tree 展开/折叠 toggle(R25):role 强制 button(它是动作控件非装饰 img),name 走
          // getAccessibleName 的 expand/collapse 分支。treeToggle 标记透传给 applyOverlay,使
          // AX overlay 不把 role/name 改回 img/"caret-down"(CDP AX 视 caret 为 presentational)。
          const isTreeTog = isTreeExpandToggle(htmlEl);
          const roleSource: { value: "dom" | "heuristic" } = { value: "heuristic" };
          const domRole = getRole(htmlEl, roleSource);
          const role = isTreeTog ? "button" : withAX ? domRole : htmlEl.tagName.toLowerCase();
          const semanticSource = !isTreeTog && role === domRole ? roleSource.value : "heuristic";
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
            // contenteditable 宿主(显式 attribute 非 "false")是一等可编辑控件,
            // 语义等同 textarea —— 富文本编辑器(Quill/ProseMirror/Slate/Lexical)的
            // 可编辑体常是无 role/无 aria-label 的裸 div(Quill .ql-editor 即如此)。
            // 不豁免 require-name 门会被当噪声容器丢弃,agent observe 看不到编辑器、
            // 无法定位输入目标(2026-06-22 quilljs.com dogfood)。仅认显式 attribute
            // (非继承)避免把编辑器内继承可编辑的子节点也豁免。
            const ceAttr = htmlEl.getAttribute("contenteditable");
            const isEditableHost = ceAttr != null && ceAttr !== "false";
            const formLike =
              tag === "input" ||
              tag === "select" ||
              tag === "textarea" ||
              tag === "button" ||
              (tag === "a" && htmlEl.hasAttribute("href")) ||
              wrapsFormControl ||
              isEditableHost;
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
              setMarker(htmlEl, "data-vortex-react-clickable", "1");
              reactMarker = { reactClickable: true, clickHint: __vtxReactHint };
            }
          }
          // a11y-tree: 记引用，下标严格与 elements 对齐（此处是循环内最后一个
          // 可能 continue 之后、elements.push 之前的唯一 push 点）。
          collectedEls.push(htmlEl);
          const __href = role === "link" ? (htmlEl.getAttribute("href") || undefined) : undefined;
          // T5: date/time/file/range/number input 注入 compound 元数据,供 LLM fill 参考格式/约束
          const __inputCompound = buildInputCompound(htmlEl);
          // [inline detectBlindspot] — 真源 packages/extension/src/page-side/blindspot-detect.ts,
          // 改一处须改两处;tests/observe-blindspot-scan.test.ts 校验标记存在 + 纯函数行为对齐。
          let __vtxBlind: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low"; readback?: "component" | "screenshot" | "chart"; chartLib?: string } | null = null;
          {
            const __t = htmlEl.tagName.toLowerCase();
            if (__t === "canvas") {
              if (rect.width * rect.height >= 200 * 150) {
                if (htmlEl.getAttribute("data-zr-dom-id") !== null) {
                  __vtxBlind = { kind: "canvas", readback: "chart", chartLib: "echarts" };
                } else {
                  // ② G2/G2Plot:祖先 div(≤6 层)data-chart-source-type(图表库优先于框架)。
                  for (let __a: HTMLElement | null = htmlEl, __j = 0; __a && __j < 6 && !__vtxBlind; __j++, __a = __a.parentElement) {
                    const __cst = __a.getAttribute("data-chart-source-type");
                    if (__cst) __vtxBlind = { kind: "canvas", readback: "chart", chartLib: __cst.toLowerCase() };
                  }
                  // ③ Chart.js:全局 Chart.getChart(canvas) 命中本 canvas。
                  if (!__vtxBlind) {
                    const __Cj = (window as any).Chart;
                    if (__Cj && typeof __Cj.getChart === "function" && __Cj.getChart(htmlEl)) {
                      __vtxBlind = { kind: "canvas", readback: "chart", chartLib: "chartjs" };
                    }
                  }
                  // 框架驱动画布 → component。
                  if (!__vtxBlind) {
                    let __n: HTMLElement | null = htmlEl;
                    for (let __i = 0; __n && __i < 6; __i++, __n = __n.parentElement) {
                      if ((__n as any).__vue__ || (__n as any).__vue_app__) { __vtxBlind = { kind: "canvas", readback: "component" }; break; }
                      let __hit = false;
                      for (const __k of Object.keys(__n)) {
                        if (__k.indexOf("__reactFiber$") === 0 || __k.indexOf("__reactInternalInstance$") === 0) { __hit = true; break; }
                      }
                      if (__hit) { __vtxBlind = { kind: "canvas", readback: "component" }; break; }
                    }
                  }
                  if (!__vtxBlind) __vtxBlind = { kind: "canvas", readback: "screenshot" };
                }
              }
            } else if (["grid", "treegrid", "table", "listbox", "tree"].indexOf(role) >= 0) {
              const __rendered =
                role === "grid" || role === "treegrid" || role === "table"
                  ? htmlEl.querySelectorAll("[role=row]").length
                  : htmlEl.querySelectorAll("[role=option],[role=treeitem]").length;
              const __rc = parseInt(htmlEl.getAttribute("aria-rowcount") || "", 10);
              const __ss = parseInt(htmlEl.getAttribute("aria-setsize") || "", 10);
              const __decl = !isNaN(__rc) && __rc > 0 ? __rc : !isNaN(__ss) && __ss > 0 ? __ss : NaN;
              if (!isNaN(__decl) && __decl > __rendered && __decl >= Math.max(__rendered * 2, __rendered + 20))
                __vtxBlind = { kind: "virtual", total: __decl, rendered: __rendered };
            } else if (__t.indexOf("-") >= 0 && htmlEl.shadowRoot === null && htmlEl.childElementCount === 0) {
              if (rect.width >= 40 && rect.height >= 24) __vtxBlind = { kind: "shadow", confidence: "low" };
            }
          }
          elements.push({
            ...(maskedContent ? { maskedContent: true } : {}),
            index: elements.length,
            tag: htmlEl.tagName.toLowerCase(),
            role,
            semanticSource,
            // 类名噪声在**入池之后**才置空:放到 getAccessibleName 里会让这些元素被
            // require-name 门丢掉,召回下降。这里只去名字不去元素,ref 仍可定位。
            name: shouldDropClassName(name, role, visibleTextContent(htmlEl)) ? "" : name,
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
            // N0002 B006: slider/progressbar valuemin/max 独立字段。即 valuetext 命中也输出——
            // 原逻辑 valuetext 短路返回, agent 拿到 "0" 不知 min=0/max=100, 无法判断 "0" 含义。
            // 原生 range/number input 也走此字段(aria-valuenow 风格属性 HTML5 input 没,
            // 走 .min/.max IDL 属性)。
            ...(() => {
              const __vm = htmlEl.getAttribute("aria-valuemin");
              const __vM = htmlEl.getAttribute("aria-valuemax");
              const __vr: { valueMin?: string; valueMax?: string } = {};
              if (__vm != null && __vm !== "") __vr.valueMin = __vm;
              if (__vM != null && __vM !== "") __vr.valueMax = __vM;
              if (htmlEl.tagName === "INPUT" && (htmlEl as HTMLInputElement).type === "range") {
                const __ie = htmlEl as HTMLInputElement;
                if (!__vr.valueMin && __ie.min) __vr.valueMin = __ie.min;
                if (!__vr.valueMax && __ie.max) __vr.valueMax = __ie.max;
              }
              return Object.keys(__vr).length > 0 ? __vr : {};
            })(),
            // N0002 B010/B016: aria-keyshortcuts 显式键盘快捷键(空格分隔)。
            // Next.js / antd / Radix 文档站全 0, 但 LLM 已知 key shortcuts 时可提示用户
            // 减少发现成本。trim 后非空才写。
            ...(() => {
              const __ks = htmlEl.getAttribute("aria-keyshortcuts");
              if (__ks == null) return {};
              const __trim = __ks.trim();
              return __trim ? { keyshortcuts: __trim } : {};
            })(),
            ...(reactMarker
              ? { reactClickable: true as const, clickHint: reactMarker.clickHint }
              : {}),
            // T3 discovery: pre-scan CDP getEventListeners 标记的纯 addEventListener
            // 元素带 data-vtx-listener → 渲染 [listener] 真值信号(此处属性尚存,清理在后)。
            ...(hasListenerMarker(htmlEl, "data-vtx-listener") ? { listenerInteractive: true as const } : {}),
            // R6 B015 修复:aria-errormessage 关联文本(错误信息)。
            // AX 路径(observe-ax-overlay.ts computeAXOverlay)读 CDP relatedNodes.text,
            // 但 Chrome CDP 经常不填该字段(实测)→ out.errorMessage 空。
            // 修复:page-side 兜底,跟 aria-describedby / aria-controls 一样,
            // 拆 id list → document.getElementById 找元素 → 取 textContent。
            // AX 路径仍设 errorMessage(若 CDP 填了),本兜底仅在 AX 失败时兜底
            // (applyOverlay 250 行 `if (ov.errorMessage)` 跳过空值,保留 page-side 值)。
            ...(() => {
              const __em = htmlEl.getAttribute("aria-errormessage");
              if (!__em) return {};
              const __id = __em.split(/\s+/).filter(Boolean)[0];
              if (!__id) return {};
              const __el = document.getElementById(__id);
              const __txt = __el ? visibleTextContent(__el).replace(/\s+/g, " ").trim() : "";
              return __txt ? { errorMessage: __txt.slice(0, 200) } : {};
            })(),
            // 投放区:data-vtx-dropzone(drop/dragenter/dragover 监听)→ 渲染 [dropzone] 信号,
            // 与 [listener] 正交(同一元素可兼具)。body/html 排除全局 file-drop 误标。
            ...(hasListenerMarker(htmlEl, "data-vtx-dropzone") &&
            htmlEl.tagName !== "BODY" &&
            htmlEl.tagName !== "HTML"
              ? { dropzoneInteractive: true as const }
              : {}),
            // 拖拽源:显式 draggable="true" → 渲染 [draggable] 信号(vortex_drag 的 startRef 源,
            // 与 [dropzone] 正交)。用 getAttribute 精确匹配显式属性,与白名单 [draggable=true]
            // selector 一致;img/a 的隐式默认 draggable 不写 DOM 属性,getAttribute 返回 null
            // 故不会误标(2026-06-23 the-internet/drag_and_drop + SortableJS 评测)。
            ...(htmlEl.getAttribute("draggable") === "true"
              ? { draggableInteractive: true as const }
              : {}),
            // tree 展开/折叠 toggle(R25):透传给扩展侧 applyOverlay,跳过 AX role/name 覆盖。
            ...(isTreeTog ? { treeToggle: true as const } : {}),
            ...(__href !== undefined ? { href: __href } : {}),
            ...(__inputCompound !== undefined ? { compound: __inputCompound } : {}),
            ...(__vtxBlind ? { blindspot: __vtxBlind } : {}),
            // filter=all 逃生口:背景元素带 behindModal=true,渲染 [behind-modal] 提示。
            ...(__behindModalRoot && !(el === __behindModalRoot || __behindModalRoot.contains(el))
              ? { behindModal: true }
              : {}),
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
            if (Date.now() >= deadline) return null;
            let cur =
              collectedEls[i].parentElement ||
              (collectedEls[i].getRootNode() && collectedEls[i].getRootNode().host) ||
              null;
            while (cur) {
              if (Date.now() >= deadline) return null;
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

        // 重名消歧:同快照内 role+name 完全相同的元素,补一段能把它与同组其他成员
        // 区分开的祖先文本(渲染成 ctx=)。ref 本来就唯一,缺的是「该点哪一个」的语义
        // —— 日志实测 18.4% 元素重名且 90.6% 沿父链找不到区分信息,因为行内容是
        // 非交互文本、被 filter=interactive 滤掉(2026-08-11)。
        // 内联副本:模块级 pickDistinguishingContext 的同语义复刻,源码锁守护。
        {
          const __DUP_HOPS = 4;
          const __CTX_MAX = 60;
          function __pickDistinguishingContext(
            mineChain: string[], otherChains: string[][], ownName: string,
          ): string | undefined {
            if (otherChains.length === 0) return undefined;
            const nz = (s: string): string => (s ?? "").replace(/\s+/g, " ").trim();
            const strip = (s: string): string =>
              ownName ? nz(nz(s).split(nz(ownName)).join(" ")) : nz(s);
            for (let hop = 0; hop < mineChain.length; hop++) {
              const mine = nz(mineChain[hop] ?? "");
              if (!mine) continue;
              if (otherChains.some((c) => nz(c[hop] ?? "") === mine)) continue;
              const ctx = strip(mine);
              if (!ctx) continue;
              return ctx.slice(0, __CTX_MAX);
            }
            return undefined;
          }
          // 祖先文本:克隆后移除交互后代,避免同行兄弟按钮名混进上下文。
          // 克隆有成本,故只对重名成员算,且缓存同一祖先的结果。
          const __ancCache = new Map<Element, string>();
          const __ancText = (anc: Element): string => {
            const hit = __ancCache.get(anc);
            if (hit !== undefined) return hit;
            // 内联副本:模块级 ancestorContextText 同语义(源码锁守护)。元素边界补空格,
            // 否则 <td>A</td><td>B</td> 会拼成 "AB"(live 实测)。
            let out = "";
            try {
              const parts: string[] = [];
              const walk = (n: Node): void => {
                const kids = n.childNodes;
                for (let i = 0; i < kids.length; i++) {
                  if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
                  const c = kids[i];
                  if (c.nodeType === 3 && !maskedTextNode(c)) parts.push(c.nodeValue ?? "");
                  else if (c.nodeType === 1 && !(c as Element).matches("a[href],button,input,select,textarea,[role=button]")) { parts.push(" "); walk(c); parts.push(" "); }
                }
              };
              walk(anc);
              out = parts.join("").replace(/\s+/g, " ").trim().slice(0, 200);
            } catch {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              out = "";
            }
            __ancCache.set(anc, out);
            return out;
          };
          const __chainOf = (el: Element): string[] => {
            const chain: string[] = [];
            let cur = el === scopeEl ? null : el.parentElement
              || ((el.getRootNode() as ShadowRoot | Document) as ShadowRoot).host
              || null;
            while (cur && chain.length < __DUP_HOPS) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              chain.push(__ancText(cur));
              if (cur === scopeEl) break;
              cur = cur.parentElement
                || ((cur.getRootNode() as ShadowRoot | Document) as ShadowRoot).host
                || null;
            }
            return chain;
          };
          // VXE 固定列行上下文(2026-11-09 计划第3步):固定列里的操作按钮在 DOM 上是
          // 独立片段(fixed-left / fixed-right / body 三份 tbody),祖先链里只有固定列自己
          // 的单元格文本 —— 每行一个「详情」时沿父链分不开。这里用同一 VxeTable 实例的
          // rowid 把固定列行关联回主表体行,取该行可见文本作 ctx。
          // 铁律:身份 / 唯一性 / 可见性任一证不出 → 显式降级标记,不按顺序或文本猜;
          // 组件内部数据(fullData / getRowid)只用于身份判定,不进输出。
          const __VXE_UNAVAILABLE = "[row-context-unavailable]";
          const __vxeKeyOf = (inst: any, row: any): string | null => {
            try {
              const k = inst.getRowid(row);
              return k === null || k === undefined ? null : String(k);
            } catch {
              return null;
            }
          };
          // 完整当前平面行集合 → key 计数表。getRowid 算不出 key → null(证不出唯一性)。
          const __vxeKeyIndex = new Map<any, Map<string, number> | null>();
          const __vxeIndex = (inst: any): Map<string, number> | null => {
            const cached = __vxeKeyIndex.get(inst);
            if (cached !== undefined) return cached;
            let map: Map<string, number> | null = null;
            try {
              const data = inst.getTableData();
              const full = data?.fullData;
              if (Array.isArray(full)) {
                map = new Map<string, number>();
                for (const row of full) {
                  if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
                  const k = __vxeKeyOf(inst, row);
                  if (k === null) { map = null; break; }
                  map.set(k, (map.get(k) ?? 0) + 1);
                }
              }
            } catch {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              map = null;
            }
            __vxeKeyIndex.set(inst, map);
            return map;
          };
          const __vxeIsTable = (inst: any): boolean =>
            !!inst
            && String(inst?.$options?.name ?? "").toLowerCase().replace(/-/g, "") === "vxetable"
            && typeof inst.getTableData === "function"
            && typeof inst.getRowid === "function";
          // 所属 VxeTable 实例:最近的带 __vue__ 的祖先(Vue2 组件根元素带 __vue__)。
          // 真实 VXE 层级里最近的 __vue__ 通常是 body 组件(VxeTableBody),VxeTable 实例
          // 在 $parent 链上 —— 不能因「最近的 __vue__ 不是 VxeTable」就判定证不出实例。
          // 证不出实例、但祖先有 vxe-* 类名 → vxeLike(只用于打降级标记)。
          const __vxeTableOf = (inst: any): any => {
            let cur = inst;
            for (let i = 0; cur && i < 32; i++) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              if (__vxeIsTable(cur)) return cur;
              cur = cur.$parent;
            }
            return null;
          };
          // 本表根(.vxe-table):内嵌表的关联边界 —— 到这里还证不出实例就不许认领外表。
          const __vxeParent = (el: Element): Element | null => el === scopeEl ? null : el.parentElement;
          const __vxeClosest = (el: Element | null, selector: string): Element | null => {
            while (el) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              if (el.matches(selector)) return el;
              el = __vxeParent(el);
            }
            return null;
          };
          const __vxeTableRoot = (el: Element): Element | null => __vxeClosest(el, ".vxe-table");
          // Vue 3 production 保存组件树在应用容器的 _vnode,而非 DOM 的 __vue__。
          // 只在应用容器位于观察范围内时检查组件树;表根必须与组件 DOM 完全相同。
          const __vxeVue3Indexes = new Map<Element, Map<Element, any> | null>();
          const __vxeVue3Table = (root: Element): any => {
            let app: Element | null = root;
            while (app && !(app as any).__vue_app__) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              app = __vxeParent(app);
            }
            if (!app) return null;
            let index = __vxeVue3Indexes.get(app);
            if (index === undefined) {
              index = new Map<Element, any>();
              const pending = [(app as any)._vnode];
              const seen = new Set<any>();
              while (pending.length) {
                if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
                const vnode = pending.pop();
                if (!vnode || typeof vnode !== "object" || seen.has(vnode)) continue;
                seen.add(vnode);
                if (seen.size > 20000) { index = null; break; }
                const component = vnode.component;
                if (component) {
                  const element = component.subTree?.el;
                  const instance = component.proxy;
                  if (element?.nodeType === 1 && vnode.el === element && __vxeIsTable(instance)) {
                    index.set(element, index.has(element) ? null : instance);
                  }
                  pending.push(component.subTree);
                }
                if (Array.isArray(vnode.children)) pending.push(...vnode.children);
                if (vnode.suspense?.activeBranch) pending.push(vnode.suspense.activeBranch);
              }
              __vxeVue3Indexes.set(app, index);
            }
            return index?.get(root) ?? null;
          };
          // 归属校验:实例须由本表根提供;只有更外层表认得它 → 串表,拒绝认领。
          const __vxeOwnedBy = (inst: any, root: Element): boolean => {
            let a: Element | null = root;
            while (a) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              const vu = (a as any).__vue__;
              if (vu && __vxeTableOf(vu) === inst) return a === root;
              a = __vxeParent(a);
            }
            return true;   // 证不出归属 → 不拦
          };
          const __vxeScope = (el: Element): { root: Element | null; inst: any | null; vxeLike: boolean; boundary: Element | null } => {
            const boundary = __vxeTableRoot(el);
            let p: Element | null = el;
            let vxeLike = false;
            let inst: any | null = null;
            while (p) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              const vu = (p as any).__vue__;
              // 最近的一个能证出表的实例说了算;但不走到底 —— vxeLike 要看完整条祖先链。
              if (vu && !inst) {
                const t = __vxeTableOf(vu);
                if (t) inst = t;
              }
              if (!vxeLike && p.classList) {
                for (const c of Array.from(p.classList)) {
                  if (c.startsWith("vxe-table")) { vxeLike = true; break; }
                }
              }
              p = __vxeParent(p);
            }
            // 串表防护:实例若只有外层表认得(内嵌表缺 __vue__)→ 不许认领,降级。
            if (inst && boundary && !__vxeOwnedBy(inst, boundary)) inst = null;
            const vue3 = !inst && boundary ? __vxeVue3Table(boundary) : null;
            if (vue3) return vue3.treeConfig
              ? { root: null, inst: null, vxeLike: true, boundary }
              : { root: boundary, inst: vue3, vxeLike: true, boundary };
            if (!inst) return { root: null, inst: null, vxeLike, boundary };
            const tc = inst.treeConfig;
            // 树表:行不是平面的,扁平集合证明不了唯一性 → 降级。
            if (tc) return { root: null, inst: null, vxeLike: true, boundary };
            // 作用域根:带同一实例的最近祖先元素(VXE 表格根容器,含固定列各片段)。
            let root: Element | null = null;
            let q: Element | null = el;
            while (q) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              if ((q as any).__vue__ === inst) { root = q; break; }
              q = __vxeParent(q);
            }
            if (!root && inst.$el && inst.$el.nodeType === 1 && (!scopeEl || scopeEl.contains(inst.$el))) root = inst.$el as Element;
            return { root, inst, vxeLike: true, boundary };
          };
          // overflow 容器(内容可能被裁掉)。jsdom 未设置时计算值是 ""(按「未设置」处理),
          // 简写 overflow:hidden 不会拆到 overflowX/Y,三者都看。
          const __vxeOverflow = (el: Element): boolean => {
            const cs = getComputedStyle(el);
            const cut = (v: string): boolean => !!v && v !== "visible";
            return cut(cs.overflow) || cut(cs.overflowX) || cut(cs.overflowY);
          };
          // 可见性须检查 scope 外的祖先,但身份关联仍使用受 scope 限制的 __vxeParent。
          const __vxeVisualParent = (el: Element): Element | null =>
            el.assignedSlot || el.parentElement || ((el.getRootNode() as ShadowRoot | Document) as ShadowRoot).host || null;
          // 逐层检查全部 overflow 裁剪祖先:内层没裁到不算,外层裁到就算。
          const __vxeClipped = (el: Element, rect: DOMRect, hasRange: boolean): boolean => {
            let p: Element | null = el;
            const seen = new Set<Element>();
            while (p) {
              if (seen.has(p)) return true;
              seen.add(p);
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              if (__vxeOverflow(p)) {
                const pr = p.getBoundingClientRect();
                const box = p as HTMLElement;
                let scale = 1;
                if (hasRange) {
                  const ancestors = new Set<Element>();
                  for (let a: Element | null = p; a; a = __vxeVisualParent(a)) {
                    if (ancestors.has(a)) return true;
                    ancestors.add(a);
                    if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
                    const style = getComputedStyle(a);
                    const zoom = style.zoom && style.zoom !== "normal" ? Number(style.zoom) : 1;
                    if (!Number.isFinite(zoom) || zoom <= 0) return true;
                    scale *= zoom;
                    if ((style.scale && style.scale !== "none" && style.scale !== "1")
                      || (style.rotate && style.rotate !== "none" && style.rotate !== "0deg")
                      || (style.perspective && style.perspective !== "none")) return true;
                    if (style.transform && style.transform !== "none") {
                      const m = new DOMMatrixReadOnly(style.transform);
                      if (!m.is2D || m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) return true;
                    }
                  }
                }
                // 无边框和占位滚动条时直接用精确边框盒;否则内缩整数 client* 的舍入误差。
                const clipStyle = getComputedStyle(p);
                const exactX = !hasRange || (parseFloat(clipStyle.borderLeftWidth) === 0 && parseFloat(clipStyle.borderRightWidth) === 0 && box.offsetWidth === box.clientWidth);
                const exactY = !hasRange || (parseFloat(clipStyle.borderTopWidth) === 0 && parseFloat(clipStyle.borderBottomWidth) === 0 && box.offsetHeight === box.clientHeight);
                const left = pr.left + (exactX ? 0 : (box.clientLeft + 1) * scale);
                const top = pr.top + (exactY ? 0 : (box.clientTop + 1) * scale);
                const width = exactX ? pr.width : (box.clientWidth - 2) * scale;
                const height = exactY ? pr.height : (box.clientHeight - 2) * scale;
                if (width <= 0 || height <= 0 || rect.left < left || rect.right > left + width
                  || rect.top < top || rect.bottom > top + height) return true;
              }
              p = __vxeVisualParent(p);
            }
            return hasRange && (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight);
          };
          // 可见性:排除 display:none / visibility:hidden / hidden / 折叠 details /
          // 被 overflow 裁出盒子的文本。不用整行 textContent —— 那会把隐藏字段一起带出。
          // 状态性不可见:display:none / visibility:hidden / hidden 属性 / 折叠 details。
          const __vxeStateHidden = (el: Element): boolean => {
            if (el.hasAttribute("hidden")) return true;
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0") return true;
            const det = __vxeClosest(el, "details");
            // 折叠的 details 只有 summary 可见;details 容器自身照常下钻,逐个子节点判。
            if (det && !(det as HTMLDetailsElement).open && el !== det) {
              const sum = det.querySelector("summary");
              if (!sum || !(sum === el || sum.contains(el))) return true;
            }
            return false;
          };
          // 形状裁剪(clip-path / CSS mask / 旧 clip):这些属性不走 overflow 几何,
          // 只看 overflow 会漏出已被完全裁掉/遮掉的文本。形状边界无法证明 → 该文本不输出。
          const __vxeShapeClipped = (cs: CSSStyleDeclaration): boolean =>
            (!!cs.clipPath && cs.clipPath !== "none")
            || (!!cs.maskImage && cs.maskImage !== "none")
            || (!!cs.webkitMaskImage && cs.webkitMaskImage !== "none")
            || (!!cs.clip && cs.clip !== "auto");
          // 按文本片段检查几何位置,不能因为宽行被裁剪就丢弃整行。
          const __vxeTextVisible = (text: Node, parent: Element): boolean => {
            if (maskedTextNode(text)) return false;
            const det = __vxeClosest(parent, "details");
            if (det && !(det as HTMLDetailsElement).open) {
              const sum = det.querySelector("summary");
              if (!(sum && (sum === parent || sum.contains(parent)))) return false;
            }
            let p: Element | null = parent;
            const seen = new Set<Element>();
            while (p) {
              if (seen.has(p)) return false;
              seen.add(p);
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              const cs = getComputedStyle(p);
              if (p.hasAttribute("hidden") || cs.display === "none" || cs.visibility === "hidden"
                || cs.visibility === "collapse" || cs.opacity === "0") return false;
              // scope 外的折叠 details 不扫描其子树,无法证明文本可见时省略。
              if (scopeEl && p !== scopeEl && !scopeEl.contains(p)
                && p.tagName === "DETAILS" && !(p as HTMLDetailsElement).open) return false;
              if (cs.textOverflow === "ellipsis" && __vxeOverflow(p)
                && ((p as HTMLElement).clientWidth <= 0 || (p as HTMLElement).scrollWidth > (p as HTMLElement).clientWidth)) return false;
              // 自身或祖先上的 clip-path / mask 同样裁掉文本:形状裁剪无法用几何证明可见。
              if (__vxeShapeClipped(cs)) return false;
              p = __vxeVisualParent(p);
            }
            const range = document.createRange();
            range.selectNodeContents(text);
            // jsdom 无 Range 布局,回退父盒供定向测试使用。
            const hasRange = typeof range.getBoundingClientRect === "function";
            const rect = hasRange ? range.getBoundingClientRect() : parent.getBoundingClientRect();
            if (!rect.width || !rect.height) return false;
            if (!hasRange && __vxeOverflow(parent) && !(parent as HTMLElement).clientWidth) return false;
            return !__vxeClipped(parent, rect, hasRange);
          };
          // 候选片段的任一祖先状态性不可见 → 整个片段内容不得输出(整块 display:none 的固定列片段)。
          // 只看状态,不看祖先的裁剪:祖先盒子被裁不等于片段不可见(片段可能落在可见区域内)。
          const __vxeAncestorHidden = (el: Element): boolean => {
            let p = __vxeParent(el);
            while (p) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              if (__vxeStateHidden(p)) return true;
              p = __vxeParent(p);
            }
            return false;
          };
          const __vxeText = (root: Element, skip: Element | null): string => {
            if (__vxeStateHidden(root) || __vxeAncestorHidden(root)) return "";
            const rowTable = __vxeClosest(root, "table");
            let out = "";
            const walk = (node: Node): void => {
              if (out.length > 200) return;
              for (const child of Array.from(node.childNodes)) {
                if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
                if (child.nodeType === 3) {
                  const p = node as Element;
                  if (p.nodeType === 1 && !__vxeTextVisible(child, p)) continue;
                  out += child.nodeValue || "";
                  continue;
                }
                if (child.nodeType !== 1) continue;
                const cel = child as Element;
                if (skip && cel === skip) continue;
                const tag = cel.tagName;
                if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") continue;
                // 嵌套表(内含另一个 VXE 实例)的文本不并入外层行上下文。
                if (__vxeClosest(cel, "table") !== rowTable) continue;
                if (__vxeStateHidden(cel)) continue;
                out += " ";
                walk(cel);
              }
            };
            walk(root);
            return out.replace(/\s+/g, " ").trim();
          };
          // body wrapper 里的嵌套普通表不属于 VXE 行片段,即使 rowid 相同。
          const __vxeFragmentRow = (row: Element): boolean => {
            const table = __vxeClosest(row, "table");
            const wrapper = __vxeClosest(table, ".vxe-table--body-wrapper");
            if (!table || !wrapper) return false;
            const outerTable = __vxeClosest(__vxeParent(table), "table");
            return !outerTable || !wrapper.contains(outerTable);
          };
          // 所属表的行:只认本表根(.vxe-table)之内的 tr —— 不许跨到外层表的行。
          const __vxeRowOf = (el: Element, scope: { boundary: Element | null }): Element | null => {
            let p: Element | null = el;
            while (p) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              if (p.tagName === "TR") return p;
              if (p === scope.boundary) return null;
              p = __vxeParent(p);
            }
            return null;
          };
          const __vxeRowContext = (el: Element): { text?: string; unavailable: boolean } => {
            const scope = __vxeScope(el);
            // 非 VXE 表 → 不属本特性范围,交回旧祖先回退。
            if (!scope.vxeLike) return { unavailable: false };
            const tr = __vxeRowOf(el, scope);
            // 不在行里(VXE 工具栏等)→ 不是行身份失败,保留原有祖先上下文。
            if (!tr) return { unavailable: false };
            const key = tr.getAttribute("rowid");
            if (!__vxeFragmentRow(tr) || !scope.inst || !scope.root || key === null || key === "") {
              return { unavailable: true };
            }
            // 唯一性:完整平面行集合里该 key 只对应一条 → 才允许关联。
            const index = __vxeIndex(scope.inst);
            if (!index || index.get(key) !== 1) return { unavailable: true };
            const parts: string[] = [];
            for (const cand of Array.from(scope.root.querySelectorAll("tr[rowid]"))) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              if (cand.getAttribute("rowid") !== key || !__vxeFragmentRow(cand)) continue;
              if (__vxeScope(cand).inst !== scope.inst) continue;   // 必须同一实例,嵌套表不混
              const t = __vxeText(cand, el);
              if (t) parts.push(t);
            }
            const text = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
            return text ? { text, unavailable: false } : { unavailable: true };
          };
          const __groups = new Map<string, number[]>();
          for (let i = 0; i < elements.length; i++) {
            if (Date.now() >= deadline) return null;
            const nm = (elements[i].name ?? "").replace(/\s+/g, " ").trim();
            if (!nm) continue;
            const k = `${elements[i].role} ${nm}`;
            const g = __groups.get(k);
            if (g) g.push(i); else __groups.set(k, [i]);
          }
          for (const idxs of __groups.values()) {
            if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
            if (idxs.length < 2) continue;
            const chains = idxs.map((i) => __chainOf(collectedEls[i]));
            for (let a = 0; a < idxs.length; a++) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              const i = idxs[a];
              // 行上下文(能证明身份时)优先:祖先链在固定列表格里只有固定列自己的文本。
              const vxe = __vxeRowContext(collectedEls[i]);
              // 身份不可关联 → 显式降级标记优先,不回退祖先链(回退会把隐藏字段带出来)。
              if (vxe.unavailable) { elements[i].dupContext = __VXE_UNAVAILABLE; continue; }
              if (vxe.text) { elements[i].dupContext = vxe.text; continue; }
              const ctx = __pickDistinguishingContext(
                chains[a], chains.filter((_, b) => b !== a), elements[i].name ?? "",
              );
              if (ctx) elements[i].dupContext = ctx;
            }
          }
        }

        // N0002 B008 + B009:aria-controls / aria-owns 关联。
        //  - B008: 拆 id list, 在 collectedEls 中找下标, 填 elements[i].controls = [{index:N}, ...]。
        //  - B009: 找不到下标时, 用 {id:"ghost"} 字符串, agent 至少看到关联 id 可 querySelector 找。
        //   原因: aria-controls 常指向 region / tabpanel / listbox 容器, 这些是非 interactive
        //   元素不在 collectedEls (filter=interactive 跳过, filter=all 也只多收表格行)。
        //   旧逻辑 idxList 空 → 字段不写, 静默丢关联。
        //  - aria-owns 同支持(popover / listbox 父级)。
        //  - 多 id space-separated 顺序保留, 去重同下标(同 id 重复 + controls+owns 合并)。
        {
          const __idSet = new Set<string>();
          for (let i = 0; i < collectedEls.length; i++) {
            if (Date.now() >= deadline) return null;
            const __el = collectedEls[i];
            const __controlsAttr = __el.getAttribute("aria-controls");
            const __ownsAttr = __el.getAttribute("aria-owns");
            const __allIds: string[] = [];
            if (__controlsAttr) __allIds.push(...__controlsAttr.split(/\s+/).filter(Boolean));
            if (__ownsAttr) __allIds.push(...__ownsAttr.split(/\s+/).filter(Boolean));
            if (__allIds.length === 0) continue;
            const __ctrlList: Array<{ id?: string; index?: number }> = [];
            const __seenIdx = new Set<number>();
            const __seenId = new Set<string>();
            for (const __id of __allIds) {
              if (Date.now() >= deadline) return null;
              if (__idSet.has(__id) || __seenId.has(__id)) continue;
              // 在 collectedEls 中通过 id 找。注意 id 必须唯一(id-uniqueness 已在
              // observe-id-uniqueness.test.ts 锁),若重复取第一个。
              let __found = -1;
              for (let j = 0; j < collectedEls.length; j++) {
                if (Date.now() >= deadline) return null;
                if (collectedEls[j].id === __id) { __found = j; break; }
              }
              if (__found >= 0 && !__seenIdx.has(__found)) {
                __ctrlList.push({ index: __found });
                __seenIdx.add(__found);
              } else if (__found < 0) {
                // B009: 目标不在 collectedEls(非 interactive region / tabpanel / listbox),
                // 仍记 id 字符串, agent 至少看到关联。
                __ctrlList.push({ id: __id });
              }
              __seenId.add(__id);
            }
            if (__ctrlList.length > 0) elements[i].controls = __ctrlList;
          }
        }

        // Ownership check and each write stay in this synchronous page operation.
        // A delayed frameIds scan in a replacement document must never claim ownership.
        const ownsAX = () => {
          const owner = (document as any).__vortexAXOwner;
          return !!axRequest && owner?.epoch === axRequest.epoch && owner.highWater === axRequest.order &&
            owner.owner === axRequest.token && owner.deadline === axRequest.deadline && Date.now() < owner.deadline;
        };
        let axStamped = false;
        if (ownsAX()) {
          setMarker(document.documentElement, "data-vtx-frame-ax", axRequest!.token);
          for (let i = 0; i < collectedEls.length; i++) {
            if (!ownsAX()) break;
            setMarker(collectedEls[i], "data-vtx-ax", `${axRequest!.token}:${i}`);
          }
          axStamped = ownsAX();
        }

        // [inline detectBlindspot:virtual] 虚拟列表专扫:role=grid/listbox 等容器
        // 常不被 elements 收集(rows 成顶层根),故独立 querySelectorAllDeep 一遍,
        // 产出 frame 级 blindspots → 渲染 # blindspots: meta(不依赖元素收集)。
        // canvas/shadow 走 per-element 内联标注(若被收集);未被收集的 chart canvas 由下方
        // [inline detectChartCanvas] 页级扫描兜底(dedup 防双报)。
        const pageBlindspots: Array<
          | { kind: "virtual"; total: number; rendered: number; name: string; confidence?: "low" }
          | { kind: "canvas"; name: string; chartLib: string; readback: "chart" }
          | { kind: "image"; name: string; src: string }
          | { kind: "sheet"; name: string; lib: "lakesheet"; rows: number; cols: number }
          | { kind: "occlusion"; name: string }
        > = [];
        if (__hitOwnMissing) {
          pageBlindspots.push({ kind: "occlusion", name: "hit-ownership" });
        }
        {
          const __vc = querySelectorAllDeep("[role=grid],[role=treegrid],[role=table],[role=listbox],[role=tree]", scanRoot);
          for (const c of __vc) {
            if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
            const __cr = (c.getAttribute("role") || "").toLowerCase();
            const __rendered =
              __cr === "grid" || __cr === "treegrid" || __cr === "table"
                ? c.querySelectorAll("[role=row]").length
                : c.querySelectorAll("[role=option],[role=treeitem]").length;
            const __rc = parseInt(c.getAttribute("aria-rowcount") || "", 10);
            const __ss = parseInt(c.getAttribute("aria-setsize") || "", 10);
            const __decl = !isNaN(__rc) && __rc > 0 ? __rc : !isNaN(__ss) && __ss > 0 ? __ss : NaN;
            if (!isNaN(__decl) && __decl > __rendered && __decl >= Math.max(__rendered * 2, __rendered + 20)) {
              const __nm = c.getAttribute("aria-label") || c.getAttribute("aria-labelledby") || __cr;
              pageBlindspots.push({ kind: "virtual", total: __decl, rendered: __rendered, name: String(__nm).slice(0, 40) });
            }
          }
          // [inline detectVirtualByScroll] A2-fb 非 ARIA 声明虚拟化(Semi/Naive/react-window)。
          // 真源 blindspot-detect.ts detectVirtualByScroll,改一处须改两处。
          // 强滚动(scrollH≥clientH×4) + estTotal(scrollH/rowH)>>渲染数(虚拟本质:只渲染窗口)。
          const __seenScrollers = new Set();
          const __cands = querySelectorAllDeep("table,[role=grid],[role=listbox],[role=tree],ul,ol", scanRoot);
          for (const cand of __cands) {
            if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
            if (cand.hasAttribute("aria-rowcount") || cand.hasAttribute("aria-setsize")) continue; // ARIA 路径已处理
            const __rows = cand.querySelectorAll("[role=row],tr,li");
            const __rendered = __rows.length;
            if (__rendered < 3) continue;
            const __rowH = __rows[0].getBoundingClientRect().height;
            if (__rowH < 4) continue;
            // 找最近的滚动祖先(overflow-y auto/scroll 且 scrollHeight>clientHeight)
            let __scroller = null;
            let __cur = cand;
            for (let i = 0; i < 6 && __cur; i++) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              const __oy = getComputedStyle(__cur).overflowY;
              if ((__oy === "auto" || __oy === "scroll") && __cur.scrollHeight > __cur.clientHeight) {
                __scroller = __cur;
                break;
              }
              if (__cur === scopeEl) break;
              __cur = __cur.parentElement;
            }
            if (!__scroller || __seenScrollers.has(__scroller)) continue;
            const __sh = __scroller.scrollHeight;
            const __ch = __scroller.clientHeight;
            if (__ch <= 0 || __sh < __ch * 4) continue;
            // 误报闸:真虚拟列表的滚动祖先只含视口窗口的行(≈__rendered);若祖先 DOM
            // 行数远多于本候选渲染数,说明 __sh 来自祖先里其它真实内容(整片导航侧栏含
            // 多个列表),__est 把整片高度误当本列表的行 → 误报。MDN CSS 参考 aside 含
            // 1249 项,某 6 项小列表被估成 303(scrollH 9692/rowH 32)实证。
            const __scrollerRows = __scroller.querySelectorAll("[role=row],tr,li").length;
            if (__scrollerRows > __rendered * 2) continue;
            // 页面级滚动容器(body/html/main/scrollingElement 或近视口高)的 scrollHeight 反映
            // 整页内容而非该列表,est 会把整页高度误当列表行数(react-aria docs props 表 37 行
            // 全渲染却因滚动祖先是 <main> 被误报 ~186/37,2026-06-22 dogfood)。仅对有界专用
            // 滚动视口启用本估算启发式;页面级 window-scroller 虚拟列表通常设 aria-rowcount。
            const __pageLevel =
              __scroller === document.scrollingElement ||
              __scroller === document.body ||
              __scroller === document.documentElement ||
              __scroller.tagName === "MAIN" ||
              __scroller.getAttribute("role") === "main" ||
              __ch >= window.innerHeight * 0.9;
            if (__pageLevel) continue;
            const __est = Math.round(__sh / __rowH);
            if (__est > __rendered && __est >= Math.max(__rendered * 2, __rendered + 20)) {
              __seenScrollers.add(__scroller);
              const __nm = cand.getAttribute("aria-label") || (cand.getAttribute("role") || cand.tagName.toLowerCase());
              pageBlindspots.push({ kind: "virtual", total: __est, rendered: __rendered, name: String(__nm).slice(0, 40), confidence: "low" });
            }
          }
          // [inline detectDivVirtualScroller] A2-fb-div 纯 div 虚拟列表(react-window/react-virtuoso/
          // PrimeReact VirtualScroller:容器与行都无 table/ul/[role] 语义,上面语义路径整类漏扫)。
          // 真源 blindspot-detect.ts detectDivVirtualScroller,改一处须改两处。
          // 强滚动 div 容器 + 内部 ≥3 高度成簇重复子项 + estTotal>>渲染。廉价 scrollHeight 门先于 getComputedStyle。
          // 成簇用中位数 band[median×0.6,1.6] 替代严格等高:容纳 react-virtuoso 等变高虚拟列表(逐项测量行高不一)。
          for (const __sc of querySelectorAllDeep("div", scanRoot)) {
            if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
            if (__seenScrollers.has(__sc)) continue;
            const __sh2 = (__sc as HTMLElement).scrollHeight;
            const __ch2 = (__sc as HTMLElement).clientHeight;
            if (__ch2 <= 0 || __sh2 < __ch2 * 4) continue; // 廉价强滚动门
            const __oy2 = getComputedStyle(__sc as HTMLElement).overflowY;
            if (__oy2 !== "auto" && __oy2 !== "scroll") continue; // 确认裁剪滚动
            let __divRows = 0;
            let __divRowH = 0;
            for (const __w of Array.from((__sc as HTMLElement).querySelectorAll("div"))) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              const __kids = Array.from(__w.children);
              if (__kids.length < 3) continue;
              const __heights = __kids.map((n) => {
                if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
                return n.getBoundingClientRect().height;
              });
              const __sorted = [...__heights].sort((a, b) => a - b);
              const __median = __sorted[Math.floor(__sorted.length / 2)];
              if (__median < 4) continue;
              const __inBand = __heights.filter((h) => h >= __median * 0.6 && h <= __median * 1.6).length;
              if (__inBand >= 3 && __inBand >= __kids.length * 0.7 && __inBand > __divRows) {
                __divRows = __inBand;
                __divRowH = __median;
              }
            }
            if (__divRows < 3) continue;
            const __dRendered = __divRows;
            const __dRowH = __divRowH;
            const __dEst = Math.round(__sh2 / __dRowH);
            if (__dEst > __dRendered && __dEst >= Math.max(__dRendered * 2, __dRendered + 20)) {
              __seenScrollers.add(__sc);
              const __dnm = (__sc as HTMLElement).getAttribute("aria-label") || "list";
              pageBlindspots.push({ kind: "virtual", total: __dEst, rendered: __dRendered, name: String(__dnm).slice(0, 40), confidence: "low" });
            }
          }
          // [inline detectChartCanvas] 图表 canvas 页级扫描:图表 canvas 常不被收集为交互
          // 元素(ECharts 在 srcdoc 子 frame / 主 frame 非交互 canvas),独立扫一遍产 frame
          // 级条目。真源 blindspot-detect.ts detectChartCanvas,改一处须改两处。识别库:
          // echarts(data-zr-dom-id)/ G2(祖先 data-chart-source-type)/ Chart.js(Chart.getChart)。
          for (const __cv of querySelectorAllDeep("canvas", scanRoot)) {
            if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
            const __cvEl = __cv as HTMLElement;
            let __clib: string | null = null;
            if (__cvEl.getAttribute("data-zr-dom-id") !== null) {
              __clib = "echarts";
            } else {
              for (let __a: HTMLElement | null = __cvEl, __j = 0; __a && __j < 6 && !__clib; __j++, __a = __a.parentElement) {
                const __cst = __a.getAttribute("data-chart-source-type");
                if (__cst) __clib = __cst.toLowerCase();
              }
              if (!__clib) {
                const __Cj = (window as any).Chart;
                if (__Cj && typeof __Cj.getChart === "function" && __Cj.getChart(__cvEl)) __clib = "chartjs";
              }
            }
            if (!__clib) continue;                                        // 非已知图表库 canvas
            const __cr = __cvEl.getBoundingClientRect();
            if (__cr.width * __cr.height < 200 * 150) continue;          // 尺寸门(排装饰 sparkline)
            if (collectedEls.indexOf(__cv as Element) >= 0) continue;     // dedup:已 per-element 收集不双报
            const __cnm =
              __cvEl.getAttribute("aria-label") ||
              __cvEl.getAttribute("title") ||
              "chart";
            pageBlindspots.push({ kind: "canvas", name: String(__cnm).slice(0, 40), chartLib: __clib, readback: "chart" });
          }
          // [inline detectImageBlindspot] 无 alt 内容图页级扫描:无 alt 图不被 observe 收集为
          // 元素(⑨ 实证空树),独立扫一遍产 frame 级条目。真源 blindspot-detect.ts
          // detectImageBlindspot,改一处须改两处。排除:有意义 alt / alt=""(装饰)/ aria-label/
          // title / aria-hidden / role=presentation / 图标级小图(<80)。
          for (const __im of querySelectorAllDeep("img", scanRoot)) {
            if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
            const __imEl = __im as HTMLElement;
            const __altV = (__imEl.getAttribute("alt") || "").trim();
            if (__altV) continue;                                          // 有意义 alt → 可读
            if (__imEl.hasAttribute("alt")) continue;                      // alt="" 显式装饰
            if ((__imEl.getAttribute("aria-label") || "").trim()) continue;
            if ((__imEl.getAttribute("title") || "").trim()) continue;
            if (__imEl.getAttribute("aria-hidden") === "true" || __imEl.getAttribute("role") === "presentation") continue;
            const __ir = __imEl.getBoundingClientRect();
            if (__ir.width < 80 || __ir.height < 80) continue;             // 内容尺寸门(排图标)
            if (collectedEls.indexOf(__im as Element) >= 0) continue;      // dedup
            const __isrc =
              (__imEl as HTMLImageElement).currentSrc ||
              (__imEl as HTMLImageElement).src ||
              __imEl.getAttribute("src") ||
              "";
            const __inm = __imEl.getAttribute("aria-labelledby") || "image";
            pageBlindspots.push({ kind: "image", name: String(__inm).slice(0, 40), src: String(__isrc).slice(0, 300) });
          }
          // [inline detectLakeSheet] 语雀 Lake Sheet 帧级盲区:cell 在 canvas,observe 空树。
          // 真源 blindspot-detect.ts detectLakeSheet,改一处须改两处。逐字对齐定位 + 维度读:
          // .lake-sheet-canvas-container/.lake-sheet-editor → __reactFiber → memoizedState.sheet.model.data。
          // 每 frame 至多 push 一处(若内核存在)。
          if (pageBlindspots.every((__bs) => __bs.kind !== "sheet")) {
            const __lsContainer = querySelectorAllDeep(".lake-sheet-canvas-container,.lake-sheet-editor", scanRoot)[0];
            if (__lsContainer) {
              const __lsFk = Object.keys(__lsContainer as any).find(
                (__k) => __k.startsWith("__reactInternalInstance") || __k.startsWith("__reactFiber"),
              );
              if (__lsFk) {
                let __lsFiber: any = (__lsContainer as any)[__lsFk];
                let __lsDepth = 0;
                while (__lsFiber && __lsDepth < 40) {
                  const __lsSt = __lsFiber.memoizedState;
                  if (__lsSt && __lsSt.sheet && __lsSt.sheet.model && __lsSt.sheet.model.data) {
                    const __lsD = __lsSt.sheet.model.data;
                    const __lsRows = typeof __lsD.rowCount === "number" ? __lsD.rowCount : 0;
                    const __lsCols = typeof __lsD.colCount === "number" ? __lsD.colCount : 0;
                    pageBlindspots.push({ kind: "sheet", name: "lakesheet", lib: "lakesheet", rows: __lsRows, cols: __lsCols });
                    break;
                  }
                  __lsFiber = __lsFiber.return;
                  __lsDepth++;
                }
              }
            }
          }
        }

        // [inline detectBlankShell] 真源 packages/extension/src/page-side/blindspot-detect.ts
        // detectBlankShell,改一处须改两处。空壳 SPA/渲染失败感知:framework 在场(F4 仅框架名)
        // + document complete + 存在挂载点 + 所有存在挂载点都空壳(近空 root 且 root 内无交互后代)。
        // 用后代包含(__rt.contains(__c)&&__rt!==__c)判 root 内有无交互内容,天然排除 html/body
        // 祖先噪声 + root 容器自身(F2:g2.antv 给 body 挂 cursor:pointer 致被收集,裸计数击穿);
        // F3:任一挂载点已渲染即不报(防 #root 空 portal + #app 已渲染误判)。
        let __blankShell: { root: string; rootLen: number; framework: string } | undefined;
        if (!scopeEl && document.readyState === "complete") {
          let __fw = "";
          if ((window as any).React !== undefined) __fw = "react";
          else if ((window as any).Vue !== undefined) __fw = "vue";
          else if ((window as any).__NEXT_DATA__ !== undefined) __fw = "next";
          else if (typeof (window as any).g_history !== "undefined" || (window as any).g !== undefined) __fw = "umi";
          else {
            for (const __s of Array.from(document.scripts)) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              if (/(?:umi|react|vue|angular|svelte|next|nuxt)/i.test((__s as HTMLScriptElement).src || "")) { __fw = "script-chunk"; break; }
            }
          }
          if (__fw) {
            const __mounts = ["#root", "#app", "#__next", "[data-reactroot]"];
            const __mountEls = __mounts.map((__s) => document.querySelector(__s)).filter(Boolean) as Element[];
            const __html = document.documentElement, __body = document.body;
            // 页级门(F1/F2):排除 html/body + 挂载容器自身后仍有交互元素 → 已渲染(内容在非标准容器
            // 或 open shadow 内,collectedEls 穿 shadow 故此处计入),不报。排 html/body 保 g2 FN 修复。
            const __hasContent = collectedEls.some((__c) => __c !== __html && __c !== __body && __mountEls.indexOf(__c) < 0);
            // 视觉门(F3):canvas/video 类应用无交互 DOM 但已渲染,面积门与 canvas 盲区一致。
            let __hasVisual = false;
            for (const __v of Array.from(document.querySelectorAll("canvas, video"))) {
              if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
              const __vr = (__v as Element).getBoundingClientRect();
              if (__vr.width * __vr.height > 200 * 150) { __hasVisual = true; break; }
            }
            if (!__hasContent && !__hasVisual) {
              let __blank: { sel: string; len: number } | null = null;
              for (const __sel of __mounts) {
                if (Date.now() >= deadline) __vtxFail("TIMEOUT", "Observe deadline expired");
                const __rt = document.querySelector(__sel);
                if (!__rt) continue;
                const __len = __rt.innerHTML.trim().length;
                // deepContains 穿 open shadow(contains 不穿,collectedEls 含 shadow 内元素)
                const __hasInner = collectedEls.some((__c) => {
                  let __cur: any = __c;
                  while (__cur) { if (__cur === __rt) return __rt !== __c; __cur = __cur.parentNode || __cur.host || null; }
                  return false;
                });
                if (__len >= 64 || __hasInner) { __blank = null; break; } // 某挂载点已渲染 → 不报(F4 取舍)
                if (!__blank) __blank = { sel: __sel, len: __len };
              }
              if (__blank) __blankShell = { root: __blank.sel, rootLen: __blank.len, framework: __fw };
            }
          }
        }

        if (Date.now() >= deadline || scanInvalid || !ownsScan()) return null;
        if (paginationToken) {
          const item = (window as any).__vortexPageSnapshots[paginationToken];
          if (!item || item.document !== document || item.captureToken !== scanRequest.token || !ownsScan()) return null;
          item.nodes = collectedEls;
          item.validate = (index: number, selector: string, includeControls = false, ignoreTargetValue = false) => {
            const node = item.nodes[index] as Element | undefined;
            const valid = item.check(includeControls, ignoreTargetValue ? node : undefined);
            if (!valid || Date.now() > item.expiresAt || item.document !== document || !node?.isConnected || node.ownerDocument !== document) return null;
            const matches = querySelectorAllDeep(selector, document, 0, Date.now() + 200);
            return matches.length === 1 && matches[0] === node ? node : null;
          };
          const records = item.state.observer.takeRecords();
          if (item.relevant(records)) item.state.changed = true;
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
          axStamped,
          candidateCount: allCandidates.length,
          ...(paginationToken && (window as any).__vortexPageSnapshots[paginationToken].exceeded ? { monitorBudgetExceeded: true } : {}),
          // N0002 B004: truncated 双门 — max 截断 OR 时间预算命中。Agent 据此判断是
          // 正常 maxElements 限制还是大页性能降级,前者调小参数即可、后者需换 query 通道。
          truncated: elements.length >= max || __timeBudgetHit,
          blindspots: pageBlindspots,
          ...(__modalMeta ? { modal: __modalMeta } : {}),
          ...(__blankShell ? { blankShell: __blankShell } : {}),
          ...(scopeError ? { scopeError } : {}),
        };
      },
      args: [maxElements, viewport, includeText, includeAX, filterMode, scopeSelector, scopePagination, paginationToken, deadline, scanRequest,
        listenerRequests.find((request) => request.frameId === frameId && request.documentId === target.documentId) ?? null, axRequest],
      world: "MAIN",
    });
    if (results.length !== 1 || results[0].documentId !== scanRequest.documentId || results[0].frameId !== frameId) return null;
    const page = (results[0]?.result as FramePageResult | undefined) ?? null;
    if (page?.axStamped && axRequest && results.length === 1 && results[0].documentId === axRequest.documentId && results[0].frameId === frameId) {
      page.axIdentity = axRequest;
    }
    return page;
  } catch (err) {
    // 跨源 iframe 无权限 / frame 已销毁：不 throw，返回 null 让上层标记为未扫
    console.warn(`[vortex.scanOneFrame] failed fid=${frameId} err=`, err);
    if (/cannot access contents|permission|access denied/i.test(String(err))) onPermissionDenied();
    return null;
  }
}

/**
 * 跨 frame **扫描阶段**总预算。
 *
 * 传输层默认 30s,但扫描之后还有 AX overlay / 全局 index 组装 / marker 清理,真实重站
 * 上这些要好几秒且不受此预算约束——2026-08-11 live(gamma.app,1 个 srcdoc iframe)
 * 实测:预算 25s 时扫描刚好吃满,叠加后续阶段仍越过 30s,调用方照旧见 "no response" 丑错。
 *
 * 取舍:20s 意味着日志中 20-28s 才成功的那 ~5% 重站调用会转为降级(带部分结果 +
 * `# degraded` 说明),换掉的是零结果且提示误导的传输超时。按「优雅降级优先」定 20s。
 */
const SCAN_TOTAL_BUDGET_MS = 20_000;
/**
 * 单 frame 下限。低于此值宁可不设界——重站单 frame 扫描实测 13% 超过 8s(最慢 28s
 * 仍成功),固定小上限会把正常调用误判成降级。
 */
const FRAME_SCAN_MIN_TIMEOUT_MS = 8_000;
/**
 * AX 覆盖层上限。跑在扫描预算之外,失败可优雅回退纯启发式(role/name 退化但不缺元素),
 * 故宁可掐断也不让它顶穿 30s 传输超时。
 */
const AX_OVERLAY_TIMEOUT_MS = 6_000;
/** listener discovery 上限。失败即整页 [listener] 信号丢失,必须上报而非静默吞掉。 */
const LISTENER_DISCOVERY_TIMEOUT_MS = 8_000;
/** Claim/recovery must leave time for healthy frames to scan. */
const SCAN_CLAIM_TIMEOUT_MS = 1_000;

/**
 * 单 frame 超时 = 剩余预算按剩余 frame 数均摊,但不低于下限。
 * 单 frame 场景即等于整个剩余预算(不误伤慢站);多 frame 场景保证一个卡死的 frame
 * 不会吃光预算导致其余 frame 全被跳过。
 */
export function frameScanTimeout(remainingBudgetMs: number, remainingFrames: number): number {
  const share = remainingBudgetMs / Math.max(1, remainingFrames);
  return Math.min(remainingBudgetMs, Math.max(FRAME_SCAN_MIN_TIMEOUT_MS, share));
}

interface ScanEntry {
  request?: ScanRequest;
  frameId: number;
  url: string;
  parentFrameId: number;
  offset: { x: number; y: number };
  page: FramePageResult | null;
  axAvailable?: boolean;
  scanError?: "permission-denied";
}

/** 跨两轮扫描(主循环 + auto-fallback)共享的预算与降级归因。 */
interface ScanBudget {
  startedAt: number;
  timedOutFrames: number[];
  budgetSkippedFrames: number[];
}

/**
 * 按预算扫描一批 frame:单 frame 超时则跳过并记录,总预算耗尽则不再尝试剩余 frame。
 * 无论降级与否都返回等长的 ScanEntry(page=null 表示未扫到),由调用方汇总。
 */
async function scanFramesWithBudget(
  tabId: number,
  targets: FrameTarget[],
  budget: ScanBudget,
  scanArgs: {
    maxElements: number;
    viewport: "visible" | "full";
    includeText: boolean;
    includeAX: boolean;
    filterMode: "interactive" | "all";
    /** 目标局部观察的 scope 选择器;null/缺省 = 整页。@since target-scope */
    scopeSelector?: string | null;
    scopePagination?: { snapshotId: string; nodeIndex: number } | null;
    paginationToken?: string | null;
    track: <T>(promise: Promise<T>) => Promise<T>;
    axRequests: AXRequest[];
    listenerRequests: ListenerRequest[];
    scanRequests: ScanRequest[];
  },
): Promise<ScanEntry[]> {
  const out: ScanEntry[] = [];
  for (let i = 0; i < targets.length; i++) {
    const f = targets[i];
    const base = { frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId,
      request: scanArgs.scanRequests.find((request) => request.frameId === f.frameId && request.documentId === f.documentId) };
    const remaining = SCAN_TOTAL_BUDGET_MS - (Date.now() - budget.startedAt);
    if (remaining <= 0) {
      budget.budgetSkippedFrames.push(f.frameId);
      out.push({ ...base, offset: { x: 0, y: 0 }, page: null });
      continue;
    }
    const perFrame = frameScanTimeout(remaining, targets.length - i);
    const offsetR = await raceTimeout(getIframeOffset(tabId, f.frameId), perFrame);
    const offset = offsetR === TIMED_OUT ? { x: 0, y: 0 } : offsetR;
    // offset 与 scan 串行,必须重算剩余——否则单个 frame 最坏吃掉 2×perFrame,
    // 整体远超总预算(单测抓不到:stub 的 offset 恒秒回)
    const afterOffset = SCAN_TOTAL_BUDGET_MS - (Date.now() - budget.startedAt);
    if (afterOffset <= 0) {
      budget.timedOutFrames.push(f.frameId);
      out.push({ ...base, offset, page: null });
      continue;
    }
    let permissionDenied = false;
    const pageR = await raceTimeout(
      scanArgs.track(scanOneFrame(
        tabId,
        f,
        scanArgs.maxElements,
        scanArgs.viewport,
        scanArgs.includeText,
        scanArgs.includeAX,
        scanArgs.filterMode,
        scanArgs.scopeSelector ?? null,
        scanArgs.scopePagination ?? null,
        scanArgs.paginationToken ?? null,
        budget.startedAt + SCAN_TOTAL_BUDGET_MS,
        () => { permissionDenied = true; },
        scanArgs.axRequests,
        scanArgs.listenerRequests,
        scanArgs.scanRequests,
        scanArgs.track,
      )),
      Math.min(perFrame, afterOffset),
    );
    if (pageR === TIMED_OUT) {
      budget.timedOutFrames.push(f.frameId);
      out.push({ ...base, offset, page: null });
      continue;
    }
    if (pageR === null) {
      console.warn(`[vortex.observe] scanOneFrame null fid=${f.frameId} url=${f.url}`);
    }
    out.push({ ...base, offset, page: pageR, ...(permissionDenied ? { scanError: "permission-denied" as const } : {}) });
  }
  return out;
}

/** 目标局部观察的 scope:只扫该容器及其后代。 */
interface ObserveScope {
  /** 页面内唯一定位 scope 容器的选择器。 */
  selector: string;
  /** scope 所在 frame。 */
  frameId: number;
  pagination?: { snapshotId: string; nodeIndex: number };
}

/**
 * 解析 observe 的 scope 参数(目标局部观察)。
 *
 * - CSS selector(`selector` 或 `target`):scope 落在 explicitFrameId ?? 主 frame。
 * - 旧 ref(`index` + `snapshotId`):走 resolveTarget 的既有语义取出元素选择器,
 *   并按快照绑定的 tab/frame 校验 —— 跨 tab/frame 的 ref 一律报错,
 *   绝不静默改成另一个目标(过期快照由 resolveTarget 报 STALE_SNAPSHOT)。
 */
function resolveObserveScope(
  args: Record<string, unknown>,
  tabId: number,
  explicitFrameId: number | undefined,
): ObserveScope | undefined {
  const index = args.index as number | undefined;
  const selectorArg =
    typeof args.selector === "string" && args.selector !== ""
      ? args.selector
      : typeof args.target === "string" && args.target !== ""
        ? args.target
        : undefined;
  if (index === undefined) {
    if (!selectorArg) return undefined;
    if (selectorArg.startsWith("@")) {
      throw vtxError(
        VtxErrorCode.INVALID_PARAMS,
        `observe target "${selectorArg}" is a ref: resolve it to index + snapshotId before calling observe`,
      );
    }
    return { selector: selectorArg, frameId: explicitFrameId ?? 0 };
  }
  if (selectorArg) {
    throw vtxError(
      VtxErrorCode.INVALID_PARAMS,
      "observe accepts either a selector or index + snapshotId, not both",
    );
  }
  const resolved = resolveTarget({
    index,
    snapshotId: args.snapshotId as string | undefined,
  }, true);
  if (resolved.boundTabId != null && resolved.boundTabId !== tabId) {
    throw vtxError(
      VtxErrorCode.STALE_SNAPSHOT,
      `Ref is bound to tab ${resolved.boundTabId}, but this observe targets tab ${tabId} (re-run observe on the target tab)`,
    );
  }
  const boundFrameId = resolved.boundFrameId ?? 0;
  if (explicitFrameId != null && explicitFrameId !== boundFrameId) {
    throw vtxError(
      VtxErrorCode.STALE_SNAPSHOT,
      `Ref is bound to frame ${boundFrameId}, but this observe targets frame ${explicitFrameId} (re-run observe to refresh the ref)`,
    );
  }
  return { selector: resolved.selector, frameId: boundFrameId, ...(resolved.pagination ? { pagination: resolved.pagination } : {}) };
}

export function registerObserveHandlers(router: ActionRouter, debuggerMgr: DebuggerManager): void {
  const navigation = new Map<number, Map<number, number>>();
  const committedDocuments = new Map<number, Map<number, { documentId?: string; lastKnownDocumentId?: string; changes: number }>>();
  const onNavigation = ({ tabId, frameId }: { tabId: number; frameId: number }) => {
    let frames = navigation.get(tabId);
    if (!frames) navigation.set(tabId, frames = new Map());
    frames.set(frameId, (frames.get(frameId) ?? 0) + 1);
    for (const [id, entry] of pageSnapshots) {
      if (entry.tabId === tabId && (frameId === 0 || entry.frameId === frameId)) {
        pageSnapshots.delete(id);
        deleteSnapshot(id);
      }
    }
  };
  chrome.webNavigation?.onHistoryStateUpdated?.addListener(onNavigation);
  chrome.webNavigation?.onReferenceFragmentUpdated?.addListener(onNavigation);
  chrome.webNavigation?.onCommitted?.addListener((details) => {
    let frames = committedDocuments.get(details.tabId);
    if (!frames) committedDocuments.set(details.tabId, frames = new Map());
    const previous = frames.get(details.frameId);
    frames.set(details.frameId, { documentId: details.documentId,
      lastKnownDocumentId: details.documentId || previous?.lastKnownDocumentId,
      changes: (previous?.changes ?? 0) + (details.documentId && details.documentId !== previous?.lastKnownDocumentId ? 1 : 0) });
    onNavigation(details);
  });
  // debuggerMgr 用于 AX overlay pass + JS listener 信号（T3）
  router.registerAll({
    [ObserveActions.SNAPSHOT]: async (args, tabId) => {
      const startedAt = Date.now();
      const deadline = startedAt + SCAN_TOTAL_BUDGET_MS;
      const checkDeadline = () => {
        if (Date.now() >= deadline) throw vtxError(VtxErrorCode.TIMEOUT, "Observe deadline expired");
      };
      const work = async () => {
      gcSnapshots();
      const tid = await getActiveTabId(
        (args.tabId as number | undefined) ?? tabId,
      );
      checkDeadline();
      const explicitFrameId = args.frameId as number | undefined;
      const navigationAtStart = new Map(navigation.get(tid));
      const committedAtStart = new Map(committedDocuments.get(tid));
      for (const [id, entry] of pageSnapshots) {
        if (Date.now() - entry.capturedAt > PAGE_TTL_MS) pageSnapshots.delete(id);
      }
      if (args.cursor !== undefined) {
        if (Object.keys(args).some((key) => !["cursor", "tabId", "frameId"].includes(key))) {
          throw vtxError(VtxErrorCode.INVALID_PARAMS, "A cursor cannot be combined with observe parameters");
        }
        const match = typeof args.cursor === "string" ? /^(snap_[a-z0-9]+_[0-9]+):(\d+)$/.exec(args.cursor) : null;
        const entry = match ? pageSnapshots.get(match[1]) : undefined;
        const offset = match ? Number(match[2]) : 0;
        if (!entry || entry.tabId !== tid || (explicitFrameId !== undefined && entry.frameId !== explicitFrameId) ||
            !Number.isSafeInteger(offset) || offset <= 0 || offset % entry.pageSize !== 0 || offset >= entry.result.elements.length) {
          throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "Invalid or expired pagination cursor");
        }
        let valid = false;
        try {
          const checked = await chrome.scripting.executeScript({
            target: { tabId: tid, documentIds: [entry.request.documentId] }, world: "MAIN",
            func: updatePageSnapshot, args: ["check", match![1], entry.request],
          });
          valid = checked.length === 1 && checked[0].documentId === entry.request.documentId && checked[0].frameId === entry.frameId && checked[0].result === true;
        } catch (err) {
          console.warn("[vortex.observe] pagination validation failed", err);
        }
        checkDeadline();
        if (!valid || pageSnapshots.get(match![1]) !== entry) throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "Page changed since the snapshot was captured");
        const elements = entry.result.elements.slice(offset, offset + entry.pageSize);
        return { ...entry.result, elements, meta: { ...entry.result.meta, returnedCount: elements.length },
          ...(offset + entry.pageSize < entry.result.elements.length ? { nextCursor: `${match![1]}:${offset + entry.pageSize}` } : {}) };
      }
      const paginate = args.paginate === true;
      const paginationToken = paginate ? newSnapshotId() : null;
      // 目标局部观察:scope = 只扫某个容器及其后代(CSS selector 或旧快照 ref)。
      const scope = resolveObserveScope(args, tid, explicitFrameId);
      if (explicitFrameId != null) await ensureFrameAttached(tid, explicitFrameId);
      const framesParamProvided = args.frames !== undefined;
      const framesParam = (args.frames as FramesParam | undefined) ?? "main";
      const maxElements = (args.maxElements as number | undefined) ?? 80;
      if (paginate && (!Number.isSafeInteger(maxElements) || maxElements < 1 || maxElements > PAGE_CAPTURE_LIMIT)) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS, `maxElements must be between 1 and ${PAGE_CAPTURE_LIMIT}`);
      }
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

      // scope 存在时只扫 scope 所在的 frame:局部观察不该把别的 frame 混进来。
      const frameTargets = await resolveTargetFrames(
        tid,
        scope ? scope.frameId : explicitFrameId,
        framesParam,
      );
      checkDeadline();
      if (frameTargets.length === 0) {
        throw vtxError(
          VtxErrorCode.IFRAME_NOT_READY,
          "No target frames resolved (tab may be uninitialized)",
          { tabId: tid, frameId: explicitFrameId },
        );
      }

      if (paginate && frameTargets.length !== 1) {
        throw vtxError(VtxErrorCode.INVALID_PARAMS, "Pagination requires a single frame");
      }
      let queues = observeQueues.get(chrome.scripting);
      if (!queues) { queues = new Map(); observeQueues.set(chrome.scripting, queues); }
      const previous = queues.get(tid);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const current = previous ? previous.then(() => gate) : gate;
      queues.set(tid, current);
      if (previous && await raceTimeout(previous, Math.max(0, SCAN_TOTAL_BUDGET_MS - (Date.now() - startedAt))) === TIMED_OUT) {
        release();
        void current.then(() => { if (queues.get(tid) === current) queues.delete(tid); });
        throw vtxError(VtxErrorCode.TIMEOUT, "Previous observe is still running", { tabId: tid });
      }
      const pending = new Set<Promise<unknown>>();
      const track = <T>(promise: Promise<T>): Promise<T> => {
        pending.add(promise);
        void promise.then(() => pending.delete(promise), () => pending.delete(promise));
        return promise;
      };
      const axRequests: AXRequest[] = [];
      const listenerRequests: ListenerRequest[] = [];
      const claimedListeners: ListenerRequest[] = [];
      const scanRequests: ScanRequest[] = [];
      const claimedScans: ScanRequest[] = [];
      const unclaimedFrames: number[] = [];
      let scopeMonitorRequest: ScanRequest | undefined;
      const retireScans = async () => {
        await Promise.all(scanRequests.map(async (request) => {
          try {
            await raceTimeout(track(chrome.scripting.executeScript({ target: { tabId: tid, documentIds: [request.documentId] }, world: "MAIN",
              func: updateScanOwnership, args: ["scan.retire", request] })), Math.min(1000, Math.max(0, deadline - Date.now())));
          } catch (err) { console.warn("[vortex.observe] scan retire failed", err); }
        }));
      };
      let listenersRetired = false;
      const retireListeners = async () => {
        if (listenersRetired) return;
        listenersRetired = true;
        await Promise.all(listenerRequests.map(async (request) => {
          try {
            const retired = await raceTimeout(track(chrome.scripting.executeScript({
              target: { tabId: tid, documentIds: [request.documentId] }, world: "MAIN",
              func: updateListenerOwnership, args: ["listener.retire", request, paginationToken],
            })), Math.min(1000, Math.max(0, deadline - Date.now())));
            if (retired === TIMED_OUT || retired.length !== 1 || retired[0].result !== true ||
                retired[0].documentId !== request.documentId || retired[0].frameId !== request.frameId) {
              console.warn(`[vortex.observe] listener retire incomplete fid=${request.frameId}`);
            }
          } catch (err) {
            console.warn(`[vortex.observe] listener retire failed fid=${request.frameId}`, err);
          }
        }));
      };
      let axRetired = false;
      const retireAX = async () => {
        if (axRetired) return;
        axRetired = true;
        await Promise.all(axRequests.map(async (request) => {
          try {
            const retired = await raceTimeout(track(chrome.scripting.executeScript({
              target: { tabId: tid, documentIds: [request.documentId] }, world: "MAIN",
              func: updateAXOwnership, args: ["retire", request, paginationToken],
            })), Math.min(1000, Math.max(0, deadline - Date.now())));
            if (retired === TIMED_OUT || retired.length !== 1 || retired[0].result !== true ||
                retired[0].documentId !== request.documentId || retired[0].frameId !== request.frameId) {
              console.warn(`[vortex.observe] AX retire incomplete fid=${request.frameId}`);
            }
          } catch (err) {
            console.warn(`[vortex.observe] AX retire failed fid=${request.frameId}`, err);
          }
        }));
      };
      try {
      if (Date.now() - startedAt >= SCAN_TOTAL_BUDGET_MS) {
        throw vtxError(VtxErrorCode.TIMEOUT, "Observe deadline expired while waiting", { tabId: tid });
      }
      if (scope?.pagination) {
        const entry = pageSnapshots.get(scope.pagination.snapshotId);
        if (!entry || entry.tabId !== tid || entry.frameId !== scope.frameId || Date.now() - entry.capturedAt > PAGE_TTL_MS || !getSnapshotEntry(scope.pagination.snapshotId)) {
          throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "Pagination target is expired or no longer available");
        }
        scopeMonitorRequest = entry.request;
      }
      const generation = {};
      observeGenerations.set(tid, generation);
      for (const [id, entry] of pageSnapshots) {
        if (entry.tabId !== tid) continue;
        checkDeadline();
        pageSnapshots.delete(id);
        deleteSnapshot(id);
        if (id === scope?.pagination?.snapshotId) continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tid, documentIds: [entry.request.documentId] }, world: "MAIN",
            func: updatePageSnapshot, args: ["cleanup", id, entry.request],
          });
        } catch { /* A detached frame has already lost its monitor. */ }
      }
      checkDeadline();
      // 跨 frame：每个 frame 独立扫描；offset 用 getIframeOffset 算一次
      const scans: ScanEntry[] = [];
      const scanBudget: ScanBudget = {
        startedAt,
        timedOutFrames: [],
        budgetSkippedFrames: [],
      };
      let listenerDiscovery: "timeout" | "error" | "skipped-heavy" | undefined;
      let axOverlayTimedOut = false;
      const discoverListeners = async (targets: FrameTarget[]) => {
        const claimDeadline = Date.now() + Math.min(SCAN_CLAIM_TIMEOUT_MS, Math.max(0, deadline - Date.now()) / 2);
        await Promise.all(targets.map(async (target) => {
          if (!target.documentId?.trim() || (target.documentLifecycle && target.documentLifecycle !== "active")) {
            unclaimedFrames.push(target.frameId); return;
          }
          const request: ScanRequest = { frameId: target.frameId, documentId: target.documentId, ancestorFrameIds: target.ancestorFrameIds,
            epoch: scanEpoch, order: ++scanOrder, token: crypto.randomUUID(), deadline };
          scanRequests.push(request);
          try {
            const claimed = await raceTimeout(track(chrome.scripting.executeScript({ target: { tabId: tid, documentIds: [request.documentId] }, world: "MAIN",
              func: updateScanOwnership, args: ["scan.claim", request] })), Math.max(0, claimDeadline - Date.now()));
            if (claimed !== TIMED_OUT && claimed.length === 1 && claimed[0].documentId === request.documentId && claimed[0].frameId === request.frameId &&
                (claimed[0].result === true || (claimed[0].result === false && await recoverDocumentOwnership("scan", tid, request,
                  (work) => raceTimeout(track(work), Math.max(0, claimDeadline - Date.now())))))) claimedScans.push(request);
            else unclaimedFrames.push(target.frameId);
          } catch (err) { unclaimedFrames.push(target.frameId); console.warn("[vortex.observe] scan claim failed", err); }
        }));
        if (!debuggerMgr) return;
        const listenerDeadline = Math.min(deadline, Date.now() + LISTENER_DISCOVERY_TIMEOUT_MS);
        await Promise.all(targets.map(async (target) => {
          const scanRequest = claimedScans.find((request) => request.frameId === target.frameId && request.documentId === target.documentId);
          if (!scanRequest) return;
          if (typeof target.documentId !== "string" || !target.documentId.trim() ||
              (target.documentLifecycle && target.documentLifecycle !== "active")) {
            listenerDiscovery ??= "error";
            return;
          }
          const request: ListenerRequest = { frameId: target.frameId, documentId: target.documentId,
            epoch: listenerEpoch, order: ++listenerOrder, token: crypto.randomUUID(), deadline, scanToken: scanRequest.token };
          // Record before sending so a late claim can be tombstoned on every exit.
          listenerRequests.push(request);
          try {
            const claimed = await raceTimeout(track(chrome.scripting.executeScript({
              target: { tabId: tid, documentIds: [request.documentId] }, world: "MAIN",
              func: updateListenerOwnership, args: ["listener.claim", request],
            })), Math.max(0, listenerDeadline - Date.now()));
            if (claimed !== TIMED_OUT && claimed.length === 1 &&
                claimed[0].documentId === request.documentId && claimed[0].frameId === request.frameId &&
                (claimed[0].result === true || (claimed[0].result === false && await recoverDocumentOwnership("listener", tid, request,
                  (work) => raceTimeout(track(work), Math.max(0, listenerDeadline - Date.now())))))) claimedListeners.push(request);
            else listenerDiscovery ??= claimed === TIMED_OUT || Date.now() >= listenerDeadline ? "timeout" : "error";
          } catch (err) {
            listenerDiscovery ??= "error";
            console.warn(`[vortex.observe] listener claim skipped fid=${request.frameId}`, err);
          }
        }));
        try {
          const marked = await raceTimeout(
            track(markListenerElements(debuggerMgr, tid, listenerDeadline, scope?.pagination?.snapshotId, claimedListeners)),
            Math.max(0, listenerDeadline - Date.now()),
          );
          if (marked === TIMED_OUT || Date.now() >= listenerDeadline) listenerDiscovery = "timeout";
          else if (marked.mechanism !== "domDebugger") listenerDiscovery ??= marked.mechanism;
        } catch (err) {
          listenerDiscovery ??= "error";
          console.warn("[vortex.observe] listener discovery failed", err);
        }
      };
      await discoverListeners(frameTargets);
      checkDeadline();
      if (claimedScans.length === 0) throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "Target document ownership could not be acquired");
      const primaryRequest = claimedScans.find((request) => request.frameId === frameTargets[0].frameId);
      scans.push(
        ...(await scanFramesWithBudget(tid, frameTargets, scanBudget, {
          maxElements: paginate ? PAGE_CAPTURE_LIMIT : maxElements,
          viewport,
          includeText,
          includeAX,
          filterMode,
          scopeSelector: scope?.selector ?? null,
          scopePagination: scope?.pagination ?? null,
          paginationToken,
          track,
          axRequests,
          listenerRequests: claimedListeners,
          scanRequests: claimedScans,
        })),
      );

      checkDeadline();
      // scope 定位失败(找不到 / 命中多个 / 选择器非法):直接报错,
      // 不返回一份"看起来成功但其实没扫到目标"的快照。
      const scopeFailure = scans.find((s) => s.page?.scopeError)?.page?.scopeError;
      if (scope?.pagination && !scans.some((s) => s.page)) {
        const code = scanBudget.timedOutFrames.length || scanBudget.budgetSkippedFrames.length
          ? VtxErrorCode.TIMEOUT
          : scans.some((s) => s.scanError === "permission-denied")
            ? VtxErrorCode.PERMISSION_DENIED
            : VtxErrorCode.STALE_SNAPSHOT;
        throw vtxError(code, "Pagination target could not be validated");
      }
      if (scopeFailure) {
        throw vtxError(scopeFailure.code as VtxErrorCode, scopeFailure.message);
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
        scope == null &&
        !paginate &&
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
          checkDeadline();
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
                documentId: f.documentId,
                documentLifecycle: f.documentLifecycle,
                ancestorFrameIds: ancestorFrameIds(f, byId),
                url: f.url,
                parentFrameId: f.parentFrameId ?? 0,
              }));
            if (newTargets.length > 0) {
              autoFallback = true;
              await discoverListeners(newTargets);
              // 与主循环共享同一预算:fallback 是第二轮扫描,不该另起炉灶再吃 25s
              scans.push(
                ...(await scanFramesWithBudget(tid, newTargets, scanBudget, {
                  maxElements,
                  viewport,
                  includeText,
                  includeAX,
                  filterMode,
                  track,
                  axRequests,
                  listenerRequests: claimedListeners,
                  scanRequests: claimedScans,
                })),
              );
            }
          }
        }
      }

      checkDeadline();
      // Strict token indexes, stable CDP mapping, then document-directed ownership check.
      // Late CDP work only returns data; it must never mutate an already delivered result.
      if (includeAX && debuggerMgr) {
        await Promise.all(scans.filter((s) => s.page?.axIdentity && s.page.elements.length > 0).map(async (s) => {
          const identity = s.page!.axIdentity!;
          const budget = Math.min(AX_OVERLAY_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
          try {
            const result = await raceTimeout((async () => {
              await debuggerMgr.enableDomain(tid, "DOM");
              const getDocument = async () => (await debuggerMgr.sendCommand(tid, "DOM.getDocument", {
                depth: -1, pierce: true,
              })) as { root?: Parameters<typeof resolveFrameDocument>[0] };
              const first = await getDocument();
              const mapped = first.root && (s.frameId === 0
                ? { document: first.root, frameId: 0 as const }
                : resolveFrameDocument(first.root, identity.token));
              if (!mapped) return null;
              const indexes = buildIndexToBackend(mapped.document, true, identity.token);
              if (indexes.size !== s.page!.elements.length || s.page!.elements.some((_, i) => !indexes.has(i))) return null;
              const ax = await captureAXNodeMap(debuggerMgr, tid, mapped.frameId);
              const second = await getDocument();
              const verified = second.root && (s.frameId === 0
                ? { document: second.root, frameId: 0 as const }
                : resolveFrameDocument(second.root, identity.token));
              if (!verified || verified.frameId !== mapped.frameId) return null;
              const after = buildIndexToBackend(verified.document, true, identity.token);
              if (indexes.size !== after.size || [...indexes].some(([i, id]) => after.get(i) !== id)) return null;
              const alive = await chrome.scripting.executeScript({
                target: { tabId: tid, documentIds: [identity.documentId] }, world: "MAIN",
                func: updateAXOwnership, args: ["check", identity],
              });
              if (alive.length !== 1 || alive[0].result !== true || alive[0].documentId !== identity.documentId || alive[0].frameId !== s.frameId) return null;
              return { indexes, ax };
            })(), budget);
            if (result === TIMED_OUT) { axOverlayTimedOut = true; return; }
            // Use the enumerated lineage: a parent reload may detach this document
            // after its check reply without emitting a child onCommitted event.
            if (!result || Date.now() >= deadline ||
                [0, s.frameId, ...identity.ancestorFrameIds].some((frameId) =>
                  (navigation.get(tid)?.get(frameId) ?? 0) !== (navigationAtStart.get(frameId) ?? 0))) return;
            applyOverlay(s.page!.elements as unknown as OverlayableElement[], result.indexes, result.ax.byBackend, result.ax.byNodeId);
            s.axAvailable = true;
          } catch (err) {
            console.warn(`[vortex.observe] AX overlay skipped fid=${s.frameId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }));
      }
      // 注:JS 监听器真值信号已迁移到 pre-scan discovery(markListenerElements,
      // 见上方 frame 循环前)——listenerInteractive 在 scan 输出构造时由
      // data-vtx-listener 属性直接生成,不再需要事后 CDP pass。

      checkDeadline();
      await retireAX();
      await retireListeners();

      checkDeadline();
      // password 防护:type=password 的 valueNow 剥除,防敏感值泄露进下一个 prompt。
      for (const s of scans) {
        for (const e of s.page?.elements ?? []) {
          if ((e.attrs?.type ?? "").toLowerCase() === "password") e.valueNow = undefined;
        }
      }

      // hover 揭示控件探测（只读）：当前隐藏、hover 某祖先即显现的控件。
      // 这类控件在元素树里根本不存在（扫描瞬间 display:none），agent 靠这份路标
      // 才知道「还有东西，只是要 hover 出来」——否则只能靠猜。
      const hoverControlsByFrame = new Map<number, HoverRevealPair[]>();
      for (const s of scans) {
        if (scope || !s.page || s.page.elements.length === 0) continue;
        const pairs = await collectHoverRevealPairs(tid, s.frameId);
        checkDeadline();
        if (pairs.length) hoverControlsByFrame.set(s.frameId, pairs);
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
        /** 同快照内 role+name 重名时的区分性祖先文本。@since dup-context */
        dupContext?: string;
        /** BUG-010 N0060 京东评测: onClick 桩 / cursor:pointer 命中 (compact 也透传) */
        reactClickable?: true;
        clickHint?: string;
        /** CDP getEventListeners 真值信号，透传渲染层。@since T3 */
        listenerInteractive?: true;
        /** 投放区(drop/dragenter/dragover 监听)真值信号 → 渲染 [dropzone]。@since dropzone-discovery */
        dropzoneInteractive?: true;
        /** 拖拽源(显式 draggable=true)真值信号 → 渲染 [draggable]。@since draggable-source */
        draggableInteractive?: true;
        frameId: number;
        // Issue #21 — populated only when input.includeBoxes && e.inViewport (T4).
        bbox?: [number, number, number, number];
        parentIndex?: number;
        href?: string;
        offScreenActionable?: boolean;
        nameSource?: string;
        semanticSource?: "ax" | "dom" | "heuristic";
        controls?: Array<{ id?: string; index?: number }>;
        owns?: Array<{ id?: string; index?: number }>;
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
        /** 盲区降级信号(compact 也透传)。@since blindspot */
        blindspot?: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low"; readback?: "component" | "screenshot" | "chart"; chartLib?: string };
        /** 模态弹层外的背景元素(filter=all 逃生口信号)。@since modal-scope */
        behindModal?: boolean;
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
        title?: string;
        viewport?: FramePageResult["viewport"];
        scanError?: "permission-denied";
        axStatus?: "unavailable";
        offset: { x: number; y: number };
        elementCount: number;
        truncated: boolean;
        /** null 表示跨源 / 销毁导致无法扫描 */
        scanned: boolean;
        /** 该 frame 扫描时考虑的候选总数(截断量化)。@since blindspot */
        candidateCount?: number;
        /** 虚拟列表盲区(容器未收集时的 frame 级信号)。@since blindspot */
        blindspots?: Array<
          | { kind: "virtual"; total: number; rendered: number; name: string; confidence?: "low" }
          | { kind: "canvas"; name: string; chartLib: string; readback: "chart" }
          | { kind: "image"; name: string; src: string }
          | { kind: "occlusion"; name: string }
        >;
        /** 模态作用域信号。@since modal-scope */
        modal?: { name: string; role: string; suppressed: number };
        /** 空壳 SPA/渲染失败 frame 级信号。@since blank-shell */
        blankShell?: { root: string; rootLen: number; framework: string };
        /** hover 揭示控件（当前隐藏、hover 某祖先即显现）。@since hover-reveal */
        hoverControls?: HoverRevealPair[];
        hoverControlsUnavailable?: "target-scope";
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
            ...(s.scanError ? { scanError: s.scanError } : {}),
            ...(includeAX && s.frameId !== 0 ? { axStatus: "unavailable" as const } : {}),
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
          const remapRelations = (relations?: Array<{ id?: string; index?: number }>) =>
            relations?.map((relation) => relation.index === undefined ? relation : { ...relation, index: frameBase + relation.index });
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
              ...(e.dupContext !== undefined ? { dupContext: e.dupContext } : {}),
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
              // 投放区真值信号透传渲染层（→ [dropzone]）。
              ...(e.dropzoneInteractive ? { dropzoneInteractive: true as const } : {}),
              // 拖拽源真值信号透传渲染层（→ [draggable]）。
              ...(e.draggableInteractive ? { draggableInteractive: true as const } : {}),
              // a11y-tree: 全局重映射后的父指针 + href（link 元素）。
              ...(globalParentIndex !== undefined ? { parentIndex: globalParentIndex } : {}),
              ...(e.href ? { href: e.href } : {}),
              ...(e.nameSource ? { nameSource: e.nameSource } : {}),
              ...(e.semanticSource ? { semanticSource: e.semanticSource } : {}),
              ...(e.controls ? { controls: remapRelations(e.controls) } : {}),
              ...(e.owns ? { owns: remapRelations(e.owns) } : {}),
              ...(e.errorMessage ? { errorMessage: e.errorMessage } : {}),
              ...(e.description ? { description: e.description } : {}),
              ...(e.compound ? { compound: e.compound } : {}),
              ...(e.blindspot ? { blindspot: e.blindspot } : {}),
              ...(e.behindModal ? { behindModal: true as const } : {}),
              frameId: s.frameId,
              ...(bboxTuple ? { bbox: bboxTuple } : {}),
              // N0002 B006: slider/progressbar valuemin/max 独立透传(R7 page-side 路径设)。
              // compact 路径此前漏透传, 仅 full 路径有 — 修.
              ...(e.valueMin !== undefined ? { valueMin: e.valueMin } : {}),
              ...(e.valueMax !== undefined ? { valueMax: e.valueMax } : {}),
              // N0002 B010/B016: aria-keyshortcuts 显式键盘快捷键透传。
              ...(e.keyshortcuts ? { keyshortcuts: e.keyshortcuts } : {}),
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
              ...(e.dupContext !== undefined ? { dupContext: e.dupContext } : {}),
               // N0002 B006: slider/progressbar valuemin/max 独立透传(R7 page-side 路径设)。
               ...(e.valueMin !== undefined ? { valueMin: e.valueMin } : {}),
               ...(e.valueMax !== undefined ? { valueMax: e.valueMax } : {}),
               // N0002 B010/B016: aria-keyshortcuts 显式键盘快捷键透传。
               ...(e.keyshortcuts ? { keyshortcuts: e.keyshortcuts } : {}),
              // BUG-010 N0060 京东评测: 透传 reactClickable + clickHint,
              // 评测者读 clickHint 知该 ref 需用 vortex_mouse_drag / useRealMouse=true。
              ...(e.reactClickable
                ? { reactClickable: true as const, clickHint: e.clickHint! }
                : {}),
              // T3: CDP getEventListeners 真值信号透传渲染层（并集增强）。
              ...(e.listenerInteractive ? { listenerInteractive: true as const } : {}),
              // 投放区真值信号透传渲染层（→ [dropzone]）。
              ...(e.dropzoneInteractive ? { dropzoneInteractive: true as const } : {}),
              // 拖拽源真值信号透传渲染层（→ [draggable]）。
              ...(e.draggableInteractive ? { draggableInteractive: true as const } : {}),
              // a11y-tree: 全局重映射后的父指针 + href（link 元素）。
              ...(globalParentIndex !== undefined ? { parentIndex: globalParentIndex } : {}),
              ...(e.href ? { href: e.href } : {}),
              ...(e.nameSource ? { nameSource: e.nameSource } : {}),
              ...(e.semanticSource ? { semanticSource: e.semanticSource } : {}),
              ...(e.controls ? { controls: remapRelations(e.controls) } : {}),
              ...(e.owns ? { owns: remapRelations(e.owns) } : {}),
              ...(e.errorMessage ? { errorMessage: e.errorMessage } : {}),
              ...(e.description ? { description: e.description } : {}),
              ...(e.compound ? { compound: e.compound } : {}),
              ...(e.blindspot ? { blindspot: e.blindspot } : {}),
              ...(e.behindModal ? { behindModal: true as const } : {}),
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
            ...(paginate ? { pageNodeIndex: e.index } : {}),
            frameId: s.frameId,
            role: e.role,
            name: e.name,
          });
        }
        framesOut.push({
          frameId: s.frameId,
          parentFrameId: s.parentFrameId,
          url: s.page.url,
          title: s.page.title,
          viewport: s.page.viewport,
          ...(includeAX && s.frameId !== 0 && !s.axAvailable ? { axStatus: "unavailable" as const } : {}),
          offset: s.offset,
          elementCount: s.page.elements.length,
          truncated: s.page.truncated,
          scanned: true,
          candidateCount: s.page.candidateCount,
          ...(s.page.blindspots && s.page.blindspots.length ? { blindspots: s.page.blindspots } : {}),
          ...(s.page.modal ? { modal: s.page.modal } : {}),
          ...(s.page.blankShell ? { blankShell: s.page.blankShell } : {}),
          ...(scope ? { hoverControlsUnavailable: "target-scope" as const } : {}),
          ...(hoverControlsByFrame.get(s.frameId)?.length
            ? { hoverControls: hoverControlsByFrame.get(s.frameId) }
            : {}),
        });
      }

      if (paginate && frameTargets.some(({ frameId }) =>
        (navigation.get(tid)?.get(0) ?? 0) !== (navigationAtStart.get(0) ?? 0) ||
        (navigation.get(tid)?.get(frameId) ?? 0) !== (navigationAtStart.get(frameId) ?? 0))) {
        throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "Navigation occurred during snapshot capture");
      }
      if (observeGenerations.get(tid) !== generation) {
        if (paginationToken) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: tid, documentIds: [primaryRequest!.documentId] }, world: "MAIN",
              func: updatePageSnapshot, args: ["cleanup", paginationToken, primaryRequest!] });
          } catch { /* Frame no longer exists. */ }
        }
        throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "A newer observe replaced this snapshot");
      }
      const capturedAt = Date.now();
      if (paginationToken && scans.some((scan) => scan.page)) {
        const checked = await chrome.scripting.executeScript({
          target: { tabId: tid, documentIds: [primaryRequest!.documentId] }, world: "MAIN",
          func: updatePageSnapshot, args: ["finalize", paginationToken, primaryRequest!, capturedAt, PAGE_TTL_MS],
        });
        if (checked.length !== 1 || checked[0].documentId !== primaryRequest!.documentId || checked[0].frameId !== primaryRequest!.frameId || checked[0].result !== true) throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "Page changed since the snapshot was captured");
      }
      checkDeadline();
      if (paginate && frameTargets.some(({ frameId }) =>
        (navigation.get(tid)?.get(0) ?? 0) !== (navigationAtStart.get(0) ?? 0) ||
        (navigation.get(tid)?.get(frameId) ?? 0) !== (navigationAtStart.get(frameId) ?? 0))) {
        throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "Navigation occurred during snapshot capture");
      }
      const snapshotId = paginationToken ?? newSnapshotId();
      // entry.frameId：单 frame 时保留向后兼容 hint；多 frame 时不填（路由走 element.frameId）
      const isSingleFrame = framesOut.length === 1;


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
      let mainMetadata: Pick<FramePageResult, "url" | "title" | "viewport"> | undefined = mainScan?.page ?? undefined;
      if (!mainScan) {
        try {
          const metadata = await raceTimeout(track(chrome.scripting.executeScript({
            target: buildExecuteTarget(tid, 0), world: "MAIN",
            func: () => ({ url: location.href, title: document.title, viewport: {
              width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY,
              scrollHeight: document.documentElement.scrollHeight,
            } }),
          })), Math.max(0, deadline - Date.now()));
          if (metadata !== TIMED_OUT) mainMetadata = metadata[0]?.result as typeof mainMetadata;
        } catch (err) {
          console.warn("[vortex.observe] main metadata unavailable", err);
        }
      }
      checkDeadline();

      // 降级归因:仅在扫描真被截断时出现,正常路径 meta 保持字节不变
      const degraded =
        unclaimedFrames.length > 0 ||
        scanBudget.timedOutFrames.length > 0 ||
        scanBudget.budgetSkippedFrames.length > 0 ||
        listenerDiscovery ||
        axOverlayTimedOut
          ? {
              ...(scanBudget.timedOutFrames.length > 0
                ? { timedOutFrames: scanBudget.timedOutFrames }
                : {}),
              ...(scanBudget.budgetSkippedFrames.length > 0
                ? { budgetSkippedFrames: scanBudget.budgetSkippedFrames }
                : {}),
              // 这两项不减少元素数量,但静默降低召回/语义质量,不上报即 silent degradation
              ...(unclaimedFrames.length ? { unclaimedFrames } : {}),
              ...(listenerDiscovery ? { listenerDiscovery } : {}),
              ...(axOverlayTimedOut ? { axOverlay: "timeout" as const } : {}),
            }
          : undefined;
      // 有货就交货并标明缺口,没货就诚实报错——空结果 + success 是纯粹的 silent success
      if (degraded && elementsOut.length === 0) {
        throw vtxError(
          VtxErrorCode.TIMEOUT,
          `observe scan degraded and yielded 0 elements (timed out frames: [${scanBudget.timedOutFrames.join(", ")}], skipped by budget: [${scanBudget.budgetSkippedFrames.join(", ")}]); page may be too heavy or the tab is in a bad state. Retry with frames='main' to narrow scope, or vortex_wait_for(mode='idle') first.`,
          { tabId: tid, extras: { timedOutFrames: scanBudget.timedOutFrames, budgetSkippedFrames: scanBudget.budgetSkippedFrames } },
        );
      }

      // Empty successful pages still contribute metadata; failed scans contribute no document data.
      const contributors = claimedScans.filter((request) => scans.some((scan) => scan.page && scan.request === request));
      const confirmations = await Promise.all(contributors.map(async (request) => {
        const committed = committedDocuments.get(tid)?.get(request.frameId);
        const checked = await raceTimeout(track(chrome.scripting.executeScript({ target: { tabId: tid, documentIds: [request.documentId] }, world: "MAIN",
          func: updateScanOwnership, args: ["scan.check", request] })), Math.max(0, deadline - Date.now()));
        return { request, committed, valid: checked !== TIMED_OUT && checked.length === 1 && checked[0].documentId === request.documentId && checked[0].frameId === request.frameId && checked[0].result === true };
      }));
      checkDeadline();
      if (confirmations.some(({ valid }) => !valid) || observeGenerations.get(tid) !== generation || confirmations.some(({ request, committed: checkedCommit }) =>
          [0, request.frameId, ...(request.ancestorFrameIds ?? [])].some((frameId) => {
            const committed = committedDocuments.get(tid)?.get(frameId);
            const before = committedAtStart.get(frameId);
            // Missing identity can be revalidated only by a later real documentIds check.
            // Retain known transitions so a later identity-less event cannot hide a replacement.
            const sameDocument = frameId === request.frameId &&
              // An identity-less restore can leave the entry's known identity in another realm.
              (!before?.lastKnownDocumentId || before.lastKnownDocumentId === request.documentId) &&
              (!committed?.lastKnownDocumentId || committed.lastKnownDocumentId === request.documentId) &&
              (committed?.changes ?? 0) - (before?.changes ?? 0) <= 1 &&
              (committed?.documentId === request.documentId || committed === checkedCommit);
            return (committed !== before && !sameDocument) ||
              (paginate && (navigation.get(tid)?.get(frameId) ?? 0) !== (navigationAtStart.get(frameId) ?? 0));
          }))) {
        throw vtxError(VtxErrorCode.STALE_SNAPSHOT, "Document ownership changed before snapshot publication");
      }
      setSnapshot(snapshotId, { tabId: tid, frameId: isSingleFrame ? framesOut[0].frameId : undefined, capturedAt,
        ...(paginate ? { pagination: true } : {}), elements: elementMap });
      const result = {
        snapshotId,
        version: 2,
        url: mainMetadata?.url ?? mainScan?.url ?? "",
        title: mainMetadata?.title ?? "",
        ...(mainMetadata ? { viewport: mainMetadata.viewport } : { mainMetadataStatus: "unavailable" as const }),
        frames: framesOut,
        elements: elementsOut,
        meta: {
          capturedAt,
          candidateCount: totalCandidates,
          returnedCount: elementsOut.length,
          truncated: anyTruncated,
          frameCount: framesOut.length,
          scannedFrames: framesOut.filter((f) => f.scanned).length,
          ...(autoFallback ? { autoFallback: true as const } : {}),
          ...(degraded ? { degraded } : {}),
          ...(paginate && scans.some((scan) => scan.page?.monitorBudgetExceeded)
            ? { incomplete: "monitor-budget" as const }
            : paginate && anyTruncated ? { incomplete: "capture-budget" as const } : {}),
        },
      };
      if (!paginate) return result;
      if (pageSnapshots.size >= 100) pageSnapshots.delete(pageSnapshots.keys().next().value!);
      pageSnapshots.set(snapshotId, { tabId: tid, frameId: frameTargets[0].frameId, request: primaryRequest!, capturedAt, pageSize: maxElements, result });
      const elements = result.elements.slice(0, maxElements);
      return { ...result, elements, meta: { ...result.meta, returnedCount: elements.length },
        ...((!("incomplete" in result.meta) || result.meta.incomplete !== "monitor-budget") && elements.length < result.elements.length ? { nextCursor: `${snapshotId}:${maxElements}` } : {}) };
      } finally {
        await retireAX();
        await retireListeners();
        await retireScans();
        // A timed-out injection can still write to the page; keep the tab queue until it settles.
        void Promise.allSettled([...pending]).then(async () => {
          if (scope?.pagination && scopeMonitorRequest) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tid, documentIds: [scopeMonitorRequest.documentId] }, world: "MAIN",
                func: updatePageSnapshot, args: ["cleanup", scope.pagination.snapshotId, scopeMonitorRequest],
              });
            } catch (err) {
              console.warn("[vortex.observe] pagination cleanup failed", err);
            }
          }
          if (queues.get(tid) === current) queues.delete(tid);
          release();
        });
      }
      };
      const result = await raceTimeout(work(), Math.max(0, deadline - Date.now()));
      if (result === TIMED_OUT) throw vtxError(VtxErrorCode.TIMEOUT, "Observe deadline expired");
      return result;
    },
  });
}

