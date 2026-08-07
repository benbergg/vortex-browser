import { defineConfig, configDefaults } from "vitest/config";

/** 只跑 spawn 真子进程的集成测试，且串行——它们彼此之间同样会抢 CPU。 */
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 60000,
  },
});
