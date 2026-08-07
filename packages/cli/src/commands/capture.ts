/**
 * Author: qingwa
 * Description: Registers screenshot and recording commands.
 */
import type { Command } from "commander";
import { makeAction, getGlobalOpts } from "./helpers.js";
import { sendRequest } from "../client.js";
import { exitWithError } from "../output.js";
import { writeFileSync } from "fs";

export function registerCaptureCommands(program: Command): void {
  const capture = program.command("capture").description("Screenshots and recording");

  capture.command("screenshot")
    .description("Take a screenshot")
    .option("--output <file>", "save to file")
    .option("--format <fmt>", "png or jpeg", "png")
    .option("--full-page", "capture full scrollable page (max 8000px)")
    .action(async (opts: any, cmd: Command) => {
      const { port, session, tab } = getGlobalOpts(cmd);
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
          console.log(`Saved to ${opts.output}`);
        } else {
          if (resp.result) {
            const r = resp.result as any;
            console.log(JSON.stringify({ format: r.format, size: r.dataUrl?.length, timestamp: r.timestamp }));
          }
        }
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  capture.command("element <selector>")
    .description("Screenshot an element")
    .option("--output <file>", "save to file")
    .action(async (selector: string, opts: any, cmd: Command) => {
      const { port, session, tab, frameId } = getGlobalOpts(cmd);
      try {
        const resp = await sendRequest(
          "capture.element",
          frameId != null ? { selector, frameId } : { selector },
          { port, session, tabId: tab },
        );
        if (opts.output && resp.result) {
          const result = resp.result as { dataUrl: string };
          const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, "");
          writeFileSync(opts.output, Buffer.from(base64, "base64"));
          console.log(`Saved to ${opts.output}`);
        } else {
          if (resp.result) {
            const r = resp.result as any;
            console.log(JSON.stringify({ selector, rect: r.rect, size: r.dataUrl?.length }));
          }
        }
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  capture.command("gifStart")
    .description("Start GIF recording")
    .option("--fps <n>", "frames per second", parseInt, 2)
    .action(makeAction("capture.gifStart", (_args, opts) => ({ fps: opts.fps })));

  capture.command("gifFrame")
    .description("Add a GIF frame manually")
    .action(makeAction("capture.gifFrame", () => ({})));

  capture.command("gifStop")
    .description("Stop GIF recording")
    .action(makeAction("capture.gifStop", () => ({})));
}
