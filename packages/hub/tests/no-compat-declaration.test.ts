/**
 * Author: qingwa
 * Description: Prevents hub source and tests from declaring shared protocol replacements.
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenDeclaration = ["declare", "module", '"@vortex-browser/shared"'].join(" ");

describe("hub shared declaration source lock", () => {
  it("does not define a local shared module declaration", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(hubRoot)) {
      if ((await readFile(file, "utf8")).includes(forbiddenDeclaration)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(file));
    else if (/\.(d\.ts|ts|mjs|js)$/.test(entry.name)) result.push(file);
  }
  return result;
}
