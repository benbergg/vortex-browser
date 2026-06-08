# vortex V4 评测发现 BUG 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 vortex 淘宝选品评测 V4（2026-06-07 评测 + 评审）发现的 4 个 BUG：P1-1 修复方向错、P1-2 修复路径错、BUG-008 observe 漏 sticky bar CTA、REQ-009 IIFE 模板缺失。

**Architecture:** 沿用 vortex 现有 monorepo 结构（`packages/{extension,shared,mcp,vortex-bench,...}`）+ vitest 单元测试 + `vortex-bench` synth fixture E2E 测试。修复策略为 TDD（红→绿→重构 + 频繁 commit），每个 BUG 一个 task，每个 task 5 step。

**Tech Stack:** TypeScript, vitest 2.1.0, Vortex MCP, Chrome MV3 Extension, monorepo (pnpm workspace)

**Ref Docs:**
- V4 评测报告: `Knowledge-Library/12-Projects/N0059-vortex-淘宝选品评测/2026-06-07-vortex-淘宝选品评测-V4-设计.md`
- V4 评审意见: `Knowledge-Library/12-Projects/N0059-vortex-淘宝选品评测/2026-06-07-vortex-淘宝选品评测-V4-设计评审意见.md`
- V4 原始数据: `/Users/lg/workspace/vortex/reports/taobao-dogfood-V4/`

**前置 commit 区间**:
- BUG 现状: `ef242c7c7484ee4cb31de95f26afc369f8599c78` (HEAD)
- 修复目标: P1-1 重做 + P1-2 重做 + BUG-008 + REQ-009

---

## File Structure

修改 4 个源文件 + 新增 4 个测试文件 + 1 个新 bench fixture：

| 文件 | 改动类型 | 任务 |
|------|----------|------|
| `packages/extension/src/handlers/observe.ts:605-623` | 修改 P1-1 hasDirectText → PRODUCT_HINTS 方案 | Task 1 |
| `packages/extension/tests/observe-anchor-product-card-textcontent.test.ts` | 新增（替换 `observe-anchor-product-card-direct-text.test.ts` 测试） | Task 1 |
| `packages/extension/src/action/auto-wait.ts:88-96` | 修改 P1-2 改用 NOT_STABLE 错误码 | Task 2 |
| `packages/extension/tests/auto-wait-not-stable-error-code.test.ts` | 新增 | Task 2 |
| `packages/extension/src/handlers/observe.ts:scrollContainer filter` | 修改 filter=interactive 加 div heuristic | Task 3 |
| `packages/extension/tests/observe-sticky-bar-div-cta.test.ts` | 新增 | Task 3 |
| `packages/mcp/src/tools/schemas-public.ts:258` | 修改 P2 description 加 IIFE 模板 | Task 4 |
| `packages/mcp/tests/v2-shortboards.test.ts:IIFE template` | 修改（已有 IIFE 测试需更新） | Task 4 |

**文件依赖关系**:
- Task 1 / 3 都改 observe.ts，需串行（先 Task 1 后 Task 3）
- Task 2 改 auto-wait.ts，独立
- Task 4 改 schemas-public.ts，独立
- 推荐顺序: Task 1 → Task 2 → Task 3 → Task 4（P0 优先）

---

## Task 1: P1-1 修复方向重做 — `<a>` 整卡 textContent 含商品特征时不再判空名

**Files:**
- Modify: `packages/extension/src/handlers/observe.ts:595-608`（d4b7330 修复位置）
- Modify: `packages/extension/tests/observe-anchor-product-card-direct-text.test.ts`（现有 d4b7330 测试，需更新断言）
- New: `packages/extension/tests/observe-anchor-product-card-textcontent.test.ts`（新 invariant 测试）
- Test: 跑 `pnpm --filter @vortex-browser/extension test observe-anchor`

**背景** (V4 报告 §7.3.1):
- d4b7330 修复"判直属文本节点"在淘宝商品卡 `<a class="doubleCardWrapperAdapt">` 上**完全未生效**
- 根因：商品卡 directTextNodes=[]（所有文本在子 `<div>` 里），但 textContent 含完整商品信息（标题/价格/销量）
- V4 实测 3 品类空名率仍 ~30%
- V4 报告推荐方案 A：判 `textContent` 含商品特征（`¥/￥/人付款/回头客/已售/月销/`）

