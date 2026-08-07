/**
 * Author: qingwa
 * Description: Registers the raw action command with HTTP and subscription transports.
 */
import type { Command } from "commander";
import { sendRequest, subscribe } from "../client.js";
import { printResponse, printEvent, exitWithError } from "../output.js";
import { getGlobalOpts } from "./helpers.js";

export function registerRawCommand(program: Command): void {
  program
    .command("raw <action>")
    .description("Send a raw action to vortex-server")
    .option("--follow", "keep connection open for events")
    .allowUnknownOption(true)
    .action(async (action: string, opts: any, cmd: Command) => {
      const { port, session, tab, pretty, quiet } = getGlobalOpts(cmd);

      const params: Record<string, unknown> = {};

      const rawArgs = cmd.args.slice(1);
      for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg.startsWith("--") && arg !== "--follow") {
          const key = arg.slice(2);
          const value = rawArgs[i + 1];
          if (value && !value.startsWith("--")) {
            if (value === "true") params[key] = true;
            else if (value === "false") params[key] = false;
            else if (/^\d+$/.test(value)) params[key] = parseInt(value);
            else params[key] = value;
            i++;
          } else {
            params[key] = true;
          }
        }
      }

      try {
        if (opts.follow) {
          let onDisconnected: (reason: string) => void;
          const disconnected = new Promise<string>((resolve) => { onDisconnected = resolve; });
          const resp = await subscribe(action, params, {
            port,
            session,
            tabId: tab,
            follow: true,
            onEvent: (event) => printEvent(event, { pretty, quiet }),
            onDisconnect: (reason) => onDisconnected(reason),
          });
          printResponse(resp, { pretty, quiet });
          // 断流后必须退出：同名 session 被顶掉时干等只会表现为一条卡死的命令
          exitWithError(await disconnected);
        } else {
          const resp = await sendRequest(action, params, { port, session, tabId: tab });
          printResponse(resp, { pretty, quiet });
        }
      } catch (err: any) {
        exitWithError(err.message);
      }
    });
}
