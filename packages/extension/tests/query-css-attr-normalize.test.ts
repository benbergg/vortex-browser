import { describe, it, expect } from "vitest";
import { normalizeCssAttrParam } from "../src/handlers/query.js";

describe("normalizeCssAttrParam — query mode=css attr 归一化", () => {
  it("单属性字符串 → 单元素数组", () => {
    expect(normalizeCssAttrParam("class")).toEqual(["class"]);
  });
  it("竖线分隔多属性 → 拆分(修复 R11 静默空陷阱)", () => {
    expect(normalizeCssAttrParam("class|title")).toEqual(["class", "title"]);
  });
  it("逗号分隔多属性 → 拆分", () => {
    expect(normalizeCssAttrParam("class,title,href")).toEqual(["class", "title", "href"]);
  });
  it("逗号+空格 → trim", () => {
    expect(normalizeCssAttrParam("class, title")).toEqual(["class", "title"]);
  });
  it("数组原样保留", () => {
    expect(normalizeCssAttrParam(["class", "href"])).toEqual(["class", "href"]);
  });
  it("undefined → null", () => {
    expect(normalizeCssAttrParam(undefined)).toBeNull();
  });
  it("空串 → null(不生成 [\"\"] 畸形)", () => {
    expect(normalizeCssAttrParam("")).toBeNull();
  });
  it("纯空白 → null", () => {
    expect(normalizeCssAttrParam("   ")).toBeNull();
  });
  it("空段过滤 class|| → [class]", () => {
    expect(normalizeCssAttrParam("class||")).toEqual(["class"]);
  });
});
