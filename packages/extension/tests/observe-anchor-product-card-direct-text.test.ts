/**
 * Author: qingwa
 * Description: Regression lock for P1-1 (淘宝选品评测 V2/V3 §4 P1-1 仍存):
 * observe getAccessibleName 把含子链接的 `<a>` 整卡 (淘宝商品卡) 判为噪声容器
 * 返空名 → BUG-3 噪声过滤器丢弃 → 整卡在 observe 输出中变成 [link] "",
 * LLM 无法定位/操作商品卡。
 *
 * 触发场景（vortex-bench dogfood 2026-06-07 V2/V3 淘宝评测 §2 阶段 2）:
 *   淘宝搜索结果 153 个 `<a>` 中 47 个空名 (30.7%)。空名 `<a>` 都是
 *   `<a class="doubleCardWrapperAdapt">` 整卡是链接、内嵌店铺链接 + 旺旺按钮
 *   + 整片 product info。V1 报告 P1-1, V3 设计 §4 验证未修。
 *
 * 根因 (observe.ts:594-608, 现状):
 *   isContainer 用 querySelector("a[href],button,input,...") 判"有交互后代"
 *   即是容器。淘宝整卡 `<a>` 命中 → text = 子控件拼接 (标题+价格+销量+...)
 *   但被判容器丢弃 → 返空。
 *
 * V3 设计 §4 P1-1 修法(方案 1 首选, 评审纠正 V1/V2 原"仿 label 合成名"方向):
 *   **判 `<a>` 是否有直属文本节点**——有则用 textContent (信息最丰富),
 *   不需要合成。`<label>` 是空文本需合成兜底名 (radio=N @x,y);
 *   `<a>` 整卡是**自身有真实文本** (标题/价格), 两者语义相反, 照搬 label
 *   合成名逻辑是错的 (V2 评审 §3.2 关键纠正)。
 *
 * Why: 这是族级原语问题 (observe name 召回), 影响所有"整卡是链接"的
 * 电商列表 (淘宝/天猫/抖音/小红书/Pinterest card)。V1/V2/V3 三轮评测
 * 均验证, 30.7% 空名率。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("P1-1 修复: <a> 整卡是链接, 自身有直属文本, 不应被判空名 (vortex-bench 2026-06-07 淘宝评测)", () => {
  // ============================================================
  // 1. RED: 验证修复后代码含"判直属文本节点"分支
  //    (当前代码无此逻辑, 测试必失败)
  // ============================================================

  it("getAccessibleName 应含 'hasDirectText' 或 'childNodes' 判定 (<a> 直属文本分支)", () => {
    const hasDirectTextLogic =
      /hasDirectText|childNodes[\s\S]{0,200}?TEXT_NODE|nodeType\s*===\s*Node\.TEXT_NODE/;
    expect(OBSERVE_SRC).toMatch(hasDirectTextLogic);
  });

  it("判直属文本的分支应早于 isContainer 判容器 (顺序保证: 整卡自身有文本先用自身)", () => {
    // 直觉顺序: 先看自己有没有真文本 → 有就直接用; 没文本再判是不是容器
    const directTextIdx = OBSERVE_SRC.search(
      /hasDirectText|childNodes[\s\S]{0,200}?TEXT_NODE/,
    );
    const isContainerIdx = OBSERVE_SRC.indexOf("const isContainer =");
    expect(directTextIdx).toBeGreaterThan(0);
    expect(isContainerIdx).toBeGreaterThan(0);
    expect(directTextIdx).toBeLessThan(isContainerIdx);
  });

  // ============================================================
  // 2. 现有行为保留测试 — 修复不应破坏既有 isContainer 逻辑
  //    (focus wrapper 容器仍返空, 评审 §1.3 + GitHub AJ 旧修复)
  // ============================================================

  it("isContainer 容器判据 (AJ focus-wrapper 修复) 仍保留", () => {
    expect(OBSERVE_SRC).toMatch(
      /const isContainer\s*=\s*el\.querySelector\(\s*["']a\[href\],button,input,select,textarea,\[tabindex\],\[contenteditable=true\]["']/,
    );
  });

  it("isContainer=true 且无 label/title 时仍返空 (Ghost container 链路完整)", () => {
    expect(OBSERVE_SRC).toMatch(/if \(isContainer\) return "";/);
  });

  it("text 仅在非容器(leaf)时作名源 (现有 leaf 行为保留)", () => {
    expect(OBSERVE_SRC).toMatch(/if \(text && !isContainer\) return text;/);
  });
});
