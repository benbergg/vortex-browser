/**
 * Author: qingwa
 * Description: Locks hub source against legacy process killing paths.
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const forbidden = /lsof|xargs\s+kill|killOldProcess|vortex-server\.pid/;

describe("hub no-kill source lock", () => {
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
    else if (/\.(ts|mjs|js)$/.test(entry.name)) result.push(file);
  }
  return result;
}
