import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock for the backdrop OBSCURED carve-out introduced in
 * v0.8.2 (BUG 9, 2026-05-21 RocketMQ-Dashboard dogfood).
 *
 * Before this fix, receivesEvents() in actionability.ts used a strict
 * elementFromPoint identity check: any element returned that wasn't the
 * target or one of its ancestors/descendants → OBSCURED. This caught a
 * common false positive: when a modal / dropdown is open, its expected
 * backdrop visually covers the page but is stacked _below_ the overlay
 * pane. elementFromPoint correctly returns the backdrop at the page
 * center, but the user-actioned target is in the higher-z overlay and
 * fully clickable. The strict check wrongly reported OBSCURED, blocking
 * fill / click on md-select search input, md-option, ant-modal content,
 * etc.
 *
 * The fix adds a carve-out: when hit is a backdrop AND target lives in
 * a known overlay container ancestry, treat as not-obscured.
 *
 * @since task-2-ancestor-hit-gate: 判据收敛到 hit-ownership.ts 单一真源，
 * receivesEvents() 只负责调用 classifyHit。锁点相应迁到 hit-ownership.ts，
 * 并加一条委托断言防止 actionability.ts 再长出第二份拷贝。
 *
 * Source-level contract: covers the 4 mainstream UI library backdrop
 * vocabularies (AngularJS Material, Angular CDK, Bootstrap, Ant Design).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const ACTIONABILITY_SRC = readFileSync(
  join(__dirname, "..", "src", "page-side", "actionability.ts"),
  "utf8",
);
const SRC = readFileSync(
  join(__dirname, "..", "src", "page-side", "hit-ownership.ts"),
  "utf8",
);

describe("actionability backdrop carve-out (@since 0.8.2 BUG 9)", () => {
  it("receivesEvents 委托给 hit-ownership.classifyHit（单一真源，不再自带判据拷贝）", () => {
    expect(ACTIONABILITY_SRC).toMatch(/classifyHit\(el,\s*deepElementFromPoint\(cx,\s*cy\)\)/);
  });

  // 只查"委托调用还在"防不住"旁边又贴回一份判据"——那条正向断言哪怕本地重新长出
  // 完整 carve-out 逻辑依然会绿。补负向断言锁死 actionability.ts 不得再出现这些
  // backdrop carve-out 的特征字面量,这批词在 hit-ownership.ts 之外没有正当出现理由。
  it("actionability.ts 不得再出现 backdrop carve-out 判据字面量（防第二份拷贝复活）", () => {
    // 字符串字面量中的 backdrop 相关类名（cdk-overlay-backdrop, modal-backdrop, 等）
    // 正则 ["'][\w-]*backdrop 匹配引号包围的字符串中的 backdrop，但不会匹配注释中的 ::backdrop
    expect(ACTIONABILITY_SRC).not.toMatch(/["'][\w-]*backdrop/i);
    // Bootstrap 特定类名（不含 backdrop 词根）
    expect(ACTIONABILITY_SRC).not.toMatch(/ant-modal-mask/);
    // 判据变量名与 overlay 容器词汇表
    expect(ACTIONABILITY_SRC).not.toMatch(/isBackdrop/);
    expect(ACTIONABILITY_SRC).not.toMatch(/md-select-menu/);
    expect(ACTIONABILITY_SRC).not.toMatch(/el-select-dropdown/);
  });

  it("detects AngularJS Material backdrop (md-backdrop tag)", () => {
    expect(SRC).toMatch(/hitTag\s*===\s*"md-backdrop"/);
  });

  it("detects Angular CDK overlay backdrop (.cdk-overlay-backdrop)", () => {
    expect(SRC).toMatch(/cdk-overlay-backdrop/);
  });

  it("detects Bootstrap modal backdrop (.modal-backdrop)", () => {
    expect(SRC).toMatch(/modal-backdrop/);
  });

  it("detects Ant Design modal mask (.ant-modal-mask)", () => {
    expect(SRC).toMatch(/ant-modal-mask/);
  });

  it("walks composed ancestry (穿 shadow) to find an overlay container", () => {
    // 判据改走 composedParent 上溯（穿 shadow），取代此前的 cur.parentElement。
    // 不这样爬，非直接子节点（如 md-select-menu > md-content > md-option）会漏判。
    expect(SRC).toMatch(/composedParent\(cur\)/);
  });

  it("recognises AngularJS Material overlay containers", () => {
    expect(SRC).toMatch(/md-select-menu/);
    expect(SRC).toMatch(/md-dialog/);
    expect(SRC).toMatch(/md-menu-content/);
    expect(SRC).toMatch(/md-open-menu-container/);
  });

  it("recognises Angular CDK overlay pane", () => {
    expect(SRC).toMatch(/cdk-overlay-pane/);
  });

  it("recognises ngDialog / Bootstrap modal / Ant / Element overlay containers", () => {
    expect(SRC).toMatch(/ngdialog-content/);
    expect(SRC).toMatch(/modal-content/);
    expect(SRC).toMatch(/ant-modal-content/);
    expect(SRC).toMatch(/el-dialog/);
    expect(SRC).toMatch(/el-select-dropdown/);
  });

  it("only fires the carve-out when hit was identified as a backdrop", () => {
    // 早退写法变了（!isBackdrop 则 return false），门控意图不变：非 backdrop 时不进入爬祖先分支。
    const block = SRC.match(/const isBackdrop[\s\S]*?if\s*\(\s*!isBackdrop\s*\)\s*return\s*false/);
    expect(block).not.toBeNull();
  });

  it("still returns blocker description when not a backdrop case", () => {
    // 原始失败路径的等价物：classifyHit 兜底分支，附 kind:"overlay"。
    expect(SRC).toMatch(/return\s*\{\s*ok:\s*false,\s*blocker:\s*describeElement\(hit\),\s*kind:\s*"overlay"\s*\}/);
  });
});
