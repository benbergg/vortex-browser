/**
 * Author: qingwa
 * Description: Locks the browser-agent source against legacy process termination paths.
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const forbidden = /lsof|xargs\s+kill|killOldProcess|vortex-server\.pid/;

describe("browser-agent no-kill source lock", () => {
  it("contains no legacy process termination path", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      if (forbidden.test(await readFile(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(file));
    else if (/\.ts$/.test(entry.name)) result.push(file);
  }
  return result;
}
