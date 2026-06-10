import { buildExecuteTarget } from "./tab-utils.js";

/**
 * 在指定父 frame 中，查目标 iframe 元素的 `getBoundingClientRect()` 左上角。
 * 跨源父 frame 导致 executeScript 失败时返回 null，由上层决定如何降级。
 * 匹配策略：完全 url 匹配 → origin 匹配（应对重定向）→ 单一 iframe 兜底。
 */
async function queryIframeRectInParent(
  tabId: number,
  parentFrameId: number,
  childFrameUrl: string,
): Promise<{ x: number; y: number } | null> {
  try {
    const iframeRect = await chrome.scripting.executeScript({
      target: buildExecuteTarget(tabId, parentFrameId),
      func: (frameUrl: string) => {
        let frameOrigin: string | null = null;
        try {
          frameOrigin = new URL(frameUrl).origin;
        } catch {
          frameOrigin = null;
        }
        // 穿 open shadow 深度收集 iframe：浅 querySelectorAll('iframe') 漏掉嵌在
        // shadow root 里的 iframe，导致 shadow-nested iframe 的 offset 被算成
        // {0,0} → realMouse 用 frame-local 坐标点空（oopif-in-osr / spif-in-shadow）。
        // 与 observe 走 querySelectorAllDeep 穿 shadow 同源。closed shadow 仍够不到
        // (el.shadowRoot=null)，由 getIframeOffset 上层降级处理。
        const collectIframes = (
          root: Document | ShadowRoot,
          acc: HTMLIFrameElement[],
        ): HTMLIFrameElement[] => {
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if (el.tagName === "IFRAME") acc.push(el as HTMLIFrameElement);
            const sr = (el as HTMLElement).shadowRoot;
            if (sr) collectIframes(sr, acc);
          }
          return acc;
        };
        const iframes = collectIframes(document, []);
        let iframe = iframes.find((f) => f.src === frameUrl);
        if (!iframe && frameOrigin) {
          iframe = iframes.find((f) => {
            try {
              return new URL(f.src).origin === frameOrigin;
            } catch {
              return false;
            }
          });
        }
        if (!iframe && iframes.length === 1) iframe = iframes[0];
        if (!iframe) return null;
        const r = iframe.getBoundingClientRect();
        return { x: r.left, y: r.top };
      },
      args: [childFrameUrl],
      world: "MAIN",
    });
    return (iframeRect[0]?.result as { x: number; y: number } | null) ?? null;
  } catch {
    // executeScript 在跨源或无权限父 frame 上会抛，视为不可定位
    return null;
  }
}

/**
 * 计算 frame 在顶层视口中的左上角累加偏移（跨越整条祖先 iframe 链）。
 * 主 frame 或找不到时返回 { x: 0, y: 0 }。
 * 任一层无法定位（如跨源父 frame）视为整体失败，返回 { x: 0, y: 0 }。
 */
export async function getIframeOffset(
  tabId: number,
  frameId?: number,
): Promise<{ x: number; y: number }> {
  if (frameId == null || frameId === 0) return { x: 0, y: 0 };

  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames) return { x: 0, y: 0 };

  // 从目标 frame 向主 frame 回溯，拿到整条祖先链（包含目标，不含主 frame）。
  const chain: chrome.webNavigation.GetAllFrameResultDetails[] = [];
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  let cur = byId.get(frameId);
  const visited = new Set<number>();
  while (cur && cur.frameId !== 0 && !visited.has(cur.frameId)) {
    visited.add(cur.frameId);
    chain.push(cur);
    const parentId = cur.parentFrameId ?? 0;
    if (parentId === 0) break;
    cur = byId.get(parentId);
  }

  // 从最外层祖先开始（即最靠近主 frame 的那层）依次累加每一层 iframe 在其父中的偏移。
  let acc = { x: 0, y: 0 };
  for (const f of chain.reverse()) {
    const parentId = f.parentFrameId ?? 0;
    const rect = await queryIframeRectInParent(tabId, parentId, f.url);
    if (!rect) return { x: 0, y: 0 };
    acc = { x: acc.x + rect.x, y: acc.y + rect.y };
  }
  return acc;
}