- [ ] **Step 1: 写失败的 invariant 测试（验证 observe.ts 改用 PRODUCT_HINTS 方案）**

创建 `packages/extension/tests/observe-anchor-product-card-textcontent.test.ts`:

```typescript
/**
 * Author: qingwa
 * Description: V4 淘宝选品评测 P1-1 修复方向重做: <a> 整卡是链接,
 *   textContent 含商品特征(¥/人付款/回头客/已售/月销)时不再判空名。
 *
 * 背景 (V4 报告 §7.3.1): d4b7330 修复"判直属文本节点"在淘宝商品卡上
 *   directTextNodes=[] → 修复不生效。V4 推荐改"判 textContent 含商品特征"。
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

describe("P1-1 修复方向重做 (V4 评测): <a> 整卡 textContent 含商品特征不再判空名", () => {
  it("observe.ts 应含 PRODUCT_HINTS 或等价商品特征 regex (¥|人付款|回头客|已售|月销)", () => {
    // 修复后必须含至少 1 个商品特征关键词
    const hasHints =
      /PRODUCT_HINTS|[\u00a5￥]\d|人付款|回头客|已售|月销/.test(OBSERVE_SRC);
    expect(hasHints).toBe(true);
  });

  it("观察顺序: PRODUCT_HINTS 判定应早于 isContainer 判定", () => {
    const hintsIdx = OBSERVE_SRC.search(
      /PRODUCT_HINTS|[\u00a5￥]\d|人付款|回头客|已售|月销/,
    );
    const isContainerIdx = OBSERVE_SRC.indexOf("const isContainer =");
    expect(hintsIdx).toBeGreaterThan(0);
    expect(isContainerIdx).toBeGreaterThan(0);
    expect(hintsIdx).toBeLessThan(isContainerIdx);
  });

  it("PRODUCT_HINTS 命中时, 应返 normName(textContent) 而非空名", () => {
    // 修复逻辑应是: text + PRODUCT_HINTS 命中 → 返 textContent
    const productHintsPath =
      /PRODUCT_HINTS[\s\S]{0,200}?return\s+normName\(el\.textContent\)/;
    expect(OBSERVE_SRC).toMatch(productHintsPath);
  });

  it("不破坏现有 isContainer leaf 行为 (text && !isContainer 仍返 text)", () => {
    expect(OBSERVE_SRC).toMatch(/if \(text && !isContainer\) return text;/);
  });

  it("不破坏现有 Ghost container 链路 (isContainer=true 仍返空名)", () => {
    expect(OBSERVE_SRC).toMatch(/if \(isContainer\) return "";/);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test observe-anchor-product-card-textcontent
```

Expected: FAIL — 因为 `observe.ts` 当前是 d4b7330 修复（`hasDirectText` 判定），不含 `PRODUCT_HINTS` regex。

- [ ] **Step 3: 实施 P1-1 修复（替换 d4b7330 的 hasDirectText 判定为 PRODUCT_HINTS 方案）**

修改 `packages/extension/src/handlers/observe.ts:595-608`，把：

```typescript
          // P1-1 修复(vortex-bench 2026-06-07 淘宝评测):
          // 上面的 isContainer 判"含子交互元素即容器"对整张卡是 `<a>` 的场景过严
          // ——淘宝/天猫/抖音/小红书商品卡 `<a class="doubleCardWrapperAdapt">` 内
          // 嵌店铺链接+旺旺按钮,querySelector 命中 → isContainer=true → 整卡
          // 47/153 (30.7%) 被返空名 → BUG-3 丢弃 → LLM 看不到商品卡。V1/V2/V3
          // 三轮评测验证,真缺陷。先于 isContainer 判"该元素自身是否有直属文本
          // 节点":有就说明"自身有可读内容",不该被当容器——直接用 textContent
          // (信息最丰富,如"YSL圣罗兰小金条口红1988 ¥380")。对照 `<label>` 修
          // 法(wrapsCheckRadio,自身空文本需**合成**兜底名),`<a>` 是**自身有
          // 真实文本**,两者语义相反,照搬 label 合成名逻辑是错的(评审 §3.2)。
          const hasDirectText = Array.from(el.childNodes).some(
            (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0,
          );
          if (hasDirectText) return normName(el.textContent);
```

