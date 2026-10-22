// packages/extension/src/action/reveal.ts
//
// Hover 揭示编排(host 侧)。
//
// 场景:「父级 :hover 才显示」的控件(工具条图标按钮、悬浮操作条)常驻 DOM,
// 但扫描/动作瞬间是 display:none —— observe 收不到它,act 判 NOT_VISIBLE 空转到超时。
//
// 这里的原语:沿目标祖先链由近及远地真鼠标 hover(CDP Input.dispatchMouseEvent
// mouseMoved),直到目标显现。之所以可靠:父级 :hover 揭示成立时,目标最近的那个
// **可见**祖先必然落在触发容器内 ⇒ hover 它即触发该容器的 :hover ⇒ 控件显现。
//
// 边界(必须显式成立,否则失败关闭):
//   - 预算:动作有 deadline。揭示全程受它约束——超时后不再派发任何鼠标移动。
//   - frame:非顶层 frame 必须能拿到可靠偏移,否则跳过揭示(宁可不揭示,也不能
//     把鼠标派到错误位置触发别的浮层)。
//   - 候选:每次派发前重新测量(坐标会因重排/滚动而陈旧)。
//   - 副作用:鼠标会停在触发元素上(这是刻意的——移走会让控件重新隐藏)。

import { pageQuery as nativePageQuery } from "../adapter/native.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";
import { getIframeOffset } from "../lib/iframe-offset.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";

export interface RevealCandidate {
  depth: number;
  path: number[];
  tag: string;
  id: string;
  cls: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  inViewport: boolean;
}

/** 被 hover 的祖先(证据):让 agent 知道「hover 谁」 */
export interface RevealTrigger {
  tag: string;
  id?: string;
  cls?: string;
  text?: string;
  depth: number;
}

/** 揭示失败的原因(有限枚举,供诊断文案用) */
export type RevealFailureReason =
  | "no-candidates"
  | "not-revealed"
  | "deadline"
  | "iframe-offset-unknown"
  | "error";

export interface RevealResult {
  revealed: boolean;
  trigger?: RevealTrigger;
  /** 实际 hover 次数 */
  attempts: number;
  /** 候选总数(诊断用) */
  candidates: number;
  /** 失败原因(仅在未揭示时给出) */
  reason?: RevealFailureReason;
}

/** 候选上限:够用且有界(每多一个候选 = 一次真鼠标移动) */
const MAX_CANDIDATES = 6;
/** 祖先层数上限 */
const MAX_DEPTH = 6;
/** 页面侧单次探针上限(ms)——rAF 等待必须有界,否则后台标签页会挂死 */
const PROBE_TIMEOUT_MS = 1000;

function remainingMs(deadline: number | undefined): number {
  if (deadline === undefined) return PROBE_TIMEOUT_MS;
  return Math.max(0, deadline - Date.now());
}

