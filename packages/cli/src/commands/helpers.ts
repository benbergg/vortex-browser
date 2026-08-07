/**
 * Author: qingwa
 * Description: Shares global option extraction and action handler plumbing.
 */
import type { Command } from "commander";
import { sendRequest, subscribe } from "../client.js";
import { printResponse, printEvent, exitWithError } from "../output.js";
import type { VtxEvent } from "@vortex-browser/shared";
import { resolveSessionName } from "../session.js";

export function getGlobalOpts(cmd: Command) {
  let root = cmd;
  while (root.parent) root = root.parent;
  return {
    port: root.opts().port as number,
    session: resolveSessionName(root.opts().session as string | undefined),
    tab: root.opts().tab as number | undefined,
    frameId: root.opts().frameId as number | undefined,
    pretty: root.opts().pretty as boolean | undefined,
    quiet: root.opts().quiet as boolean | undefined,
  };
}

export function makeAction(action: string, buildParams: (args: any, opts: any) => Record<string, unknown>) {
  return async (...handlerArgs: any[]) => {
    const cmd = handlerArgs[handlerArgs.length - 1] as Command;
    const opts = handlerArgs[handlerArgs.length - 2];
    const args = handlerArgs.slice(0, -2);
    const { port, session, tab, frameId, pretty, quiet } = getGlobalOpts(cmd);

    const params = buildParams(args, opts);
    if (frameId != null && params.frameId == null) params.frameId = frameId;

    try {
      const resp = await sendRequest(action, params, { port, session, tabId: tab });
      printResponse(resp, { pretty, quiet });
    } catch (err: any) {
      exitWithError(err.message);
    }
  };
}

export function makeSubscribeAction(action: string, buildParams: (args: any, opts: any) => Record<string, unknown>) {
  return async (...handlerArgs: any[]) => {
    const cmd = handlerArgs[handlerArgs.length - 1] as Command;
    const opts = handlerArgs[handlerArgs.length - 2];
    const args = handlerArgs.slice(0, -2);
    const { port, session, tab, frameId, pretty, quiet } = getGlobalOpts(cmd);

    const params = buildParams(args, opts);
    if (frameId != null && params.frameId == null) params.frameId = frameId;

    try {
      let onDisconnected: (reason: string) => void;
      const disconnected = new Promise<string>((resolve) => { onDisconnected = resolve; });
      const resp = await subscribe(action, params, {
        port,
        session,
        tabId: tab,
        follow: true,
        onEvent: (event: VtxEvent) => printEvent(event, { pretty, quiet }),
        onDisconnect: (reason: string) => onDisconnected(reason),
      });
      printResponse(resp, { pretty, quiet });
      // 断流后必须退出：同名 session 被顶掉时干等只会表现为一条卡死的命令
      exitWithError(await disconnected);
    } catch (err: any) {
      exitWithError(err.message);
    }
  };
}
