/**
 * Author: qingwa
 * Description: Locks hub and server tests against forbidden process termination tokens.
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubTests = dirname(fileURLToPath(import.meta.url));
const testRoots = [hubTests, join(hubTests, "../../server/tests")];
const forbidden = ["kill", "all"].join("");

describe("agent command test source lock", () => {
  it("includes ordinary files in the scanned test tree", async () => {
    expect(await sourceFiles(hubTests)).toContain(join(hubTests, "source-lock-fixture.txt"));
  });

  it("contains no contiguous process termination token", async () => {
    const offenders: string[] = [];
    for (const root of testRoots) {
      for (const file of await sourceFiles(root)) {
        if ((await readFile(file, "utf8")).includes(forbidden)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
