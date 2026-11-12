import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "../src/handlers/observe.ts"),
  "utf8",
);

describe("observe buildSelector shadow-aware 戳记 (Tier 2)", () => {
  it("shadow-internal 元素经 getRootNode() instanceof ShadowRoot 检测", () => {
    expect(OBSERVE_SRC).toMatch(/getRootNode\(\)\s*instanceof\s*ShadowRoot/);
  });

  it("检测到 shadow 时调 stampRid 始终戳唯一 rid", () => {
    expect(OBSERVE_SRC).toMatch(/function\s+stampRid/);
    expect(OBSERVE_SRC).toMatch(/instanceof\s*ShadowRoot[\s\S]{0,80}?stampRid\(/);
  });

  it("stampRid 仍写 data-vortex-rid 属性并带 setAttribute 失败回退", () => {
    const start = OBSERVE_SRC.indexOf("function stampRid(");
    const end = OBSERVE_SRC.indexOf("function buildSelector(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const stamp = OBSERVE_SRC.slice(start, end);
    expect(stamp).toMatch(/setMarker\(el, "data-vortex-rid", rid\)/);
    expect(OBSERVE_SRC).toMatch(/if \(item\) item\.marker\(el, name, value\); else el\.setAttribute\(name, value\)/);
    expect(stamp).toMatch(/catch \(err\)[\s\S]*?return null/);
    expect(stamp).toMatch(/\[data-vortex-rid="\$\{rid\}"\]/);
  });
});
