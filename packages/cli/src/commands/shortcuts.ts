/**
 * Author: qingwa
 * Description: Registers frequently used CLI shortcut commands.
 */
import type { Command } from "commander";
import { sendRequest } from "../client.js";
import { printResponse, exitWithError } from "../output.js";
import { writeFileSync } from "fs";
import { resolveSessionName } from "../session.js";

function getOpts(cmd: Command) {
  const root = cmd.parent!;
  return {
    port: root.opts().port as number,
    session: resolveSessionName(root.opts().session as string | undefined),
    tab: root.opts().tab as number | undefined,
    frameId: root.opts().frameId as number | undefined,
    pretty: root.opts().pretty as boolean | undefined,
    quiet: root.opts().quiet as boolean | undefined,
  };
}

/** Injects the global frame ID when one was specified. */
function withFrameId(params: Record<string, unknown>, frameId?: number): Record<string, unknown> {
  return frameId != null ? { ...params, frameId } : params;
}

export function registerShortcuts(program: Command): void {
  program
    .command("navigate <url>")
    .description("Navigate to URL (shortcut for page.navigate)")
    .action(async (url: string, _opts: unknown, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getOpts(cmd);
      try {
        const resp = await sendRequest("page.navigate", withFrameId({ url }, frameId), { port, session, tabId: tab });
        printResponse(resp, { pretty, quiet });
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  program
    .command("click <selector>")
    .description("Click an element (shortcut for dom.click)")
    .action(async (selector: string, _opts: unknown, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getOpts(cmd);
      try {
        const resp = await sendRequest("dom.click", withFrameId({ selector }, frameId), { port, session, tabId: tab });
        printResponse(resp, { pretty, quiet });
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  program
    .command("type <selector> <text>")
    .description("Type text into an element (shortcut for dom.type)")
    .option("--delay <ms>", "delay between keystrokes", parseInt)
    .action(async (selector: string, text: string, opts: any, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getOpts(cmd);
      try {
        const resp = await sendRequest(
          "dom.type",
          withFrameId({ selector, text, delay: opts.delay }, frameId),
          { port, session, tabId: tab },
        );
        printResponse(resp, { pretty, quiet });
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  program
    .command("fill <selector> <value>")
    .description("Fill a form field (shortcut for dom.fill)")
    .action(async (selector: string, value: string, _opts: unknown, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getOpts(cmd);
      try {
        const resp = await sendRequest("dom.fill", withFrameId({ selector, value }, frameId), { port, session, tabId: tab });
        printResponse(resp, { pretty, quiet });
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  program
    .command("eval <code>")
    .description("Execute JavaScript (shortcut for js.evaluate)")
    .action(async (code: string, _opts: unknown, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getOpts(cmd);
      try {
        const resp = await sendRequest("js.evaluate", withFrameId({ code }, frameId), { port, session, tabId: tab });
        printResponse(resp, { pretty, quiet });
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  program
    .command("screenshot")
    .description("Take a screenshot (shortcut for capture.screenshot)")
    .option("--output <file>", "save to file instead of printing data URL")
    .option("--format <fmt>", "png or jpeg", "png")
    .option("--full-page", "capture full scrollable page (max 8000px)")
    .action(async (opts: any, cmd: Command) => {
      const { port, session, tab, pretty, quiet } = getOpts(cmd);
      try {
        const params: Record<string, unknown> = { format: opts.format };
        if (opts.fullPage) params.fullPage = true;
        const resp = await sendRequest(
          "capture.screenshot",
          params,
          { port, session, tabId: tab },
        );
        if (opts.output && resp.result) {
          const result = resp.result as { dataUrl: string };
          const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, "");
          writeFileSync(opts.output, Buffer.from(base64, "base64"));
          console.log(`Screenshot saved to ${opts.output}`);
        } else {
          printResponse(resp, { pretty, quiet });
        }
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  program
    .command("text [selector]")
    .description("Get page text (shortcut for content.getText)")
    .action(async (selector: string | undefined, _opts: unknown, cmd: Command) => {
      const { port, session, tab, frameId, pretty, quiet } = getOpts(cmd);
      try {
        const resp = await sendRequest(
          "content.getText",
          withFrameId({ selector }, frameId),
          { port, session, tabId: tab },
        );
        if (!pretty && !quiet && typeof resp.result === "string") {
          console.log(resp.result);
        } else {
          printResponse(resp, { pretty, quiet });
        }
      } catch (err: any) {
        exitWithError(err.message);
      }
    });
}
