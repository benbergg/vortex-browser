// L2 Action - waitActionable 的自动 force 重试包装。
//
// NOT_STABLE 且调用方未显式传 force 时,自动以 force=true 重试一次。消除
// sticky / CSS-transition 容器(如京东首页搜索框 + 搜索按钮)100% 触发
// NOT_STABLE、需用户手动 force=true 兜底的痛点。
//
// 原 BUG-011 (N0060 京东评测方案 B) 仅在 FILL handler 内联实现;2026-06-09
// 京东搜索性能白盒复测发现 CLICK / TYPE 缺同款重试 —— 京东搜索按钮 click
// 在 sticky 容器内 100% NOT_STABLE,自旋满 timeout 后直接抛错。此处抽出共用。
//
// 语义:
//   - userForce === undefined 且首次 NOT_STABLE → 二次 force=true 重试
//   - userForce 显式 true / false → 不自动重试(用户已表态,尊重显式意图)
//   - 非 NOT_STABLE 错误(NOT_ATTACHED / NOT_EDITABLE 等语义错误)→ 不重试,
//     直接抛 —— force 救不了,应引导用户修 selector / 前置条件
//
// 返回 WaitOk（含 selector）,让 healAwareGate 感知自旋期 descriptor 重定位后的
// 实际命中选择器,避免下游仍用已失效的入参 selector 导致 ELEMENT_NOT_FOUND。

import { VtxErrorCode } from "@vortex-browser/shared";
import { waitActionable, type WaitOk, type WaitOptions } from "./auto-wait.js";

export async function waitActionableAutoForce(
  tabId: number,
  frameId: number | undefined,
  selector: string,
  options: WaitOptions,
  userForce: boolean | undefined,
): Promise<WaitOk> {
  try {
    return await waitActionable(tabId, frameId, selector, { ...options, force: userForce });
  } catch (err) {
    if ((err as { code?: string })?.code === VtxErrorCode.NOT_STABLE && userForce === undefined) {
      return await waitActionable(tabId, frameId, selector, { ...options, force: true });
    }
    throw err;
  }
}