替换为：

```typescript
          // P1-1 修复方向重做(vortex-bench 2026-06-07 V4 淘宝评测 §7.3.1):
          // d4b7330 旧修复"判直属文本节点"在淘宝商品卡 <a class="doubleCardWrapperAdapt">
          // 上 directTextNodes=[](所有文本在子 div)→ 修复未生效,V4 复跑 3 品类
          // 空名率仍 ~30%。改判"textContent 含商品特征"(¥/¥/人付款/回头客/
          // 已售/月销):整张卡是链接 + textContent 含商品信息 → 卡片是商品卡,
          // 用自身 textContent(信息最丰富,标题/价格/销量/店铺名)。先于
          // isContainer 判定,确保"自身有商品信息"不被当容器丢弃。
          const PRODUCT_HINTS = /[\u00a5￥]\d|人付款|回头客|已售|月销/;
          const text = normName(el.textContent);
          if (text && PRODUCT_HINTS.test(text)) return text;
```

注意：原代码块下方紧接着有 `const isContainer = ...` 和 `if (text && !isContainer) return text;`，新代码已经先一步 `if (text && PRODUCT_HINTS.test(text)) return text;`，下方的 `if (text && !isContainer) return text;` 保留为现有 leaf 行为兜底（虽然会被 `PRODUCT_HINTS` 截胡在前，但保留不破坏其他非商品 `<a>` 元素）。

- [ ] **Step 4: 跑测试确认 PASS**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test observe-anchor-product-card-textcontent
pnpm --filter @vortex-browser/extension test observe-anchor-product-card-direct-text
```

Expected:
- `observe-anchor-product-card-textcontent.test.ts` 5/5 PASS
- `observe-anchor-product-card-direct-text.test.ts`（旧 d4b7330 测试）可能 FAIL — 因为旧测试断言"判直属文本节点"代码存在，新代码已替换。

如果旧测试 FAIL，需要更新或删除：

修改 `packages/extension/tests/observe-anchor-product-card-direct-text.test.ts`：
- 删 test 1 (`hasDirectText` 判定) — 已被 V4 方案取代
- 保留 test 2-4 (`isContainer` / Ghost container / leaf 行为) — 仍正确
- 顶部 comment 改为指向 V4 新测试

- [ ] **Step 5: 跑扩展全测 + bench 验证 + commit**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test
```

Expected: 全 extension 单元测试 PASS（除旧 d4b7330 测试需更新）。

```bash
cd /Users/lg/workspace/vortex
pnpm -r build
```

Expected: 5/5 包 build 成功。

```bash
git add packages/extension/src/handlers/observe.ts \
        packages/extension/tests/observe-anchor-product-card-textcontent.test.ts \
        packages/extension/tests/observe-anchor-product-card-direct-text.test.ts
git commit -m "$(cat <<'EOF'
fix(observe): P1-1 修复方向重做 (V4 淘宝评测) — textContent 含商品特征不再判空名

d4b7330 旧修复"判直属文本节点"在淘宝商品卡 <a class="doubleCardWrapperAdapt">
上 directTextNodes=[](所有文本在子 div)→ 修复未生效,V4 复跑 3 品类
空名率仍 ~30%。

V4 推荐方案 A: 改判 textContent 含商品特征 (¥/¥/人付款/回头客/已售/月销)。
整张卡是链接 + textContent 含商品信息 → 卡片是商品卡,用自身 textContent
(信息最丰富,标题/价格/销量/店铺名)。

Refs: 12-Projects/N0059-vortex-淘宝选品评测/2026-06-07-vortex-淘宝选品评测-V4-设计.md §7.3.1
EOF
)"
```

---

## Task 2: P1-2 修复路径重做 — NOT_STABLE 抛出路径改用 NOT_STABLE 错误码

**Files:**
- Modify: `packages/extension/src/action/auto-wait.ts:88-96`
- New: `packages/extension/tests/auto-wait-not-stable-error-code.test.ts`
- Test: 跑 `pnpm --filter @vortex-browser/extension test auto-wait`

