// @vitest-environment jsdom
/**
 * Description: N0002 B004 — 大页 candidate 遍历的时间预算早退。密集型 SPA(antd Pro / bytenew
 *   客服工单详情页)单帧可扫到 4000+ 候选元素,后续循环(名称质量评估、AX overlay 关联等)累加
 *   主线程耗时,Tab 卡顿。修复:candidate 遍历带时间预算,超时即停止收集并打 # truncated-meta。
 *   本测试直测模块级纯函数 collectWithBudget(cands, max, budgetMs, now)。
 */
import { describe, it, expect } from "vitest";
import { collectWithBudget } from "../src/handlers/observe.js";

describe("observe-time-budget: collectWithBudget (N0002 B004)", () => {
  it("1000 cands + 每次 now() 自增 20ms + budget=8000ms → 超时且 processed<1000", () => {
    const cands = Array.from({ length: 1000 }, (_, i) => i);
    let t = 0;
    const now = () => {
      t += 20;
      return t;
    };
    const r = collectWithBudget(cands, 2000, 8000, now);
    expect(r.timeBudgetHit).toBe(true);
    expect(r.processed).toBeLessThan(1000);
    expect(r.limit).toBe(2000);
  });

  it("10 cands + now() 恒 0 → 不超时,全部处理", () => {
    const cands = Array.from({ length: 10 }, (_, i) => i);
    const r = collectWithBudget(cands, 2000, 8000, () => 0);
    expect(r.timeBudgetHit).toBe(false);
    expect(r.processed).toBe(10);
    expect(r.limit).toBe(2000);
  });

  it("max=80 + now() 恒 0 + 1000 cands → 在 i>=80 处 break,processed=80, timeBudgetHit=false", () => {
    const cands = Array.from({ length: 1000 }, (_, i) => i);
    const r = collectWithBudget(cands, 80, 8000, () => 0);
    expect(r.processed).toBe(80);
    expect(r.timeBudgetHit).toBe(false);
    expect(r.limit).toBe(80);
  });

  it("空 cands → processed=0, 不超时", () => {
    const r = collectWithBudget<number>([], 2000, 8000, () => 0);
    expect(r.processed).toBe(0);
    expect(r.timeBudgetHit).toBe(false);
  });

  it("第一项就超时(budget=0) → processed=0, timeBudgetHit=true", () => {
    const cands = [1, 2, 3];
    let t = 0;
    const now = () => {
      t += 1;
      return t;
    };
    const r = collectWithBudget(cands, 2000, 0, now);
    expect(r.processed).toBe(0);
    expect(r.timeBudgetHit).toBe(true);
  });

  it("timeBudgetHit 优先于 max:cands=1000, max=100, budget=10ms, now() 自增 5ms → 第 3 次判超时", () => {
    const cands = Array.from({ length: 1000 }, (_, i) => i);
    let t = 0;
    const now = () => {
      t += 5;
      return t;
    };
    const r = collectWithBudget(cands, 100, 10, now);
    expect(r.timeBudgetHit).toBe(true);
    expect(r.processed).toBeLessThanOrEqual(100);
  });
});