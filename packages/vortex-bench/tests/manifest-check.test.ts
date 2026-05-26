// packages/vortex-bench/tests/manifest-check.test.ts
import { describe, it, expect } from "vitest";
import { checkManifest } from "../src/runner/manifest-check.js";
import type { ParsedObserve, OracleRect, SynthManifest } from "../src/scan-types.js";

function parsed(rows: ParsedObserve["rows"]): ParsedObserve {
  return { header: { snapshotId: "s", url: "u" }, rows, frameOffsets: {} };
}
const manifest = (entries: SynthManifest["entries"]): SynthManifest => ({
  fixture: "t", path: "/synth/t.html", entries,
});

describe("checkManifest", () => {
  it("interactive 元素无 observe 行命中 → P0 recall-miss", () => {
    const p = parsed([]); // observe 啥都没出
    const oracles: OracleRect[] = [{ id: "btn", rect: [0, 0, 100, 50] }];
    const m = manifest([{ id: "btn", interactive: true, expectedName: "保存", expectedRole: "button", pattern: "cursor-pointer-div" }]);
    const findings = checkManifest(p, oracles, m);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("recall-miss");
    expect(findings[0].severity).toBe("P0");
    expect(findings[0].oracleId).toBe("btn");
  });

  it("interactive 命中且 name/role 一致 → 无 finding", () => {
    const p = parsed([{ ref: "@e0", role: "button", name: "保存", flags: [], bbox: [10, 10, 50, 20], frameId: 0 }]);
    const oracles: OracleRect[] = [{ id: "btn", rect: [0, 0, 100, 50] }];
    const m = manifest([{ id: "btn", interactive: true, expectedName: "保存", expectedRole: "button", pattern: "p" }]);
    expect(checkManifest(p, oracles, m)).toHaveLength(0);
  });

  it("命中但 name 不符 → P1 name-mismatch", () => {
    const p = parsed([{ ref: "@e0", role: "button", name: "确定", flags: [], bbox: [10, 10, 50, 20], frameId: 0 }]);
    const oracles: OracleRect[] = [{ id: "btn", rect: [0, 0, 100, 50] }];
    const m = manifest([{ id: "btn", interactive: true, expectedName: "保存", expectedRole: null, pattern: "p" }]);
    const findings = checkManifest(p, oracles, m);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("name-mismatch");
    expect(findings[0].severity).toBe("P1");
  });

  it("observe 行命中 interactive:false 的 oracle → P2 precision-miss", () => {
    const p = parsed([{ ref: "@e0", role: "div", name: null, flags: [], bbox: [10, 10, 50, 20], frameId: 0 }]);
    const oracles: OracleRect[] = [{ id: "noise", rect: [0, 0, 100, 50] }];
    const m = manifest([{ id: "noise", interactive: false, expectedName: null, expectedRole: null, pattern: "nameless-div-noise" }]);
    const findings = checkManifest(p, oracles, m);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("precision-miss");
    expect(findings[0].severity).toBe("P2");
  });

  it("expectedName=null 不校验 name", () => {
    const p = parsed([{ ref: "@e0", role: "button", name: "随便", flags: [], bbox: [10, 10, 50, 20], frameId: 0 }]);
    const oracles: OracleRect[] = [{ id: "btn", rect: [0, 0, 100, 50] }];
    const m = manifest([{ id: "btn", interactive: true, expectedName: null, expectedRole: null, pattern: "p" }]);
    expect(checkManifest(p, oracles, m)).toHaveLength(0);
  });

  it("joinBy=name:按 expectedName 匹配 observe 行,不靠 bbox", () => {
    const p = parsed([{ ref: "@f1e0", role: "button", name: "子框按钮", flags: [], bbox: null, frameId: 1 }]);
    const oracles: OracleRect[] = []; // 跨 frame oracle rect 拿不到
    const m = manifest([{ id: "x", interactive: true, expectedName: "子框按钮", expectedRole: null, pattern: "iframe-srcdoc-inherit", joinBy: "name" }]);
    expect(checkManifest(p, oracles, m)).toHaveLength(0); // name 命中 → 无 recall-miss
  });

  it("name-join 认领的行(有 bbox 但几何 join 不上)不被误报为 _unannotated 噪声", () => {
    // 自校准实测:srcdoc 子按钮在 iframe 内有 bbox,主 frame 探针拿不到它的 oracle rect,
    // 故落入 geometry unmatchedRows;但它已被 joinBy:name 的 entry 认领,不该算噪声。
    const p = parsed([{ ref: "@f49e1", role: "button", name: "子框按钮", flags: [], bbox: [5, 5, 60, 20], frameId: 49 }]);
    const oracles: OracleRect[] = [];
    const m = manifest([{ id: "child", interactive: true, expectedName: "子框按钮", expectedRole: null, pattern: "iframe-srcdoc-inherit", joinBy: "name" }]);
    expect(checkManifest(p, oracles, m)).toHaveLength(0); // 既不 recall-miss 也不 precision-miss
  });
});