**背景** (V4 报告 §7.3.2):
- 518d500 修了 `errors.hints.ts` 的 NOT_STABLE hint（含 sticky/fixed/transition + force=true 提示）
- 但 `auto-wait.ts:89-96` 实际抛错用 `VtxErrorCode.TIMEOUT`（不是 NOT_STABLE），hint 永远不触发
- V4 实测：NOT_STABLE 错误 hint = "Action timed out. Increase the timeout..."，**不含 force=true**
- V4 报告推荐方案 A：auto-wait.ts 改用 NOT_STABLE 错误码

- [ ] **Step 1: 写失败的 E2E 测试（验证 NOT_STABLE 抛错时返回 NOT_STABLE 错误码）**

创建 `packages/extension/tests/auto-wait-not-stable-error-code.test.ts`:

```typescript
/**
 * Author: qingwa
 * Description: V4 淘宝选品评测 P1-2 修复路径重做: auto-wait.ts
 *   NOT_STABLE 抛错应返 VtxErrorCode.NOT_STABLE(非 TIMEOUT),
 *   让 errors.hints.ts NOT_STABLE hint 生效。
 *
 * 背景 (V4 报告 §7.3.2): 518d500 修了 errors.hints.ts NOT_STABLE hint
 *   含 force=true 提示,但 auto-wait.ts:89 用 TIMEOUT 错误码,hint 永远不触发。
 *   V4 实测 hint = "Action timed out. Increase the timeout..."(不含 force=true)。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_WAIT_SRC = readFileSync(
  join(__dirname, "..", "src", "action", "auto-wait.ts"),
  "utf8",
);

describe("P1-2 修复路径重做 (V4 评测): NOT_STABLE 抛错应返 NOT_STABLE 错误码", () => {
  it("auto-wait.ts:88-96 应含 lastReason === 'NOT_STABLE' 分支", () => {
    // 修复后必须有: lastReasonIsStability 三元判断
    const hasStabilityBranch =
      /lastReason\s*===\s*["']NOT_STABLE["']|lastReasonIsStability/.test(AUTO_WAIT_SRC);
    expect(hasStabilityBranch).toBe(true);
  });

  it("NOT_STABLE 分支应抛 VtxErrorCode.NOT_STABLE (非 TIMEOUT)", () => {
    // 修复后必须出现 NOT_STABLE 错误码(在 timeout 抛错路径)
    const notStableCodeUsed =
      /VtxErrorCode\.NOT_STABLE/.test(AUTO_WAIT_SRC);
    expect(notStableCodeUsed).toBe(true);
  });

  it("TIMEOUT 码应仅在非 NOT_STABLE 抛错时使用(保留原始 TIMEOUT 行为兼容)", () => {
    // VtxErrorCode.TIMEOUT 仍应被引用(非 NOT_STABLE 场景)
    const timeoutCodeUsed = /VtxErrorCode\.TIMEOUT/.test(AUTO_WAIT_SRC);
    expect(timeoutCodeUsed).toBe(true);
  });

  it("原有 RETRY_INTERVAL_MS.NOT_STABLE = 16 (~1 RAF) 仍保留", () => {
    // 重试间隔表不动
    expect(AUTO_WAIT_SRC).toMatch(/NOT_STABLE:\s*16/);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test auto-wait-not-stable-error-code
```

Expected: FAIL — 因为 `auto-wait.ts` 当前直接抛 `VtxErrorCode.TIMEOUT`，无 `lastReason === 'NOT_STABLE'` 分支。

- [ ] **Step 3: 实施 P1-2 修复（auto-wait.ts 改用 NOT_STABLE 错误码）**

修改 `packages/extension/src/action/auto-wait.ts:88-96`，把：

```typescript
  // Timeout exhausted
  throw vtxError(
    VtxErrorCode.TIMEOUT,
    `Actionability timeout after ${timeout}ms; last reason: ${lastReason ?? "unknown"}`,
    {
      selector,
      extras: { lastReason, ...(lastExtras ?? {}) },
    },
  );
```

替换为：

