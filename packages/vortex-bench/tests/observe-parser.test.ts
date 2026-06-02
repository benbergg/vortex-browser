// packages/vortex-bench/tests/observe-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseObserveSnapshot } from "../src/runner/observe-parser.js";

const SAMPLE = `SnapshotId: snap-abc
URL: http://localhost:5173/synth/cursor-pointer-div.html
Title: cursor pointer
Viewport: 1280x720, scrollY=0/2000

@h1:e0 [button] "保存" bbox=[10,20,80,30]
@h1:e1 [div] "打开菜单" [active] bbox=[100,200,120,40]
@h1:e2 [div] bbox=[300,400,50,50]
@h1:f1e0 [link] "子框按钮" bbox=[5,5,60,20]

# frame 1 scanned, 0 interactive elements (url=about:srcdoc)
# frame 1 offset=[40,400]`;

describe("parseObserveSnapshot", () => {
  it("解析头部 snapshotId / url / viewport", () => {
    const p = parseObserveSnapshot(SAMPLE);
    expect(p.header.snapshotId).toBe("snap-abc");
    expect(p.header.url).toContain("cursor-pointer-div.html");
    expect(p.header.viewport).toEqual({ width: 1280, height: 720, scrollY: 0, scrollHeight: 2000 });
  });

  it("解析带 name 的元素行", () => {
    const p = parseObserveSnapshot(SAMPLE);
    const r0 = p.rows[0];
    expect(r0.ref).toBe("@h1:e0");
    expect(r0.role).toBe("button");
    expect(r0.name).toBe("保存");
    expect(r0.bbox).toEqual([10, 20, 80, 30]);
    expect(r0.frameId).toBe(0);
  });

  it("解析 state flags", () => {
    const p = parseObserveSnapshot(SAMPLE);
    expect(p.rows[1].flags).toEqual(["active"]);
    expect(p.rows[1].name).toBe("打开菜单");
  });

  it("无 name 的行 name=null", () => {
    const p = parseObserveSnapshot(SAMPLE);
    expect(p.rows[2].name).toBeNull();
    expect(p.rows[2].role).toBe("div");
  });

  it("子 frame 行解析出 frameId", () => {
    const p = parseObserveSnapshot(SAMPLE);
    expect(p.rows[3].ref).toBe("@h1:f1e0");
    expect(p.rows[3].frameId).toBe(1);
  });

  it("解析 frame offset 行", () => {
    const p = parseObserveSnapshot(SAMPLE);
    expect(p.frameOffsets[1]).toEqual([40, 400]);
  });

  it("无 bbox 的行 bbox=null(无 includeBoxes 场景)", () => {
    const p = parseObserveSnapshot("SnapshotId: s\nURL: u\n\n@e0 [button] \"x\"");
    expect(p.rows[0].bbox).toBeNull();
  });

  it("容忍值域控件 value= 段不丢行(2026-06-02 dogfood W/X)", () => {
    // observe-render 给 slider/spinbutton/progressbar 注入 value= 段(裸 token
    // 或带引号),解析器须容忍跳过、行仍被识别(否则值域控件行整行失配被丢)。
    const text = `SnapshotId: s
URL: u

@e0 [slider] "音量" value=30/100
@e1 [spinbutton] "数量" [required] value=4
@e2 [slider] "评分" value="3 of 5 stars" bbox=[1,2,3,4]
@e3 [button] "普通"`;
    const p = parseObserveSnapshot(text);
    expect(p.rows).toHaveLength(4);
    expect(p.rows[0].role).toBe("slider");
    expect(p.rows[0].name).toBe("音量");
    // value= 后仍能解析 flags 与 bbox。
    expect(p.rows[1].flags).toEqual(["required"]);
    expect(p.rows[2].name).toBe("评分");
    expect(p.rows[2].bbox).toEqual([1, 2, 3, 4]);
    expect(p.rows[3].name).toBe("普通");
  });

  it("容忍含冒号的排序 flag [sort:asc] 不丢行(2026-06-02 dogfood AC)", () => {
    // observe-render 给可排序列注入 [sort:asc]/[sort:desc]/[sortable]。
    // 旧 flag 正则 [a-z]+ 不含冒号 → [sort:asc] 让整行失配被静默丢。
    const text = `SnapshotId: s
URL: u

@e0 [columnheader] "姓名" [sort:asc]
@e1 [columnheader] "年龄" [sort:desc] bbox=[1,2,3,4]
@e2 [columnheader] "城市" [sortable]
@e3 [columnheader] "普通"`;
    const p = parseObserveSnapshot(text);
    expect(p.rows).toHaveLength(4);
    expect(p.rows[0].flags).toEqual(["sort:asc"]);
    expect(p.rows[1].flags).toEqual(["sort:desc"]);
    expect(p.rows[1].bbox).toEqual([1, 2, 3, 4]);
    expect(p.rows[2].flags).toEqual(["sortable"]);
    expect(p.rows[3].name).toBe("普通");
  });
});
