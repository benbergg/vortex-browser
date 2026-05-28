// packages/vortex-bench/src/runner/judge-prompt.ts
// 纯逻辑:observe 紧凑列表 → 多模态判官 prompt。MVP 仅主 frame(frameId===0)。

import type { ParsedObserve, ObserveRow } from "../scan-types.js";

/** observe 行渲染成判官可读列表;离屏(bbox=null)标注,跨 frame 行跳过 */
export function renderObserveList(parsed: ParsedObserve): string {
  const lines: string[] = [];
  for (const r of parsed.rows) {
    if (r.frameId !== 0) continue; // MVP 仅主 frame
    lines.push(formatRow(r));
  }
  return lines.join("\n");
}

function formatRow(r: ObserveRow): string {
  const name = r.name ?? "";
  const geo = r.bbox ? `bbox=[${r.bbox.join(",")}]` : "(off-screen)";
  return `[${r.role}] "${name}" ${geo}`;
}

/** 完整判官 prompt:截图随消息另传,这里只出文本指令 + observe 列表 */
export function buildJudgePrompt(parsed: ParsedObserve, hint?: string): string {
  const list = renderObserveList(parsed);
  const lines = [
    "You are auditing a browser-automation tool's element extractor.",
    "The attached screenshot is the current viewport. Below is the list of interactive",
    "elements the tool extracted (each: [role] \"name\" bbox=[x,y,w,h] in viewport px).",
    "",
    "Task: list interactive elements that are CLEARLY VISIBLE in the screenshot but are",
    "MISSING from the list below. An element is interactive if a user would click/tap/type",
    "it (buttons, links, menu items, form fields, clickable icons/cards).",
    "Rules:",
    "- Only report elements clearly visible in the screenshot. Do NOT guess hidden/",
    "  collapsed/occluded content (closed menus, modals not shown).",
    "- Do NOT report something already present in the list (match by approximate position).",
    "- If nothing is missing, return an empty array.",
    "Respond with ONLY a JSON object, no prose:",
    '{ "misses": [ { "label": "<short>", "bbox": [x,y,w,h], "reason": "<why interactive>" } ] }',
    "",
    ...(hint ? [`Note: ${hint}`, ""] : []),
    "Extracted interactive elements:",
    list || "(none)",
  ];
  return lines.join("\n");
}