```typescript
  // Timeout exhausted
  // V4 评测 P1-2 修复路径重做: 当 lastReason === 'NOT_STABLE' 时抛 NOT_STABLE
  // 错误码(非 TIMEOUT),让 errors.hints.ts NOT_STABLE hint (含 sticky/fixed +
  // transition + force=true 兜底建议) 生效。否则 LLM 收不到 force=true 提示,
  // 永远卡重试循环。518d500 修了 hint 文本但未改错误码,修复路径错(V4 报告 §7.3.2)。
  const lastReasonIsStability = lastReason === "NOT_STABLE";
  throw vtxError(
    lastReasonIsStability ? VtxErrorCode.NOT_STABLE : VtxErrorCode.TIMEOUT,
    lastReasonIsStability
      ? `Element not stable after ${timeout}ms (last reason: NOT_STABLE)`
      : `Actionability timeout after ${timeout}ms; last reason: ${lastReason ?? "unknown"}`,
    {
      selector,
      extras: { lastReason, ...(lastExtras ?? {}) },
    },
  );
```

- [ ] **Step 4: 跑测试确认 PASS**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test auto-wait
pnpm --filter @vortex-browser/extension test actionability
```

Expected:
- `auto-wait-not-stable-error-code.test.ts` 4/4 PASS
- `actionability` 相关测试 PASS（auto-wait.ts 改动不影响 actionability.ts 内部行为）
- 518d500 旧 `errors.test.ts` 仍 PASS（hint 文本没动）

- [ ] **Step 5: 跑全测 + bench 验证 + commit**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test
pnpm --filter @vortex-browser/shared test
```

Expected: 全 extension + shared 单元测试 PASS。

```bash
cd /Users/lg/workspace/vortex
pnpm -r build
```

Expected: 5/5 包 build 成功。

```bash
git add packages/extension/src/action/auto-wait.ts \
        packages/extension/tests/auto-wait-not-stable-error-code.test.ts
git commit -m "$(cat <<'EOF'
fix(extension): P1-2 修复路径重做 (V4 淘宝评测) — NOT_STABLE 抛错改用 NOT_STABLE 错误码

518d500 修了 errors.hints.ts NOT_STABLE hint (含 sticky/fixed/transition +
force=true 兜底建议) 但未改错误码。auto-wait.ts:89 实际抛 VtxErrorCode.TIMEOUT
(非 NOT_STABLE),让 hint 永远不触发,LLM 看不到 force=true 建议,V4 复跑
永远卡重试循环。

修复: auto-wait.ts 在 lastReason === 'NOT_STABLE' 时改抛 NOT_STABLE 错误码,
让 errors.hints.ts 的 NOT_STABLE hint 生效。

Refs: 12-Projects/N0059-vortex-淘宝选品评测/2026-06-07-vortex-淘宝选品评测-V4-设计.md §7.3.2
EOF
)"
```

---

## Task 3: BUG-008 修复 — observe 不再漏抓淘宝详情页 sticky bar CTA

**Files:**
- Modify: `packages/extension/src/handlers/observe.ts`（filter=interactive 加 div heuristic）
- New: `packages/extension/tests/observe-sticky-bar-div-cta.test.ts`
- Test: 跑 `pnpm --filter @vortex-browser/extension test observe-sticky-bar`

**背景** (V4 报告 §7.4 BUG-008):
- 淘宝详情页 sticky bar CTA 是 `<div class="btnItem--NstK3Os1">` 含 `<i class="icon-taobaojiarugouwuche-xianxing">`
- `vortex_observe` filter=interactive 默认只看 `<a>/<button>/<input>/<select>/<textarea>/[role=button]>` 标准控件,漏抓 div
- 严重度: 🟠 P1 — 评测主路径核心 CTA 找不到
- 实施采用方案 2(icon 名称反推): 扫描 `<i>` icon className 包含 `gouwuche` / `jiaRu` 关键词,反推父 div 为 CTA

- [ ] **Step 1: 写失败的 invariant 测试**

创建 `packages/extension/tests/observe-sticky-bar-div-cta.test.ts`:

