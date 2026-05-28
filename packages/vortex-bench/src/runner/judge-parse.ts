// packages/vortex-bench/src/runner/judge-parse.ts
// 纯逻辑:LLM 原始响应 → ClaimedMiss[]。容错围栏/散文/缺字段/非法 bbox。

import type { ClaimedMiss } from "../judge-types.js";

export function parseJudgeResponse(raw: string): ClaimedMiss[] {
  const obj = extractFirstJsonObject(raw);
  if (!obj || !Array.isArray((obj as { misses?: unknown }).misses)) return [];
  const out: ClaimedMiss[] = [];
  for (const item of (obj as { misses: unknown[] }).misses) {
    const m = toMiss(item);
    if (m) out.push(m);
  }
  return out;
}

function toMiss(item: unknown): ClaimedMiss | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o.label !== "string" || typeof o.reason !== "string") return null;
  const b = o.bbox;
  if (!Array.isArray(b) || b.length !== 4) return null;
  const nums = b.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return { label: o.label, reason: o.reason, bbox: [nums[0], nums[1], nums[2], nums[3]] };
}

/** 从可能含围栏/散文的文本里提取第一个能 JSON.parse 的 {...} 块 */
function extractFirstJsonObject(text: string): unknown {
  // 去掉 ```json / ``` 围栏标记后,扫描首个平衡花括号块
  const stripped = text.replace(/```json/gi, "```");
  const start = stripped.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
