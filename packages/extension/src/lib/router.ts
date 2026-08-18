import type { NmRequest, NmResponse } from "@vortex-browser/shared";
import {
  DEFAULT_ERROR_META,
  TABLESS_ACTIONS,
  TIMEOUT_LIVENESS_META,
  VtxError,
  VtxErrorCode,
  innerDeadlineFor,
  vtxError,
} from "@vortex-browser/shared";
import { probeLiveness, type Liveness } from "./liveness-probe.js";
import { raceTimeout, TIMED_OUT } from "./race-timeout.js";

type Handler = (args: Record<string, unknown>, tabId?: number) => Promise<unknown>;
type StrictTabRequest = NmRequest & { strictTab?: boolean };

export { TABLESS_ACTIONS };

/** 探活自身抛错时不能把 TIMEOUT 降级成 JS_EXECUTION_ERROR，归因反而更差 */
async function attributeTimeout(tabId: number | undefined): Promise<Liveness> {
  try {
    return await probeLiveness(tabId);
  } catch {
    return "probe-failed";
  }
}

function timeoutPayload(action: string, budgetMs: number, liveness: Liveness) {
  const meta = TIMEOUT_LIVENESS_META[liveness];
  return vtxError(
    VtxErrorCode.TIMEOUT,
    `Action ${action} exceeded its ${budgetMs}ms budget`,
    { extras: { action, budgetMs, liveness } },
    meta,
  );
}

export class ActionRouter {
  private handlers = new Map<string, Handler>();

  register(action: string, handler: Handler): void {
    this.handlers.set(action, handler);
  }

  registerAll(actions: Record<string, Handler>): void {
    for (const [action, handler] of Object.entries(actions)) {
      this.register(action, handler);
    }
  }

  async dispatch(request: NmRequest): Promise<NmResponse> {
    const handler = this.handlers.get(request.tool);
    if (!handler) {
      return {
        type: "tool_response",
        requestId: request.requestId,
        error: { code: VtxErrorCode.UNKNOWN_ACTION, message: `Unknown action: ${request.tool}` },
      };
    }

    const strictTab = (request as StrictTabRequest).strictTab === true;
    if (strictTab && request.tabId == null && !TABLESS_ACTIONS.has(request.tool)) {
      return {
        type: "tool_response",
        requestId: request.requestId,
        error: {
          code: VtxErrorCode.TAB_NOT_FOUND,
          message: `strictTab requires tabId for ${request.tool}`,
          hint: "strictTab is enabled. Provide a tabId or let the hub backfill a current tab before retrying.",
          recoverable: false,
          context: { extras: { action: request.tool, strictTab: true } },
        },
      };
    }

    // 内层预算与调用方 timeout 同源推导，防止砍掉自管超时的 handler（如 js.evaluate）
    const budgetMs = innerDeadlineFor(request.tool, request.args?.timeout as number | undefined);
    try {
      const result = await raceTimeout(handler(request.args, request.tabId), budgetMs);
      if (result === TIMED_OUT) {
        // 超时后才探活：正常路径零开销
        const liveness = await attributeTimeout(request.tabId);
        return {
          type: "tool_response",
          requestId: request.requestId,
          error: timeoutPayload(request.tool, budgetMs, liveness).toJSON(),
        };
      }
      return { type: "tool_response", requestId: request.requestId, result };
    } catch (err) {
      // VtxError 走优先通道：保留完整 payload（code + hint + recoverable + context）
      if (err instanceof VtxError) {
        return {
          type: "tool_response",
          requestId: request.requestId,
          error: err.toJSON(),
        };
      }
      // 非 VtxError 的兜底：按 message 粗粒度推断 code（legacy 兼容）
      const message = err instanceof Error ? err.message : String(err);
      const code =
        message.includes("No tab") ? VtxErrorCode.TAB_NOT_FOUND :
        message.includes("Cannot access") ? VtxErrorCode.PERMISSION_DENIED :
        VtxErrorCode.JS_EXECUTION_ERROR;
      // ERR-1:回填 DEFAULT_ERROR_META 的 hint + recoverable。原兜底只回 {code,message},
      // 丢掉了该 code 已定义的恢复指引——CLI 等不经 server 渲染层 hint 回填的消费者
      // 拿到无指引裸错。VtxError 走上面的优先通道(自身 payload),此处仅补裸 Error。
      const meta = DEFAULT_ERROR_META[code];
      return {
        type: "tool_response",
        requestId: request.requestId,
        error: {
          code,
          message,
          ...(meta?.hint ? { hint: meta.hint } : {}),
          ...(meta?.recoverable !== undefined ? { recoverable: meta.recoverable } : {}),
        },
      };
    }
  }

  getRegisteredActions(): string[] {
    return Array.from(this.handlers.keys());
  }
}