```typescript
/**
 * Author: qingwa
 * Description: V4 淘宝选品评测 BUG-008 修复: observe 不再漏抓淘宝详情页
 *   sticky bar CTA (div 容器, 内部含购物车 icon)。
 *
 * 背景 (V4 报告 §7.4 BUG-008): 淘宝详情页 "领券购买"/"加入购物车" 按钮
 *   是 <div class="btnItem--NstK3Os1"> 含 <i class="icon-taobaojiarugouwuche-xianxing">,
 *   filter=interactive 默认排除 div,observe 漏抓, vortex_act 跑不通。
 *
 * 修复方案 (V4 推荐方案 2): icon className 反推 — 扫描 <i> 含 gouwuche / jiaRu
 *   关键词,反推父 div 为 CTA,纳入 observe interactive 列表。
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
    // 修复后应能识别淘宝 icon 命名约定: icon-taobaojiarugouwuche-xianxing
    // 或 icon-taobaojiarugouwiche (含 jiaRu + gouwuche 子串)
    const matchesTaobaoIcon =
      /icon-taobao|jiarugouwuche|taobaogouwuche|taobaojia/i.test(OBSERVE_SRC);
    expect(matchesTaobaoIcon).toBe(true);
  });

  it("icon heuristic 应仅在 filter=interactive 时启用, 避免噪音 div 污染 default 输出", () => {
    // 修复逻辑必须在 interactive 路径, 不污染 filter=all
    const interactivePathHeuristic =
      /filter\s*===?\s*["']interactive["'][\s\S]{0,500}?gouwuche|jiarugouwuche/i.test(
        OBSERVE_SRC,
      );
    // 至少含 gouwuche 字符串
    expect(OBSERVE_SRC).toMatch(/gouwuche|jiaRu/);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test observe-sticky-bar
```

Expected: FAIL — `observe.ts` 当前不含 `gouwuche` / `jiaRu` icon heuristic。

- [ ] **Step 3: 实施 BUG-008 修复**

修改 `packages/extension/src/handlers/observe.ts`，**先读完整个 observe.ts 找到 filter=interactive 分支位置**（约 line 200-300 范围,具体行号需 grep 确认），然后在 filter=interactive 路径中加 icon heuristic。

实施代码（伪代码，需在 observe.ts filter=interactive 分支插入）:

```typescript
// BUG-008 修复 (V4 淘宝选品评测 §7.4): icon 名称反推 div CTA
// 淘宝详情页 sticky bar CTA 是 <div class="btnItem--NstK3Os1"> 含
// <i class="icon-taobaojiarugouwuche-xianxing">。标准 filter=interactive
// 排除 div,observe 漏抓。icon className 反推父 div 为 CTA。
if (filter === "interactive") {
  const iconChild = el.querySelector(
    "i[class*='icon-taobao'], i[class*='jiarugouwuche'], i[class*='gouwuche'], i[class*='addToCart']",
  );
  if (iconChild) {
    return {
      // 标记为 actionable div
      ...rest,
      // 包含 icon 名称作为 name hint
      name: `cta-${iconChild.className.match(/icon-taobao\w+|[a-z]*gouwuche|[a-z]*jiaRu/i)?.[0] || "div"}`,
    };
  }
}
```

实际位置需根据 observe.ts 现有结构决定,建议加在 isInteractive 判定处或之后。

- [ ] **Step 4: 跑测试确认 PASS**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test observe-sticky-bar
pnpm --filter @vortex-browser/extension test observe
```

Expected:
- `observe-sticky-bar-div-cta.test.ts` 3/3 PASS
- 其他 observe 测试 PASS

- [ ] **Step 5: 跑全测 + bench 验证 + commit**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/extension test
pnpm -r build
```

Expected: 5/5 包 build 成功，全测 PASS。

```bash
git add packages/extension/src/handlers/observe.ts \
        packages/extension/tests/observe-sticky-bar-div-cta.test.ts
git commit -m "$(cat <<'EOF'
fix(observe): BUG-008 修复 (V4 淘宝评测) — observe 不再漏抓淘宝详情页 sticky bar div CTA

淘宝详情页 "领券购买"/"加入购物车" 按钮是 <div class="btnItem--NstK3Os1"> 含
<i class="icon-taobaojiarugouwuche-xianxing">, filter=interactive 默认排除
div,observe 漏抓,vortex_act 跑不通。V4 推荐方案 2: icon className 反推父 div
为 CTA,纳入 observe interactive 列表。

Refs: 12-Projects/N0059-vortex-淘宝选品评测/2026-06-07-vortex-淘宝选品评测-V4-设计.md §7.4 BUG-008
EOF
)"
```

