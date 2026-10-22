// packages/extension/src/handlers/observe-hover-reveal.ts
//
// observe 的「hover 揭示控件」探测（只读）。
//
// 场景:「父级 :hover 才显示」的控件（工具条图标按钮、悬浮操作条）常驻 DOM，
// 但扫描瞬间 display:none ⇒ observe 的元素树收不到它，agent 无从知道它存在。
//
// 这里扫同源样式表里的 :hover 规则，找出「当前被隐藏、hover 某祖先即显现」的控件，
// 产出一张路标表：hover 谁 → 会出现什么（控件选择器 + 可及名 + 类名）。
//
// 边界:纯只读——不移动鼠标、不改页面、不触发任何 UI 行为。

import { pageQuery as nativePageQuery } from "../adapter/native.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";

export interface HoverRevealPair {
  /** 触发元素选择器（hover 它） */
  triggerSelector: string;
  /** 触发元素可见文本（给 agent 定位用） */
  triggerText: string;
  /** 被揭示控件选择器（可直接交给 vortex_act） */
  controlSelector: string;
  controlTag: string;
  controlClasses: string;
  controlName: string;
  controlCursor: string;
}

/** 单 frame 最多报多少对（控 token 与噪声） */
const MAX_PAIRS_PER_FRAME = 8;
/** 页面侧探针上限(ms) */
const PROBE_TIMEOUT_MS = 1500;

/**
 * 采集某 frame 的 hover 揭示控件对。失败（注入不了/页面异常）返回空数组——绝不阻断 observe。
 */
export async function collectHoverRevealPairs(
  tabId: number,
  frameId: number,
  maxPairs: number = MAX_PAIRS_PER_FRAME,
): Promise<HoverRevealPair[]> {
  try {
    await loadPageSideModule(tabId, frameId, "hover-reveal");
    const pairs = await nativePageQuery<HoverRevealPair[]>(
      tabId,
      frameId,
      (limit: number) => {
        const api = (globalThis as any).window?.__vortexHoverReveal;
        return api?.findRevealPairs?.(limit) ?? [];
      },
      [maxPairs],
      PROBE_TIMEOUT_MS,
    );
    return Array.isArray(pairs) ? pairs : [];
  } catch {
    return [];
  }
}
