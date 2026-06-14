// --caps CLI 解析健壮性测试（PART 1）。

import { describe, it, expect } from "vitest";
import { parseCapsArg } from "../src/server.js";

describe("parseCapsArg", () => {
  it("无 --caps → 空数组（默认面，零回归）", () => {
    expect(parseCapsArg([])).toEqual([]);
    expect(parseCapsArg(["--port", "6800", "foo"])).toEqual([]);
  });

  it("等号形式 --caps=a,b → 拆分去空", () => {
    expect(parseCapsArg(["--caps=testing"])).toEqual(["testing"]);
    expect(parseCapsArg(["--caps=testing,debug"])).toEqual(["testing", "debug"]);
  });

  it("空格形式 --caps a,b", () => {
    expect(parseCapsArg(["--caps", "testing,debug"])).toEqual(["testing", "debug"]);
  });

  it("空值 / 全逗号 → 空数组（不崩）", () => {
    expect(parseCapsArg(["--caps="])).toEqual([]);
    expect(parseCapsArg(["--caps=,,"])).toEqual([]);
    expect(parseCapsArg(["--caps=  ,  "])).toEqual([]);
  });

  it("trim 每段空白", () => {
    expect(parseCapsArg(["--caps= testing , debug "])).toEqual(["testing", "debug"]);
  });

  it("多个 --caps 合并去重", () => {
    expect(parseCapsArg(["--caps=testing", "--caps=debug,testing"])).toEqual([
      "testing",
      "debug",
    ]);
  });

  it("--caps 在末尾无值 → 不崩，忽略", () => {
    expect(parseCapsArg(["--port", "6800", "--caps"])).toEqual([]);
  });
});