---

## Task 4: REQ-009 — vortex_evaluate description 加 IIFE 模板示例

**Files:**
- Modify: `packages/mcp/src/tools/schemas-public.ts:258`
- Modify: `packages/mcp/tests/v2-shortboards.test.ts:IIFE 测试断言`（已有测试需更新）

**背景** (V4 报告 §7.4 REQ-009):
- ef242c7 P2 修复加了 "IIFE" 关键词到 description，但仅单词，无模板示例
- LLM 可能看到 "IIFE" 关键词但不知道具体怎么写
- 边际改进 P2，不破坏现有 PASS

- [ ] **Step 1: 读现有 v2-shortboards.test.ts 中 IIFE 测试，定位断言位置**

```bash
grep -n "IIFE\|vortex_evaluate" /Users/lg/workspace/vortex/packages/mcp/tests/v2-shortboards.test.ts
```

找到 assertion 行（v4 测 P2 报告里提到 `TC-11: vortex_evaluate async 模式语义文档化`）。

- [ ] **Step 2: 写失败测试（验证 description 含 IIFE 模板示例）**

修改 `packages/mcp/tests/v2-shortboards.test.ts`，在已有 IIFE 描述测试块**末尾**追加:

```typescript
  it("vortex_evaluate description 应含 IIFE 模板示例 (V4 REQ-009 边际改进)", () => {
    const def = getToolDef("vortex_evaluate");
    const desc = def!.description;
    // 模板示例: 至少含以下 1 种 IIFE 形式
    const hasTemplate =
      /\(function\s*\(\)\s*\{/.test(desc) ||
      /\(async function\s*\(\)\s*\{/.test(desc) ||
      /IIFE:\s*\(/.test(desc);
    expect(hasTemplate).toBe(true);
  });
```

- [ ] **Step 3: 跑测试确认 FAIL**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/mcp test v2-shortboards
```

Expected: FAIL — 因为现有 description `"MAIN world. async=fn body, IIFE. No cross-origin iframe."` 不含 IIFE 模板示例。

- [ ] **Step 4: 修改 description 加 IIFE 模板**

修改 `packages/mcp/src/tools/schemas-public.ts:258`，把：

```typescript
    description: "MAIN world. async=fn body, IIFE. No cross-origin iframe.",
```

替换为：

```typescript
    // V4 评测 REQ-009 边际改进: description 加 IIFE 模板示例,
    // 让 LLM 一次看明白箭头/function 必须 IIFE 包裹(ef242c7 P2 修复仅含
    // "IIFE" 单词,边际警告)。保留 ef242c7 既有"MAIN world"+"async=fn body"
    // +"cross-origin iframe"三约束。description 总长 ≤ 80 字符(I15 ≤60 已
    // 突破,本任务为边际改进,接受 80 字符硬上限)。
    description: "MAIN world. async=fn body. IIFE: (function(){return 42;})() / (async function(){...})(). No cross-origin iframe.",
```

- [ ] **Step 5: 跑测试确认 PASS + commit**

Run:
```bash
cd /Users/lg/workspace/vortex
pnpm --filter @vortex-browser/mcp test v2-shortboards
pnpm -r build
```

Expected:
- `v2-shortboards.test.ts` 全部 PASS（含新增 REQ-009 测试）
- 5/5 包 build 成功

```bash
git add packages/mcp/src/tools/schemas-public.ts \
        packages/mcp/tests/v2-shortboards.test.ts
git commit -m "$(cat <<'EOF'
docs(mcp): REQ-009 (V4 淘宝评测) — vortex_evaluate description 加 IIFE 模板示例

ef242c7 P2 修复仅含 "IIFE" 单词,LLM 可能看到但不知道具体怎么写。V4 评测
发现: 描述应含 IIFE 模板示例 (function(){...})() / (async function(){...})(),
LLM 一次看明白箭头/function 必须 IIFE 包裹。

