/**
 * Author: qingwa
 * Description: V4 淘宝选品评测 BUG-008 修复: observe 不再漏抓淘宝详情页
 *   sticky bar CTA (div 容器, 内部含购物车 icon)。
 *
 * 背景 (V4 报告 §7.4 BUG-008): 淘宝详情页 "领券购买"/"加入购物车" 按钮
 *   是 <div class="btnItem--NstK3Os1"> 含 <i class="icon-taobaojiarugouwuche-xianxing">,
 *   filter=interactive 默认排除 div, observe 漏抓, vortex_act 跑不通。
 *
 * 修复方案 (V4 推荐方案 2): icon className 反推 — 扫描 <i> 含 gouwuche /
 *   jiaRu 关键词, 反推父 div 为 CTA, 纳入 observe interactive 列表。
 *
 * 限制:
 *   - 仅在 filter=interactive 启用, 避免噪音 div 污染 default 输出
 *   - 仅扫描 <i> 元素, 排除 svg/img 装饰 (复用 iconNameFromClass 纪律)
 *   - div 内若含真交互后代 (a/button/input) 则跳过, 避免双现
 *   - div 父级若是已入池元素则跳过, 避免祖先链重复
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

describe("BUG-008 修复 (V4 评测): observe 不再漏抓淘宝 sticky bar div CTA", () => {
  it("observe.ts 应含 icon className 关键词反推 CTA 逻辑 (gouwuche|jiaRu|addToCart)", () => {
    const hasIconHeuristic =
      /gouwuche|jiaRu|addToCart|add_to_cart|jiarugouwuche/i.test(OBSERVE_SRC);
    expect(hasIconHeuristic).toBe(true);
  });

  it("icon heuristic 应识别淘宝 icon class 模式 (icon-taobaojiarugouwuche-*)", () => {
    const matchesTaobaoIcon =
      /icon-taobao|jiarugouwuche|taobaogouwuche|taobaojia/i.test(OBSERVE_SRC);
    expect(matchesTaobaoIcon).toBe(true);
  });

  it("icon heuristic 应仅在 filter=interactive 时启用, 避免噪音 div 污染 default 输出", () => {
    // 启发式扫描应与 filter === "interactive" 守卫共存
    // 不应是 unconditional (filter=all 时也跑会污染 default 输出)
    expect(OBSERVE_SRC).toMatch(/gouwuche|jiaRu/);
    // 关键字与 filter 守卫应在同一函数 / 分支里
    // (不是分散的 dead code)
    const filterGuardBlocks = OBSERVE_SRC.match(
      /filter\s*===\s*["']interactive["'][\s\S]{0,500}?gouwuche|jiaRu|addToCart/g,
    );
    expect(filterGuardBlocks, "icon heuristic 应在 filter=interactive 分支内启用").toBeTruthy();
  });

  it("icon heuristic 应仅作用于 div 元素 (不污染 span/section/article 等)", () => {
    // div 是淘宝 sticky bar CTA 的容器, 其他 tag 误判风险更高
    // 通过源码切片验证: heuristic 起点应包含 tagName === "DIV" 判定
    const heuristicRegion = extractHeuristicRegion(OBSERVE_SRC);
    expect(heuristicRegion, "未找到 icon heuristic 区域").toBeTruthy();
    expect(heuristicRegion).toMatch(/tagName\s*===\s*["']DIV["']|tagName\.toLowerCase\(\)\s*===\s*["']div["']/);
  });

  it("icon heuristic 应复用 <i> 子节点扫描 (不污染 svg/img 装饰)", () => {
    const heuristicRegion = extractHeuristicRegion(OBSERVE_SRC);
    expect(heuristicRegion).toBeTruthy();
    // 应查 <i> 而非 svg/img (iconNameFromClass 查 svg/img 是另一路径)
    expect(heuristicRegion).toMatch(/querySelector(?:All)?\(\s*["']i\[/);
  });

  it("icon heuristic 应避免双现: div 内有真交互后代 (a/button/input) 时跳过", () => {
    const heuristicRegion = extractHeuristicRegion(OBSERVE_SRC);
    expect(heuristicRegion).toBeTruthy();
    // div 内含 INTERACTIVE_SELECTORS 元素 → 跳过 (避免与子控件双现)
    // INTERACTIVE_SELECTORS 包含 a/button/input/select 等
    expect(heuristicRegion).toMatch(
      /INTERACTIVE_SELECTORS|querySelector\(\s*["'][^"']*(?:a\[href\]|button|input)/,
    );
  });
});

/**
 * 从源码中提取 icon heuristic 区域 — 取所有提到 gouwuche / jiaRu 的位置,
 * 合并前后 200 字符作为启发式作用域。
 */
function extractHeuristicRegion(src: string): string | null {
  const re = /gouwuche|jiaRu|addToCart|add_to_cart|jiarugouwuche/i;
  const m = re.exec(src);
  if (!m) return null;
  return src.slice(Math.max(0, m.index - 200), m.index + 800);
}
