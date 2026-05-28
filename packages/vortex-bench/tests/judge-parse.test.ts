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

  // M2 回归测试:前导内联对象不吞 misses
  it("M2 前导内联对象在前 — 取后面含 misses 的块", () => {
    const raw = 'foo {"note":"x"} {"misses":[{"label":"a","bbox":[1,2,3,4],"reason":"r"}]}';
    const r = parseJudgeResponse(raw);
    expect(r.map((m) => m.label)).toEqual(["a"]);
  });
  it("M2 纯 JSON 仍正常(无前导对象)", () => {
    const raw = '{"misses":[{"label":"btn","bbox":[0,0,50,20],"reason":"button"}]}';
    const r = parseJudgeResponse(raw);
    expect(r.map((m) => m.label)).toEqual(["btn"]);
  });
  it("M2 围栏内含 misses 仍正常", () => {
    const raw = '分析完毕:\n```json\n{"misses":[{"label":"link","bbox":[5,5,30,15],"reason":"链接"}]}\n```';
    const r = parseJudgeResponse(raw);
    expect(r.map((m) => m.label)).toEqual(["link"]);
  });
});
