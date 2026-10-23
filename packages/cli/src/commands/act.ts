/**
 * Author: qingwa
 * Description: Registers the `vortex act` command (act on a ref or CSS selector).
 */
import type { Command } from "commander";
import { sendRequest } from "../client.js";
import { printResponse, printActResult, exitWithError } from "../output.js";
import { getGlobalOpts } from "./helpers.js";
import { buildActParams } from "./act-params.js";

/**
 * `vortex act` —— 对元素执行一个动作。
 *
 * target 原样透传（`@ref` 或 CSS selector 都行）；扩展端只认 selector / index+snapshotId，
 * 所以 @ref 还要用最近一次 observe 的快照上下文补上 index + snapshotId
 * （翻译原本只存在于 MCP 层，CLI 这条路上没有那一层）。见 act-params.ts。
 *
 * `--observe-effect` 让扩展采集这次动作的副作用信号（DOM 变更 / 网络请求 / URL 变化 /
 * 焦点变化 / ARIA 变化 / 用户反馈），CLI 默认输出会把这些信号逐项列出来 ——
 * 「点了没有」不能只看 success。
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
    .option("--observe-effect", "collect click/hover side-effect signals (effect output)")
    .option("--window-ms <ms>", "side-effect observation window in milliseconds", parseInt)
    .option("--json", "print the raw JSON response instead of the readable summary")
    .action(async (opts: any, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getGlobalOpts(cmd);

      const actAction = String(opts.action ?? "");
      const target = String(opts.target ?? "");

      let built: { extensionAction: string; params: Record<string, unknown> };
      try {
        built = buildActParams(
          {
            action: actAction,
            target,
            value: opts.value as string | undefined,
            timeout: opts.timeout as number | undefined,
            force: Boolean(opts.force),
            observeEffect: Boolean(opts.observeEffect),
            windowMs: opts.windowMs as number | undefined,
          },
          { session, tab, frameId },
        );
      } catch (err: any) {
        exitWithError(err instanceof Error ? err.message : String(err));
      }

      try {
        const resp = await sendRequest(built.extensionAction, built.params, { port, session, tabId: tab });
        if (opts.json) {
          printResponse(resp, { pretty, quiet });
        } else {
          printActResult(actAction, target, resp, { pretty, quiet });
        }
      } catch (err: any) {
        // client.sendRequest 已用 formatCliError 渲染过，这里原样透出（不二次格式化）。
        exitWithError(err instanceof Error ? err.message : String(err));
      }
    });
}
