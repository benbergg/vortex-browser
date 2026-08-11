// act 失败携带恢复信息(2026-08-11 CC transcript 实证)。
//
// 日志实测:act 43 次 TIMEOUT 中 29 次 last reason=NOT_ATTACHED,其 target 27/29 是
// 自然语言(`查询按钮` / `取 消` / `左侧菜单「中差评跟踪管理」` /
// `cookie banner close button (X) in the "About our cookies" dialog`)。
// dispatch.ts 把非 @ref 的 target 原样当 CSS 下发 → 零命中 → 空转 2000ms →
// 报 TIMEOUT 且提示"Increase the timeout argument"——误导:真问题是"这不是选择器"。
// 同期该 target 重试成功 0 次,故调大默认超时无效;要改的是**失败要带候选**。
//
// 匹配(matchByDescriptor)必须精确以免点错元素;建议(本模块)可以宽松,因为它只给
// 人/LLM 读,不直接触发动作。故本模块的归一化比 normName 更激进:剥掉全部空白。

import { describe, it, expect } from "vitest";
import { scoreNameSimilarity, rankCandidates, buildNoMatchMessage } from "../src/action/candidate-suggest.js";

describe("scoreNameSimilarity", () => {
  it("完全相同得满分", () => {
    expect(scoreNameSimilarity("查询", "查询")).toBe(1);
  });

  it("剥空白后相同视为满分:`取 消` 应命中 `取消`", () => {
    // 日志真实样本:agent 抄了渲染文本,letter-spacing 让它读出一个空格
    expect(scoreNameSimilarity("取 消", "取消")).toBe(1);
  });

  it("target 多带修饰词时仍高分:`查询按钮` → `查询`", () => {
    expect(scoreNameSimilarity("查询按钮", "查询")).toBeGreaterThan(0.4);
  });

  it("英文长描述包含真名时给分:cookie banner close button… → Close", () => {
    const t = 'cookie banner close button (X) in the "About our cookies" dialog';
    expect(scoreNameSimilarity(t, "Close")).toBeGreaterThan(0.2);
  });

  it("大小写不敏感", () => {
    expect(scoreNameSimilarity("PAY MONTHLY", "Pay monthly")).toBe(1);
  });

  it("完全无关得 0 分", () => {
    expect(scoreNameSimilarity("查询按钮", "上传附件")).toBe(0);
  });

  it("空名字得 0 分,不参与排序", () => {
    expect(scoreNameSimilarity("查询", "")).toBe(0);
  });
});

describe("rankCandidates", () => {
  const cands = [
    { name: "上传附件", tag: "button" },
    { name: "查询", tag: "button" },
    { name: "高级查询条件", tag: "div" },
    { name: "", tag: "input" },
    { name: "导出", tag: "a" },
  ];

  it("按相似度降序,最相关的排第一", () => {
    const out = rankCandidates(cands, "查询按钮", 3);
    expect(out[0].name).toBe("查询");
  });

  it("尊重 limit", () => {
    expect(rankCandidates(cands, "查询按钮", 2).length).toBeLessThanOrEqual(2);
  });

  it("完全无重叠时返回空,不硬凑噪声", () => {
    // `.card-wrapper.card-expanded[id]` 是真 CSS 选择器,只是没命中;
    // 硬塞按名字排的候选只会误导。
    expect(rankCandidates(cands, ".card-wrapper.card-expanded[id]", 5)).toEqual([]);
  });

  it("同名多个候选都保留(交给调用方展示,不替它选)", () => {
    const dup = [{ name: "查询", tag: "button" }, { name: "查询", tag: "a" }];
    expect(rankCandidates(dup, "查询", 5).length).toBe(2);
  });
});

describe("buildNoMatchMessage", () => {
  it("点明 target 未命中且被当作 CSS 处理", () => {
    const msg = buildNoMatchMessage("查询按钮", [{ name: "查询", tag: "button", score: 0.6 }]);
    expect(msg).toContain("查询按钮");
    expect(msg).toMatch(/CSS/);
  });

  it("列出候选的名字与标签", () => {
    const msg = buildNoMatchMessage("查询按钮", [
      { name: "查询", tag: "button", score: 0.6 },
      { name: "高级查询条件", tag: "div", score: 0.3 },
    ]);
    expect(msg).toContain("查询");
    expect(msg).toContain("button");
    expect(msg).toContain("高级查询条件");
  });

  it("无候选时明确说没有相近名字,而不是沉默", () => {
    const msg = buildNoMatchMessage(".card-wrapper[id]", []);
    expect(msg).toMatch(/no element|未找到|无相近/i);
    expect(msg).not.toMatch(/undefined|\[object/);
  });

  it("不建议调大 timeout(该建议已被数据证伪:同 target 重试成功 0 次)", () => {
    const msg = buildNoMatchMessage("查询按钮", [{ name: "查询", tag: "button", score: 0.6 }]);
    expect(msg).not.toMatch(/increase.*timeout/i);
  });

  it("给出可执行的下一步(observe 取 @ref 或换合法 CSS)", () => {
    const msg = buildNoMatchMessage("查询按钮", [{ name: "查询", tag: "button", score: 0.6 }]);
    expect(msg).toMatch(/vortex_observe|@ref/);
  });
});
