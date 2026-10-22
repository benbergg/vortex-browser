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
// 边界:只在调用方确认「目标已定位但不可见」时调用;候选与尝试次数有界;
// 任何异常都退化为「未揭示」,绝不把异常抛给动作链路。

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

export interface RevealResult {
  revealed: boolean;
  trigger?: RevealTrigger;
  /** 实际 hover 次数 */
  attempts: number;
  /** 候选总数(诊断用) */
  candidates: number;
}

/** 候选上限:够用且有界(每多一个候选 = 一次真鼠标移动) */
const MAX_CANDIDATES = 6;
/** 祖先层数上限 */
const MAX_DEPTH = 6;
/** 页面侧单次探针上限(ms)——rAF 等待必须有界,否则后台标签页会挂死 */
const PROBE_TIMEOUT_MS = 1000;

function ns(): any {
  return (globalThis as any).window?.__vortexHoverReveal;
}

async function collectCandidates(
  tabId: number,
  frameId: number | undefined,
  selector: string,
): Promise<RevealCandidate[]> {
  return await nativePageQuery<RevealCandidate[]>(
    tabId,
    frameId,
    (sel: string, depth: number) => {
      const api = (globalThis as any).window?.__vortexHoverReveal;
      return api?.collectCandidates?.(sel, depth) ?? [];
    },
    [selector, MAX_DEPTH],
    PROBE_TIMEOUT_MS,
  );
}

async function scrollIntoView(
  tabId: number,
  frameId: number | undefined,
  path: number[],
): Promise<boolean> {
  return await nativePageQuery<boolean>(
    tabId,
    frameId,
    (p: number[]) => {
      const api = (globalThis as any).window?.__vortexHoverReveal;
      return api?.scrollIntoView?.(p) ?? false;
    },
    [path],
    PROBE_TIMEOUT_MS,
  );
}

async function isTargetVisible(
  tabId: number,
  frameId: number | undefined,
  selector: string,
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
    PROBE_TIMEOUT_MS,
  );
}

/**
 * hover 祖先以揭示被隐藏的目标。
 * 成功 ⇒ {revealed:true, trigger};失败 ⇒ {revealed:false}(不抛)。
 */
export async function revealByHover(opts: {
  tabId: number;
  frameId: number | undefined;
  selector: string;
  debuggerMgr: DebuggerManager;
  maxCandidates?: number;
}): Promise<RevealResult> {
  const { tabId, frameId, selector, debuggerMgr } = opts;
  const maxCandidates = Math.max(1, Math.min(MAX_CANDIDATES, opts.maxCandidates ?? MAX_CANDIDATES));
  let attempts = 0;
  let candidates: RevealCandidate[] = [];
  try {
    await loadPageSideModule(tabId, frameId, "hover-reveal");
    candidates = (await collectCandidates(tabId, frameId, selector)) ?? [];
    if (!candidates.length) return { revealed: false, attempts, candidates: 0 };

    // 候选全在视口外:先滚最近的那个进视口,否则真鼠标移过去不产生 hover
    if (!candidates.some((c) => c.inViewport)) {
      await scrollIntoView(tabId, frameId, candidates[0].path);
      candidates = (await collectCandidates(tabId, frameId, selector)) ?? candidates;
    }

    const offset = await getIframeOffset(tabId, frameId, debuggerMgr);
    await debuggerMgr.attach(tabId);

    for (const c of candidates.slice(0, maxCandidates)) {
      attempts++;
      await debuggerMgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: c.x + offset.x,
        y: c.y + offset.y,
      });
      if (await isTargetVisible(tabId, frameId, selector)) {
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
    return { revealed: false, attempts, candidates: candidates.length };
  }
  return { revealed: false, attempts, candidates: candidates.length };
}
