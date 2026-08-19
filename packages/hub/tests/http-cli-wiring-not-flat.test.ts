import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Description: HTTP waiter 与 CLI abort 的**接线**不得退回扁平常量。
 *
 * 纯函数测试（http-waiter-per-action / abort-per-action）锁的是推导公式；
 * 把接线改回 `?? 35_000` 时它们照样全绿——复评实测过这个假绿。真行为测试要
 * 等 45 秒才能观察到 waiter，代价不成比例，故这里用源码级锚点补住那一环，
 * 并同时禁掉整文件里的 35_000 字面量（旧值一回来就红）。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

const HTTP_SRC = read("../src/http-routes.ts");
const CLI_SRC = read("../../cli/src/client.ts");

describe("阶梯接线不得退回扁平常量", () => {
  // 第二实参必须锚住：漏传 params.timeout 就是 hubFallbackMs 那个 High 搬到本层
  it("HTTP waiter 由 httpWaiterMsFor 推导，且把调用方 timeout 传进去", () => {
    expect(HTTP_SRC).toMatch(
      /virtualSessionRequestTimeoutMs\s*\?\?\s*httpWaiterMsFor\(\s*action,\s*params\.timeout\b/,
    );
  });

  it("CLI fetch abort 由 cliAbortMsFor 推导，且把调用方 timeout 传进去", () => {
    expect(CLI_SRC).toMatch(/cliAbortMsFor\(\s*action,\s*params\.timeout\b/);
    expect(CLI_SRC).toMatch(/AbortSignal\.timeout\(abortMs\)/);
  });

  it("两处都不再出现旧的扁平 35000", () => {
    for (const [name, src] of [["http-routes.ts", HTTP_SRC], ["cli/client.ts", CLI_SRC]] as const) {
      expect(src, `${name} 里出现 35000 字面量`).not.toMatch(/\b35_?000\b/);
    }
  });
});
