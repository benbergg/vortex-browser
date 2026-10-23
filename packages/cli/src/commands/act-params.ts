/**
 * Author: qingwa
 * Description: act / sequence 共用的扩展参数构造（CLI 直连扩展，没有 MCP 层翻译）。
 */
import { VtxErrorCode } from "@vortex-browser/shared";
import { formatCliError } from "../client.js";
import { loadSnapshotContext, findRefContext } from "./observe.js";

/**
 * act 动作 → 扩展 action（与 packages/mcp/src/tools/dispatch.ts 的 ACT_TO_V05 保持一致）。
 * CLI 直连 vortex-server → 扩展，中间没有 MCP 层，所以映射放在这里。
 */
export const ACT_TO_EXTENSION: Record<string, string> = {
  click: "dom.click",
  fill: "dom.fill",
  type: "dom.type",
  select: "dom.select",
  scroll: "dom.scroll",
  hover: "dom.hover",
};

/**
 * 客户端可能把结构化 value 序列化成 JSON 字符串；只有解析出对象/数组时才还原，
 * 普通文本（"北京"、"12:30:00"）原样透传。与 dispatch.ts 的 parseStructuredValue 同规则。
 */
export function parseStructuredValue(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

/** 结构化 value 的还原：只有字符串才可能是被序列化过的 JSON。 */
function structured(value: unknown): unknown {
  return typeof value === "string" ? parseStructuredValue(value) : value;
}

/** 一步动作的输入（act 命令与 sequence 命令共用同一形状）。 */
export interface ActStepInput {
  action: string;
  target: string;
  value?: unknown;
  timeout?: number;
  force?: boolean;
  /** 是否采集 click/hover 的副作用信号（扩展侧 dom.click 的 observeEffect）。 */
  observeEffect?: boolean;
  /** 副作用信号的观察窗口（毫秒）。 */
  windowMs?: number;
}

/** 构造参数时需要的外部上下文。 */
export interface ActParamContext {
  /** 会话名（快照上下文按 session 分文件）。 */
  session: string;
  /**
   * 请求**实际会落到的 tab**（数字）：显式 --tab 就是它；
   * 没指定时由调用方解析成「该 session 当时的当前 tab」。
   * 快照按 tab 身份分槽，这里校验的就是这个身份（定向修复轮 Important ①）。
   */
  tab?: number;
  frameId?: number;
}

/** 构造好的扩展调用。 */
export interface BuiltAct {
  extensionAction: string;
  params: Record<string, unknown>;
}

/**
 * 把一步动作翻译成扩展 action + params。
 *
 * target 原样透传（`@ref` 或 CSS selector 都行）；扩展端只认 selector / index+snapshotId，
 * 所以 @ref 还要用最近一次 observe 的快照上下文补上 index + snapshotId
 * （翻译原本只存在于 MCP 层，CLI 这条路上没有那一层）。
 *
 * 解析不了就**抛错**：act 命令把它变成进程退出，sequence 命令把它记成该步 failed
 * —— 不能让一步的 ref 问题掀掉整条序列。
 */
export function buildActParams(step: ActStepInput, ctx: ActParamContext): BuiltAct {
  const extensionAction = ACT_TO_EXTENSION[step.action];
  if (!extensionAction) {
    throw new Error(formatCliError({
      code: VtxErrorCode.INVALID_PARAMS,
      message: `act: action must be one of ${Object.keys(ACT_TO_EXTENSION).join("|")}, got ${step.action}`,
    }));
  }

  const target = step.target;
  // target 原样透传：调用方给的 @ref / CSS 不做改写。
  const params: Record<string, unknown> = { target };
  if (ctx.frameId != null) params.frameId = ctx.frameId;

  if (target.startsWith("@")) {
    // @ref：靠最近一次 observe 的快照上下文翻成 index + snapshotId。
    // 查不到就地报错，绝不把孤立 target 发给服务端 —— 那只能换来
    // 「缺 selector / index+snapshotId」这种没法自解释的错误。
    //
    // 快照上下文带 **tab 身份**维度：只认「请求实际落到的那个 tab」的槽位。
    // ref 属于别的 tab 时报可恢复错误，绝不跨 tab 沿用旧 snapshotId
    // （扩展 resolveTarget 的 boundTabId 优先于请求里的 tab，沿用就会点在别的 tab 上）。
    if (typeof ctx.tab !== "number") {
      throw new Error(formatCliError({
        code: VtxErrorCode.STALE_SNAPSHOT,
        message: `act: cannot determine the target tab for ref "${target}"`,
        hint: "Run `vortex observe` again, or pass --tab <id> to target a tab explicitly.",
        recoverable: true,
      }));
    }
    const targetTab = ctx.tab;
    const context = loadSnapshotContext(ctx.session, targetTab);
    const entry = context?.refs[target];
    if (!context || !entry) {
      const owner = findRefContext(ctx.session, target);
      if (owner) {
        const ownerTab = owner.tabId == null ? "身份未知的 tab（旧格式快照）" : `tab ${owner.tabId}`;
        throw new Error(formatCliError({
          code: VtxErrorCode.STALE_SNAPSHOT,
          message:
            `act: ref "${target}" belongs to ${ownerTab}, but this request targets tab ${targetTab}` +
            " (snapshot context is bound to one tab)",
          hint:
            "先对目标 tab 执行 `vortex observe` 重新取得 ref（快照与 tab 绑定，不能跨 tab 沿用旧 snapshotId）" +
            (owner.tabId != null ? `；或用 --tab ${owner.tabId} 指定同一个 tab。` : "。"),
          recoverable: true,
        }));
      }
      throw new Error(formatCliError({
        code: VtxErrorCode.INVALID_PARAMS,
        message: `act: unknown ref "${target}": not in the latest vortex observe snapshot`,
        hint: "Run `vortex observe` first to get a fresh ref, then act with `vortex act --action <action> --target @eN`.",
        recoverable: true,
      }));
    }
    params.index = entry.index;
    params.snapshotId = context.snapshotId;
    if (entry.frameId != null && entry.frameId !== 0) params.frameId = entry.frameId;
  } else {
    // CSS selector：扩展端 resolveTarget 只读 selector。
    params.selector = target;
  }

  const value = step.value;
  if (value !== undefined) {
    if (step.action === "type") {
      params.text = value;
    } else if (step.action === "select") {
      params.value = structured(value);
    } else if (step.action === "fill") {
      params.value = value;
    } else if (step.action === "scroll") {
      const scrollValue = structured(value);
      if (scrollValue !== null && typeof scrollValue === "object" && !Array.isArray(scrollValue)) {
        const args = scrollValue as Record<string, unknown>;
        Object.assign(params, args);
        // scroll 带 container/position/x/y 时按容器滚，不再绑目标
        // （与 dispatch.ts 的 scroll 分支同规则：position 且无 container 才保留目标）。
        if ("container" in args || "position" in args || "x" in args || "y" in args) {
          const keepTarget = "position" in args && !("container" in args);
          if (!keepTarget) {
            delete params.index;
            delete params.snapshotId;
            delete params.selector;
          }
        }
      }
    }
  }
  if (step.timeout != null) params.timeout = step.timeout;
  if (step.force) params.force = true;
  // 副作用信号开关：扩展侧 dom.click 的 observeEffect / windowMs
  // （与 dispatch.ts 的 options.observeEffect / options.windowMs 同义）。
  if (step.observeEffect) params.observeEffect = true;
  if (step.windowMs != null) params.windowMs = step.windowMs;

  return { extensionAction, params };
}
