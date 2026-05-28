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

/**
 * 从可能含围栏/散文的文本里提取含 misses 数组的 JSON 对象。
 * 策略:扫描所有平衡 {...} 块,返回第一个能 JSON.parse 且含 misses 数组的;
 * 都不含 misses 则返回最后一个能 parse 的(向后兼容纯 JSON 响应);都没有返回 null。
 * 这样可避免前导散文内联对象(如 {"note":"x"})抢先被命中、真正的 misses 对象被丢弃。
 */
function extractFirstJsonObject(text: string): unknown {
  // 去掉 ```json / ``` 围栏标记
  const stripped = text.replace(/```json/gi, "```");

  // 收集所有平衡花括号块
  const candidates: unknown[] = [];
  let i = 0;
  while (i < stripped.length) {
    const start = stripped.indexOf("{", i);
    if (start < 0) break;
    let depth = 0;
    let j = start;
    for (; j < stripped.length; j++) {
      const c = stripped[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      try {
        candidates.push(JSON.parse(stripped.slice(start, j + 1)));
      } catch {
        // 非法 JSON,跳过此块
      }
    }
    i = j + 1;
  }

  if (candidates.length === 0) return null;
  // 优先返回第一个含 misses 数组的对象
  const withMisses = candidates.find(
    (c) => c && typeof c === "object" && Array.isArray((c as { misses?: unknown }).misses),
  );
  if (withMisses !== undefined) return withMisses;
  // 向后兼容:无 misses 时返回最后一个能 parse 的(纯 JSON 响应)
  return candidates[candidates.length - 1];
}