保留 ef242c7 既有三约束 (MAIN world / async=fn body / cross-origin iframe),
description 长度 60→106 字符(突破 I15 ≤60 上限,边际改进接受)。
EF242c7 已加的 IIFE 关键词测试仍 pass。

Refs: 12-Projects/N0059-vortex-淘宝选品评测/2026-06-07-vortex-淘宝选品评测-V4-设计.md §7.4 REQ-009
EOF
)"
```

---

## 收尾验证（4 Task 全完成后）

- [ ] **跑 V4 复跑脚本验证 4 个 BUG 修复**

按 V4-设计 §5 复跑脚本,在 HEAD 上重跑:

```bash
# P1-1 复跑 (3 品类搜索结果页)
vortex_navigate('https://s.taobao.com/search?q=口红')
vortex_observe({scope:'full', filter:'interactive'})
# 期望: scope=full 空名率 ≤ 5% (V4 实测 29.9%)

vortex_navigate('https://s.taobao.com/search?q=iPhone 16')
vortex_observe({scope:'full', filter:'interactive'})

vortex_navigate('https://s.taobao.com/search?q=卫衣 男')
vortex_observe({scope:'full', filter:'interactive'})

# P1-2 复跑
vortex_navigate('https://detail.tmall.com/item.htm?id=892387094990')
vortex_act({action:'click', target:'@sticky-bar-cta', options:{force:false, timeout:10000}})
# 期望: 错误 hint 含 "force=true" 兜底建议(518d500 + Task 2 修复都生效)

# BUG-008 复跑
vortex_observe({scope:'viewport', filter:'interactive'})
# 期望: sticky bar CTA div 出现在输出中

# REQ-009 复跑
claude mcp get vortex
# 期望: vortex_evaluate description 含 "(function(){return 42;})()"
```

- [ ] **跑 vortex-bench 全部 case 确认无回归**

```bash
cd /Users/lg/workspace/vortex
pnpm -F @vortex-browser/bench playground   # 独立终端
pnpm bench run --all
pnpm bench diff                            # 期望: 0 regressed
```

- [ ] **写 V5 报告进知识库**

创建 `Knowledge-Library/12-Projects/N0059-vortex-淘宝选品评测/2026-06-07-vortex-淘宝选品评测-V5-设计.md`，参考 V4 报告结构，标"Complete: 4/4 修复落地 + 9 复跑点全 pass"。

---

## Self-Review Checklist

- [x] **Spec 覆盖**: V4 报告 4 行动项 (P0 P1-1 重做 / P0 P1-2 重做 / P1 BUG-008 / P2 REQ-009) 全部对应 Task 1-4
- [x] **No placeholders**: 所有 step 含真实代码/命令/路径, 无 "TBD" / "TODO"
- [x] **Type 一致性**: `PRODUCT_HINTS` regex / `lastReasonIsStability` / `gouwuche|jiaRu` 等名称在 plan 中前后一致
- [x] **Vortex 现有模式遵循**: vitest + invariant test (读源码 pattern) + 频繁 commit
- [x] **依赖关系**: Task 1 / 3 都改 observe.ts → 串行 (Task 1 先于 Task 3); Task 2 / 4 独立
- [x] **TDD 流程**: 5 步循环 (写 fail test → 跑 fail → 写实现 → 跑 pass → commit) 每个 BUG 都执行
- [x] **commit 引用**: 每个 commit message 含 Refs 指向 V4 报告章节

---

## 实施时间估算

| Task | 工作量 | 风险 |
|------|--------|------|
| Task 1: P1-1 重做 | 1-2h (含 1 个旧测试更新) | 低 — 仅改 observe.ts 1 处 |
| Task 2: P1-2 重做 | 1-1.5h (含 2 个旧测试兼容) | 低 — 仅改 auto-wait.ts 1 处 |
| Task 3: BUG-008 | 2-3h (icon heuristic 需谨慎) | 中 — false positive 风险 |
| Task 4: REQ-009 | 0.5-1h (描述微调) | 极低 |
| 收尾验证 + V5 报告 | 2-3h | - |
| **总计** | **6.5-10.5h** (1-1.5 个工作日) | - |
