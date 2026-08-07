import { defineConfig, configDefaults } from "vitest/config";

/**
 * 默认 `test` 不跑 `*.integration.test.ts`。
 *
 * 那些用例真 spawn 子进程（MCP supervisor / server），与单测并行时抢 CPU，
 * 会把依赖短超时和性能阈值的用例挤到假失败。改由 `test:integration` 串行跑。
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
