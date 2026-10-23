/**
 * Author: qingwa
 * Description: Registers the `vortex act` command (act on a ref or CSS selector).
 */
import type { Command } from "commander";
import { VtxErrorCode } from "@vortex-browser/shared";
import { sendRequest, formatCliError } from "../client.js";
import { printResponse, exitWithError } from "../output.js";
import { getGlobalOpts } from "./helpers.js";
import { loadSnapshotContext, findRefContext } from "./observe.js";

/**
 * act 动作 → 扩展 action（与 packages/mcp/src/tools/dispatch.ts 的 ACT_TO_V05 保持一致）。
 * CLI 直连 vortex-server → 扩展，中间没有 MCP 层，所以映射放在这里。
 */
const ACT_TO_EXTENSION: Record<string, string> = {
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
function parseStructuredValue(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * `vortex act` —— 对元素执行一个动作。
 *
 * target 原样透传（`@ref` 或 CSS selector 都行）；扩展端只认 selector / index+snapshotId，
 * 所以 @ref 还要用最近一次 observe 的快照上下文补上 index + snapshotId
 * （翻译原本只存在于 MCP 层，CLI 这条路上没有那一层）。
 */
export function registerActCommand(program: Command): void {
  program
    .command("act")
    .description("Act on an element: click | fill | type | select | scroll | hover")
    .requiredOption("--action <action>", "click | fill | type | select | scroll | hover")
    .requiredOption("--target <target>", "@ref from vortex observe, or a CSS selector")
    .option("--value <value>", "value to fill / select / type, or scroll params as JSON")
    .option("--timeout <ms>", "action timeout in milliseconds", parseInt)
    .option("--force", "act even when the element is not actionable")
    .action(async (opts: any, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getGlobalOpts(cmd);

      const actAction = String(opts.action ?? "");
      const extensionAction = ACT_TO_EXTENSION[actAction];
      if (!extensionAction) {
        exitWithError(formatCliError({
          code: VtxErrorCode.INVALID_PARAMS,
          message: `act: action must be one of ${Object.keys(ACT_TO_EXTENSION).join("|")}, got ${actAction}`,
        }));
      }

      const target = String(opts.target ?? "");
      // target 原样透传：调用方给的 @ref / CSS 不做改写。
      const params: Record<string, unknown> = { target };
      if (frameId != null) params.frameId = frameId;

      if (target.startsWith("@")) {
        // @ref：靠最近一次 observe 的快照上下文翻成 index + snapshotId。
        // 查不到就地报错，绝不把孤立 target 发给服务端 —— 那只能换来
        // 「缺 selector / index+snapshotId」这种没法自解释的错误。
        //
        // 快照上下文带 tab 维度：只认「请求目标 tab」那个槽位。
        // ref 属于别的 tab 时报可恢复错误，绝不跨 tab 沿用旧 snapshotId
        // （扩展 resolveTarget 的 boundTabId 优先于请求里的 tab，沿用就会点在别的 tab 上）。
        const targetTab = typeof tab === "number" ? tab : null;
        const context = loadSnapshotContext(session, targetTab);
        const entry = context?.refs[target];
        if (!context || !entry) {
          const owner = findRefContext(session, target);
          if (owner) {
            const ownerTab = owner.tabId == null ? "未指定 tab" : `tab ${owner.tabId}`;
            const wantTab = targetTab == null ? "未指定 tab" : `tab ${targetTab}`;
            exitWithError(formatCliError({
              code: VtxErrorCode.STALE_SNAPSHOT,
              message:
                `act: ref "${target}" belongs to ${ownerTab}, but this request targets ${wantTab}` +
                " (snapshot context is bound to one tab)",
              hint:
                "先对目标 tab 执行 `vortex observe` 重新取得 ref（快照与 tab 绑定，不能跨 tab 沿用旧 snapshotId）" +
                (owner.tabId != null ? `；或用 --tab ${owner.tabId} 指定同一个 tab。` : "。"),
              recoverable: true,
            }));
          }
          exitWithError(formatCliError({
            code: VtxErrorCode.INVALID_PARAMS,
            message: `act: unknown ref "${target}": not in the latest vortex observe snapshot`,
            hint: "Run `vortex observe` first to get a fresh ref, then act with `vortex act --action <action> --target @eN`.",
            recoverable: true,
          }));
        } else {
          params.index = entry.index;
          params.snapshotId = context.snapshotId;
          if (entry.frameId != null && entry.frameId !== 0) params.frameId = entry.frameId;
        }
      } else {
        // CSS selector：扩展端 resolveTarget 只读 selector。
        params.selector = target;
      }

      const value = opts.value as string | undefined;
      if (value !== undefined) {
        if (actAction === "type") {
          params.text = value;
        } else if (actAction === "select") {
          params.value = parseStructuredValue(value);
        } else if (actAction === "fill") {
          params.value = value;
        } else if (actAction === "scroll") {
          const scrollValue = parseStructuredValue(value);
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
      if (opts.timeout != null) params.timeout = opts.timeout;
      if (opts.force) params.force = true;

      try {
        const resp = await sendRequest(extensionAction, params, { port, session, tabId: tab });
        printResponse(resp, { pretty, quiet });
      } catch (err: any) {
        // client.sendRequest 已用 formatCliError 渲染过，这里原样透出（不二次格式化）。
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });
}
