// packages/vortex-bench/src/runner/robustness-classify.ts
// 纯逻辑：把一次 vortex_act(click) 的结果分类为 outcome。
// 与 invariants.ts 的 classifyProbe 同思路，但额外抽出具体错误码。
// MCP dispatch 把 typed error 以 content 文本 `Error [CODE]: ...` 返回(dispatch.ts:12)，
// 只有协议/传输层故障才 reject(=crash)。

import type { RefOutcomeKind } from "../robustness-types.js";

/** 一次 act 探测的原始结果(由编排器的 Promise.race 产出) */
export interface ActResult {
  text: string;
  threw: boolean;
  timedOut: boolean;
}

export interface ClassifiedAct {
  kind: RefOutcomeKind;
  /** typed-error 时的错误码;其余 null */
  code: string | null;
}

// 行首 `Error [CODE]:`, CODE 为大写+下划线(多行模式，因 act 文本可能多行带 hint)
const ERROR_CODE_RE = /^Error \[([A-Z_]+)\]:/m;

export function classifyAct(r: ActResult): ClassifiedAct {
  if (r.timedOut) return { kind: "timeout", code: null };
  if (r.threw) return { kind: "crash", code: null };
  const m = r.text.match(ERROR_CODE_RE);
  if (m) return { kind: "typed-error", code: m[1] };
  return { kind: "ok", code: null };
}
