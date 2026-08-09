/**
 * Author: qingwa
 * Description: Builds the Vortex CLI command tree and global options.
 */
import { Command } from "commander";
import { resolveSessionName } from "./session.js";
import { readNearestVersion } from "./version.js";
import { registerShortcuts } from "./commands/shortcuts.js";
import { registerTabCommands } from "./commands/tab.js";
import { registerPageCommands } from "./commands/page.js";
import { registerDomCommands } from "./commands/dom.js";
import { registerContentCommands } from "./commands/content.js";
import { registerJsCommands } from "./commands/js.js";
import { registerCaptureCommands } from "./commands/capture.js";
import { registerConsoleCommands } from "./commands/console.js";
import { registerNetworkCommands } from "./commands/network.js";
import { registerStorageCommands } from "./commands/storage.js";
import { registerFileCommands } from "./commands/file.js";
import { registerKeyboardCommands } from "./commands/keyboard.js";
import { registerMouseCommands } from "./commands/mouse.js";
import { registerFramesCommands } from "./commands/frames.js";
import { registerRawCommand } from "./commands/raw.js";

export { resolveSessionName } from "./session.js";

export const CLI_VERSION = readNearestVersion(import.meta.url);

export function createProgram(): Command {
  const program = new Command();

  program
    .name("vortex")
    .description("Browser automation CLI — control Chrome from the terminal")
    .version(CLI_VERSION)
    .option("--tab <id>", "target tab ID", parseInt)
    .option("--frame-id <id>", "target frame ID (for iframes)", parseInt)
    .option("--port <port>", "server port", parseInt, 6800)
    .option(
      "--session <name>",
      "session name (default: cli-$USER, or $VORTEX_SESSION_NAME)",
      resolveSessionName(undefined, process.env),
    )
    .option("--pretty", "pretty-print JSON output")
    .option("--quiet", "only output result, no wrapper");

  // Register shortcut commands.
  registerShortcuts(program);

  // Register namespace commands.
  registerTabCommands(program);
  registerPageCommands(program);
  registerDomCommands(program);
  registerContentCommands(program);
  registerJsCommands(program);
  registerCaptureCommands(program);
  registerConsoleCommands(program);
  registerNetworkCommands(program);
  registerStorageCommands(program);
  registerFileCommands(program);
  registerKeyboardCommands(program);
  registerMouseCommands(program);
  registerFramesCommands(program);

  // Register the raw command.
  registerRawCommand(program);

  return program;
}
