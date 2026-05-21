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
 * Source-level contract: covers the 4 mainstream UI library backdrop
 * vocabularies (AngularJS Material, Angular CDK, Bootstrap, Ant Design).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "src", "page-side", "actionability.ts"),
  "utf8",
);

describe("actionability backdrop carve-out (@since 0.8.2 BUG 9)", () => {
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

  it("walks parentElement chain to find an overlay container", () => {
    // The carve-out logic must climb ancestry; without that climb,
    // targets that aren't direct children of the overlay (e.g. an
    // md-option inside md-select-menu > md-content) would still fail.
    expect(SRC).toMatch(/cur\.parentElement/);
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
    // The ancestry walk must be gated behind `if (isBackdrop)`.
    // Without the gate, every false-positive OBSCURED case would pass.
    const block = SRC.match(/const isBackdrop[\s\S]*?if\s*\(\s*isBackdrop\s*\)/);
    expect(block).not.toBeNull();
  });

  it("still returns blocker description when not a backdrop case", () => {
    // The original failure path must remain intact.
    expect(SRC).toMatch(/return\s*\{\s*ok:\s*false,\s*blocker:\s*desc\s*\}/);
  });
});
