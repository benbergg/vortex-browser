/**
 * Author: qingwa
 * Description: Registers browser cookie and storage commands.
 */
import type { Command } from "commander";
import { makeAction, getGlobalOpts } from "./helpers.js";
import { sendRequest } from "../client.js";
import { printResponse, exitWithError } from "../output.js";
import { writeFileSync, readFileSync } from "fs";

export function registerStorageCommands(program: Command): void {
  const storage = program.command("storage").description("Cookie and storage management");

  storage.command("getCookies")
    .description("Get cookies")
    .option("--url <url>", "URL to get cookies for")
    .option("--domain <domain>", "domain filter")
    .action(makeAction("storage.getCookies", (_args, opts) => ({
      url: opts.url, domain: opts.domain,
    })));

  storage.command("setCookie")
    .description("Set a cookie")
    .requiredOption("--url <url>", "cookie URL")
    .requiredOption("--name <name>", "cookie name")
    .option("--value <value>", "cookie value", "")
    .option("--domain <domain>", "cookie domain")
    .option("--path <path>", "cookie path")
    .option("--secure", "secure flag")
    .option("--httpOnly", "httpOnly flag")
    .action(makeAction("storage.setCookie", (_args, opts) => ({
      url: opts.url, name: opts.name, value: opts.value,
      domain: opts.domain, path: opts.path,
      secure: opts.secure, httpOnly: opts.httpOnly,
    })));

  storage.command("deleteCookie")
    .description("Delete a cookie")
    .requiredOption("--url <url>", "cookie URL")
    .requiredOption("--name <name>", "cookie name")
    .action(makeAction("storage.deleteCookie", (_args, opts) => ({
      url: opts.url, name: opts.name,
    })));

  storage.command("getLocalStorage")
    .description("Get localStorage value(s)")
    .option("--key <key>", "specific key (omit for all)")
    .action(makeAction("storage.getLocalStorage", (_args, opts) => ({ key: opts.key })));

  storage.command("setLocalStorage")
    .description("Set localStorage value")
    .requiredOption("--key <key>", "storage key")
    .requiredOption("--value <value>", "storage value")
    .action(makeAction("storage.setLocalStorage", (_args, opts) => ({
      key: opts.key, value: opts.value,
    })));

  storage.command("getSessionStorage")
    .description("Get sessionStorage value(s)")
    .option("--key <key>", "specific key (omit for all)")
    .action(makeAction("storage.getSessionStorage", (_args, opts) => ({ key: opts.key })));

  storage.command("setSessionStorage")
    .description("Set sessionStorage value")
    .requiredOption("--key <key>", "storage key")
    .requiredOption("--value <value>", "storage value")
    .action(makeAction("storage.setSessionStorage", (_args, opts) => ({
      key: opts.key, value: opts.value,
    })));

  storage.command("exportSession")
    .description("Export cookies + localStorage + sessionStorage for a domain")
    .requiredOption("--domain <d>", "Domain (e.g. example.com)")
    .option("--output <file>", "Save to JSON file (default: print to stdout)")
    .action(async (opts: any, cmd: Command) => {
      const { port, session, tab, pretty, quiet } = getGlobalOpts(cmd);
      try {
        const resp = await sendRequest(
          "storage.exportSession",
          { domain: opts.domain },
          { port, session, tabId: tab },
        );
        if (opts.output && resp.result) {
          writeFileSync(opts.output, JSON.stringify(resp.result, null, 2));
          console.log(`Session exported to ${opts.output}`);
        } else {
          printResponse(resp, { pretty, quiet });
        }
      } catch (err: any) {
        exitWithError(err.message);
      }
    });

  storage.command("importSession")
    .description("Import session from a JSON file (written by exportSession)")
    .requiredOption("--input <file>", "Session JSON file")
    .action(async (opts: any, cmd: Command) => {
      const { port, session, tab, pretty, quiet } = getGlobalOpts(cmd);
      try {
        const data = JSON.parse(readFileSync(opts.input, "utf8"));
        const resp = await sendRequest(
          "storage.importSession",
          { data },
          { port, session, tabId: tab },
        );
        printResponse(resp, { pretty, quiet });
      } catch (err: any) {
        exitWithError(err.message);
      }
    });
}
