/**
 * Author: qingwa
 * Description: Locks the dynamic-port rule across hub source and tests.
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, "..", "src");
const testRoot = here;
const forbiddenPort = [68, 56, 48, 48].join("");

describe("hub dynamic port source lock", () => {
  it("allows the default only in paths.ts", async () => {
    const files = [...await sourceFiles(sourceRoot), ...await sourceFiles(testRoot)];
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(join("src", "paths.ts"))) continue;
      if ((await readFile(file, "utf8")).includes(forbiddenPort)) offenders.push(file);
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
