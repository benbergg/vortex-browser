import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 两个 build 入口都不许清空 dist:Chrome 的 unpacked 扩展按路径加载,
 * 清空目录会让 manifest.json 在 build 期间整个消失。实测该配置为真时
 * 每次 build 都把 dist 内文件删除重建(birth time 全变)。
 */
const readSource = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("build 输出目录保留策略", () => {
  it("vite.config.ts 显式关闭 outDir 清空(省略也不行,vite 缺省会清)", () => {
    const source = readSource("../vite.config.ts");
    expect(source).toMatch(/emptyOutDir:\s*false/);
    expect(source).not.toMatch(/emptyOutDir:\s*true/);
  });

  it("build-page-side.mjs 同样关闭清空(否则会擦掉主 bundle 产物)", () => {
    const source = readSource("../scripts/build-page-side.mjs");
    expect(source).toMatch(/emptyOutDir:\s*false/);
    expect(source).not.toMatch(/emptyOutDir:\s*true/);
  });
});
