// packages/vortex-bench/tests/manifest-check.test.ts
import { describe, it, expect } from "vitest";
import { checkManifest, ownedRows } from "../src/runner/manifest-check.js";
import type { ParsedObserve, OracleRect, SynthManifest } from "../src/scan-types.js";

function parsed(rows: ParsedObserve["rows"]): ParsedObserve {
  return { header: { snapshotId: "s", url: "u" }, rows, frameOffsets: {} };
}
const manifest = (entries: SynthManifest["entries"]): SynthManifest => ({
  fixture: "t", path: "/synth/t.html", entries,
});

describe("ownedRows (INV-1 比较范围)", () => {
  it("只返回 oracle 几何命中的行 + name 认领的行", () => {
    const p = parsed([
      { ref: "@e0", role: "button", name: "保存", flags: [], bbox: [10, 10, 50, 20], frameId: 0 },
      { ref: "@e1", role: "div", name: "imt-fb-btn", flags: [], bbox: [400, 400, 30, 30], frameId: 0 },
    ]);
    const oracles: OracleRect[] = [{ id: "btn", rect: [0, 0, 100, 50] }];
    const m = manifest([{ id: "btn", interactive: true, expectedName: "保存", expectedRole: "button", pattern: "p" }]);
    expect(ownedRows(p, oracles, m).map((r) => r.ref)).toEqual(["@e0"]);
  });

  it("第三方注入的浮球行不在比较范围(环境噪声不参与 INV-1)", () => {
    const noise = { ref: "@fb", role: "div", name: "imt-fb-btn", flags: [], bbox: [400, 400, 30, 30], frameId: 0 };
    const p1 = parsed([
      { ref: "@e0", role: "button", name: "保存", flags: [], bbox: [10, 10, 50, 20], frameId: 0 },
    ]);
    const p2 = parsed([
      { ref: "@e0", role: "button", name: "保存", flags: [], bbox: [10, 10, 50, 20], frameId: 0 },
      noise,
    ]);
    const oracles: OracleRect[] = [{ id: "btn", rect: [0, 0, 100, 50] }];
    const m = manifest([{ id: "btn", interactive: true, expectedName: "保存", expectedRole: "button", pattern: "p" }]);
    expect(ownedRows(p1, oracles, m)).toHaveLength(1);
    expect(ownedRows(p2, oracles, m)).toHaveLength(1);
  });

  it("joinBy=name 的入口按名字认领行(无 bbox 也算)", () => {
    const p = parsed([{ ref: "@f1e0", role: "button", name: "子框按钮", flags: [], bbox: null, frameId: 1 }]);
    const m = manifest([{ id: "sub", interactive: true, expectedName: "子框按钮", expectedRole: "button", pattern: "p", joinBy: "name" }]);
    expect(ownedRows(p, [], m).map((r) => r.ref)).toEqual(["@f1e0"]);
  });
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

  // ── 命中行选择:容器行也会命中子项 oracle(中心落在子项 rect 边界上,centerInside 含边界),
  //    取 hits[0] 会拿容器的 name/role 去校验 → 假 P1。改为取与 oracle rect IoU 最大者。
  const listRow = { ref: "@e0", role: "list", name: "首页 关于", flags: [], bbox: [0, 0, 100, 40], frameId: 0 };
  const itemRow = { ref: "@e1", role: "menuitem", name: "首页", flags: [], bbox: [0, 0, 100, 20], frameId: 0 };
  const homeOracle: OracleRect[] = [{ id: "home", rect: [0, 0, 100, 20] }];
  const homeManifest = manifest([
    { id: "home", interactive: true, expectedName: "首页", expectedRole: "menuitem", pattern: "aria-cursor-dedup" },
  ]);

  it("容器行命中同一 oracle(中心落在子项边界)→ 校验几何最贴合的子项行", () => {
    const p = parsed([listRow, itemRow]);
    expect(checkManifest(p, homeOracle, homeManifest)).toHaveLength(0);
  });

  it("子项行排在容器行前面 → 选行结果不变", () => {
    const p = parsed([itemRow, listRow]);
    expect(checkManifest(p, homeOracle, homeManifest)).toHaveLength(0);
  });

  it("最贴合行的 name 不符 → 仍报 P1", () => {
    const p = parsed([listRow, { ...itemRow, name: "首" }]);
    const findings = checkManifest(p, homeOracle, homeManifest);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("name-mismatch");
    expect(findings[0].severity).toBe("P1");
  });

  it("只有容器行命中 → 仍报 P1(选行规则不掩盖真实错配)", () => {
    const p = parsed([listRow]);
    const findings = checkManifest(p, homeOracle, homeManifest);
    expect(findings.map((f) => f.kind).sort()).toEqual(["name-mismatch", "role-mismatch"]);
    expect(findings.every((f) => f.severity === "P1")).toBe(true);
  });

  it("frame offset:行 bbox 是 frame-local,选行前先复合到 top-page", () => {
    const p: ParsedObserve = {
      header: { snapshotId: "s", url: "u" },
      frameOffsets: { 1: [100, 100] },
      rows: [
        { ref: "@f1e0", role: "list", name: "首页 关于", flags: [], bbox: [0, 0, 100, 40], frameId: 1 },
        { ref: "@f1e1", role: "menuitem", name: "首页", flags: [], bbox: [0, 0, 100, 20], frameId: 1 },
      ],
    };
    const oracles: OracleRect[] = [{ id: "home", rect: [100, 100, 100, 20] }];
    expect(checkManifest(p, oracles, homeManifest)).toHaveLength(0);
  });
});
