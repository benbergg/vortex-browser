// packages/vortex-bench/tests/judge-parse.test.ts
import { describe, it, expect } from "vitest";
import { parseJudgeResponse } from "../src/runner/judge-parse.js";

describe("parseJudgeResponse", () => {
  it("纯 JSON", () => {
    const r = parseJudgeResponse('{"misses":[{"label":"搜索","bbox":[1,2,3,4],"reason":"放大镜"}]}');
    expect(r).toEqual([{ label: "搜索", bbox: [1, 2, 3, 4], reason: "放大镜" }]);
  });
  it("```json 围栏 + 前后散文", () => {
    const raw = 'Here:\n```json\n{"misses":[{"label":"x","bbox":[0,0,10,10],"reason":"r"}]}\n```\nDone.';
    expect(parseJudgeResponse(raw)).toHaveLength(1);
  });
  it("空 misses → []", () => {
    expect(parseJudgeResponse('{"misses":[]}')).toEqual([]);
  });
  it("非法 bbox(非 4 数 / 含 NaN)项丢弃", () => {
    const raw = '{"misses":[{"label":"a","bbox":[1,2,3],"reason":"r"},{"label":"b","bbox":[1,2,3,4],"reason":"r"}]}';
    const r = parseJudgeResponse(raw);
    expect(r.map((m) => m.label)).toEqual(["b"]);
  });
  it("缺字段项丢弃", () => {
    const raw = '{"misses":[{"bbox":[1,2,3,4]},{"label":"ok","bbox":[1,2,3,4],"reason":"r"}]}';
    expect(parseJudgeResponse(raw).map((m) => m.label)).toEqual(["ok"]);
  });
  it("无法解析的垃圾 → []", () => {
    expect(parseJudgeResponse("sorry I cannot")).toEqual([]);
  });
});