/** 探针超时取「剩余预算」与「本地上限」的较小值——不能越出动作 deadline */
function probeTimeout(deadline: number | undefined): number {
  if (deadline === undefined) return PROBE_TIMEOUT_MS;
  return Math.max(50, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
}

async function collectCandidates(
  tabId: number,
  frameId: number | undefined,
  selector: string,
  deadline: number | undefined,
): Promise<RevealCandidate[]> {
  return await nativePageQuery<RevealCandidate[]>(
    tabId,
    frameId,
    (sel: string, depth: number) => {
      const api = (globalThis as any).window?.__vortexHoverReveal;
      return api?.collectCandidates?.(sel, depth) ?? [];
    },
    [selector, MAX_DEPTH],
    probeTimeout(deadline),
  );
}

async function measureCandidate(
  tabId: number,
  frameId: number | undefined,
  path: number[],
  deadline: number | undefined,
): Promise<{ x: number; y: number; w: number; h: number; inViewport: boolean } | null> {
  return await nativePageQuery<{ x: number; y: number; w: number; h: number; inViewport: boolean } | null>(
    tabId,
    frameId,
    (p: number[]) => {
      const api = (globalThis as any).window?.__vortexHoverReveal;
      return api?.measureCandidate?.(p) ?? null;
    },
    [path],
    probeTimeout(deadline),
  );
}

async function scrollIntoView(
  tabId: number,
  frameId: number | undefined,
  path: number[],
  deadline: number | undefined,
): Promise<boolean> {
  return await nativePageQuery<boolean>(
    tabId,
    frameId,
    (p: number[]) => {
      const api = (globalThis as any).window?.__vortexHoverReveal;
      return api?.scrollIntoView?.(p) ?? false;
    },
    [path],
    probeTimeout(deadline),
  );
}

async function isTargetVisible(
  tabId: number,
  frameId: number | undefined,
  selector: string,
  deadline: number | undefined,
): Promise<boolean> {
  return await nativePageQuery<boolean>(
    tabId,
    frameId,
    async (sel: string) => {
      const api = (globalThis as any).window?.__vortexHoverReveal;
      // 等一帧:真鼠标移动后浏览器要更新 hover 态并重算样式,同帧内读可见性可能读到旧值
      await api?.afterPaint?.();
      return api?.isVisible?.(sel) ?? false;
    },
    [selector],
    probeTimeout(deadline),
  );
}

/**
 * hover 祖先以揭示被隐藏的目标。
 * 成功 ⇒ {revealed:true, trigger};失败 ⇒ {revealed:false, reason}(不抛)。
 *
 * deadline:动作截止时间(epoch ms)。过了它就不再派发鼠标移动——揭示不能拖出动作预算。
 */
export async function revealByHover(opts: {
  tabId: number;
  frameId: number | undefined;
  selector: string;
  debuggerMgr: DebuggerManager;
  maxCandidates?: number;
  deadline?: number;
}): Promise<RevealResult> {
  const { tabId, frameId, selector, debuggerMgr, deadline } = opts;
  const maxCandidates = Math.max(1, Math.min(MAX_CANDIDATES, opts.maxCandidates ?? MAX_CANDIDATES));
  let attempts = 0;
  let candidates: RevealCandidate[] = [];
  const fail = (reason: RevealFailureReason): RevealResult => ({
    revealed: false,
    attempts,
    candidates: candidates.length,
    reason,
  });
  try {
    if (remainingMs(deadline) <= 0) return fail("deadline");
    await loadPageSideModule(tabId, frameId, "hover-reveal");
    candidates = (await collectCandidates(tabId, frameId, selector, deadline)) ?? [];
    if (!candidates.length) return fail("no-candidates");

    // 候选全在视口外:先滚最近的那个进视口,否则真鼠标移过去不产生 hover
    if (!candidates.some((c) => c.inViewport)) {
      await scrollIntoView(tabId, frameId, candidates[0].path, deadline);
      const after = (await collectCandidates(tabId, frameId, selector, deadline)) ?? [];
      // 滚动后拿不到候选 ⇒ 坐标已失效,本轮终止(不复用滚动前的旧坐标)
      if (!after.length) return fail("not-revealed");
      candidates = after;
    }

    // 非顶层 frame:偏移必须可靠。getIframeOffset 取不到时返回 {0,0},与「真实零偏移」
    // 不可区分 ⇒ 这种情况下宁可不揭示,也不能把鼠标派到页面别处触发别的浮层。
    const offset = await getIframeOffset(tabId, frameId, debuggerMgr);
    if (frameId != null && frameId !== 0 && offset.x === 0 && offset.y === 0) {
      return fail("iframe-offset-unknown");
    }
    await debuggerMgr.attach(tabId);

    for (const c of candidates.slice(0, maxCandidates)) {
      if (remainingMs(deadline) <= 0) return fail("deadline");
      attempts++;
      // 坐标会因重排/滚动而陈旧:派发前重新测量,元素消失/不可见就跳过
      const m = await measureCandidate(tabId, frameId, c.path, deadline);
      if (!m || !m.inViewport) continue;
      await debuggerMgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: m.x + offset.x,
        y: m.y + offset.y,
      });
      if (await isTargetVisible(tabId, frameId, selector, deadline)) {
        return {
          revealed: true,
          trigger: {
            tag: c.tag,
            ...(c.id ? { id: c.id } : {}),
            ...(c.cls ? { cls: c.cls.slice(0, 120) } : {}),
            ...(c.text ? { text: c.text } : {}),
            depth: c.depth,
          },
          attempts,
          candidates: candidates.length,
        };
      }
    }
  } catch {
    // 注入失败/探针超时/CDP 不可用:退化为「未揭示」,由调用方给可执行诊断
    return fail("error");
  }
  return fail("not-revealed");
}
