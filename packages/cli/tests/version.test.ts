import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createProgram, CLI_VERSION } from "../src/index.js";
import { readNearestVersion } from "../src/version.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

// 2.0.0 曾把 --version 写死成 "0.1.0"，与实际发布版本完全脱节
describe("vortex --version", () => {
  it("报告的是 package.json 的真实版本", () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it("program 用的就是这个版本，没有第二个来源", () => {
    expect(createProgram().version()).toBe(CLI_VERSION);
  });
});

// 固定相对路径会在其中一种布局下落空，这里两种都验
describe("readNearestVersion 对源码与产物两种布局", () => {
  const pkgRoot = new URL("../", import.meta.url);

  it("src/index.ts（距包根一级）", () => {
    expect(readNearestVersion(new URL("src/index.ts", pkgRoot).href)).toBe(pkg.version);
  });

  it("dist/src/index.js（距包根两级）", () => {
    expect(readNearestVersion(new URL("dist/src/index.js", pkgRoot).href)).toBe(pkg.version);
  });

  it("找不到时抛错而不是静默返回哨兵值", () => {
    expect(() => readNearestVersion(pathToFileURL("/index.js").href)).toThrow(/package\.json not found/);
  });
});
