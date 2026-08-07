/**
 * Author: qingwa
 * Description: Registers file upload, download, and completion commands.
 */
import type { Command } from "commander";
import { makeAction, makeSubscribeAction, getGlobalOpts } from "./helpers.js";
import { sendRequest } from "../client.js";
import { printResponse, exitWithError } from "../output.js";
import { readFileSync } from "fs";
import { basename } from "path";

export function registerFileCommands(program: Command): void {
  const file = program.command("file").description("File upload and download");

  file.command("upload <selector>")
    .description("Upload a file to input[type=file]")
    .requiredOption("--file <path>", "local file path")
    .option("--name <name>", "file name override")
    .option("--mime <type>", "MIME type")
    .action(async (selector: string, opts: any, cmd: Command) => {
      const { port, session, tab, pretty, quiet } = getGlobalOpts(cmd);
      const fileContent = readFileSync(opts.file).toString("base64");
      const fileName = opts.name ?? basename(opts.file);

      try {
        const resp = await sendRequest("file.upload", {
          selector, fileName, fileContent,
          mimeType: opts.mime,
        }, { port, session, tabId: tab });
        printResponse(resp, { pretty, quiet });
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  file.command("download <url>")
    .description("Download a file")
    .option("--filename <name>", "save as filename")
    .action(makeAction("file.download", (args, opts) => ({
      url: args[0], filename: opts.filename,
    })));

  file.command("getDownloads")
    .description("List recent downloads")
    .option("--limit <n>", "max results", parseInt, 20)
    .action(makeAction("file.getDownloads", (_args, opts) => ({ limit: opts.limit })));

  file.command("onDownloadComplete")
    .description("Subscribe to download completion events")
    .action(makeSubscribeAction("file.onDownloadComplete", () => ({})));
}
