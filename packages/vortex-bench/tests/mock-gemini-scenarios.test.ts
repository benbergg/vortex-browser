// packages/vortex-bench/tests/mock-gemini-scenarios.test.ts
//
// N023 · 场景 A / B 回归（辅助说明，**不是产品验收门禁**）
//
// ── R1 核销后的定位变更 ──────────────────────────────────────────
// P3 审核判 R1：本文件原先用「复制模型」构造返回值并承担产品转绿门禁，
// 但产品代码怎么改它都不变。现已把**产品验收门禁移到**
//   packages/extension/tests/n023-press-body-focus-subdefect.test.ts
// 该文件注册**真实** handler、真跑 probeFocus 注入函数，已在冻结代码 4259bae 上取得真实 RED。
//
// 本文件保留的价值：
//   1. 说明"站点无反应 + chip 留存 + 无新消息"这一用户签名 F4 长什么样；
//   2. 证明夹具不是单向陷阱；
//   3. 记录 body 与 control 两种焦点的**区别**（R2 核销点）。
// 明确声明：**本文件的断言不随产品修复而变化，不得用作转绿依据。**
//
// ── 范围（R2 核销 · 主控裁决 2）──────────────────────────────────
// 已实证的子缺陷 = 焦点为 body/documentElement（无可操作焦点目标）。
// 焦点在按钮/控件（control）时站点同样忽略，但**不在本批次修复范围**——
// 历史 E2E 的 focusedElement 正是 button，那条路径修复后仍会静默成功。

import { describe, it, expect } from "vitest";
import { MockGeminiComposer } from "../playground/public/mock-gemini-core.js";

// ─────────────────────────────────────────────────────────────
// 当前产品行为转写（依据见注释行号，基线 HEAD cf2273b）
// ─────────────────────────────────────────────────────────────

/**
 * keyboard.ts PRESS handler 的当前行为（L245-260）：
 *   1. parseKeyExpression
 *   2. debuggerMgr.attach
 *   3. focusedElement = await probeFocus(tid)        ← 读了焦点
 *   4. dispatchKey(debuggerMgr, tid, key, 0)        ← 投给 document.activeElement
 *   5. return { success: true, key: expr, focusedElement }   ← 无条件 success
 * 注释 L121-126 自述："焦点不在预期元素时…按键落空但 handler 仍返回 success，
 * 是 silent false-success"。
 * @param {{focusTarget:string, submitResult:{ok:boolean}}} fixture
 */
function currentPressContract(fixture: { focusTarget: string; submitResult: { ok: boolean } }) {
  const focusedElement = fixture.focusTarget === "editor"
    ? 'div[role=textbox] "为 Gemini 输入提示"'
    : "body (no element focused — key may have no effect)";
  // L259: return { success: true, key: expr, focusedElement }; —— 无条件
  return { success: true, key: "Enter", focusedElement };
}

/**
 * file.ts UPLOAD handler 的当前行为（L53-83 + L92）：
 *   同步注入 → input.files 赋值 → dispatchEvent(change) → dispatchEvent(input)
 *   → 立即 return { success: true, fileName, size: bytes.length }
 *   size 是注入字节数；不等待站点、不轮询、不 emit 任何事件。
 * @param {{name:string,size:number}} file
 */
function currentUploadContract(file: { name: string; size: number }) {
  return { success: true, fileName: file.name, size: file.size };
}

// ─────────────────────────────────────────────────────────────
// 场景 A —— 复现 F2 / F4（silent false-success）
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 缺陷指纹：始终为绿的普通用例。it.fails 通过只说明内部断言抛错；
// 审阅者跑一次 vitest 只看到全绿，容易误以为"没复现"。这里把指纹直接断言出来。
// ─────────────────────────────────────────────────────────────
describe("缺陷指纹（普通用例，证明缺陷确实存在而非 it.fails 空转）", () => {
  it("F2 指纹：工具报成功 + 站点无动作 + chip 留存 + 无新消息", () => {
    const app = new MockGeminiComposer({ focusStrict: true });
    app.setText("请看一下这个附件里的内容");
    app.attach({ name: "n023-probe.txt", size: 269 }, { uploadDelayMs: 0 });
    app.markReady(app.attachments[0].id);
    app.focusTo("body");

    const site = app.submit("Enter");
    const tool = currentPressContract({ focusTarget: app.focusTarget, submitResult: site });

    expect(site.ok).toBe(false);                 // 站点什么都没发生
    expect(app.transcript).toHaveLength(0);      // 无新消息
    expect(app.attachments).toHaveLength(1);     // chip 留存
    expect(tool.success).toBe(true);             // 工具却报成功 = silent false-success
    expect(tool.focusedElement).toContain("no element focused"); // 唯一线索，老调用方不会看
  });

  it("F3 指纹：上传工具报成功 + 站点忽略提交 + chip 留存", () => {
    const app = new MockGeminiComposer({ uploadGate: "strict" });
    app.attach({ name: "n023-probe.txt", size: 269 }, { uploadDelayMs: 60000 });
    const upload = currentUploadContract({ name: "n023-probe.txt", size: 269 });
    const site = app.submit("Enter");
    expect(upload.success).toBe(true);
    expect(Object.keys(upload)).toEqual(["success", "fileName", "size"]); // 无任何就绪信息
    expect(site.ok).toBe(false);
    expect(app.transcript).toHaveLength(0);
    expect(app.attachments).toHaveLength(1);
    app.dispose();
  });
});

// ─────────────────────────────────────────────────────────────
// 场景 A —— 复现 F2 / F4（silent false-success）
// ─────────────────────────────────────────────────────────────
describe("场景 A · 焦点不在编辑器时按 Enter（复现 F2/F4）", () => {
  /** 构造确定性触发态：附件在、焦点已被移出编辑器。 */
  function scenarioA() {
    const app = new MockGeminiComposer({ focusStrict: true });
    app.setText("请看一下这个附件里的内容");
    app.attach({ name: "n023-probe.txt", size: 269 }, { uploadDelayMs: 0 });
    app.markReady(app.attachments[0].id);
    app.focusTo("body"); // 确定性触发点
    return app;
  }

  it("夹具侧：站点确实无反应、无新消息、chip 留存（= 用户签名 F4）", () => {
    const app = scenarioA();
    const before = { chips: app.attachments.length, turns: app.transcript.length };
    const r = app.submit("Enter");
    // 页面侧确定发生的事
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-actionable-focus-target");
    expect(app.transcript.length).toBe(before.turns); // 无新消息
    expect(app.attachments.length).toBe(before.chips); // chip 留存
    expect(app.editorText).toBe("请看一下这个附件里的内容");
  });

  it.fails("【修前失败】PRESS 仍返回 success:true —— 修后应能可靠识别未投递", () => {
    const app = scenarioA();
    const siteResult = app.submit("Enter"); // 站点没反应
    const toolResult = currentPressContract({
      focusTarget: app.focusTarget,
      submitResult: siteResult,
    });
    // 修前：工具报成功，站点没动 → 调用方无从判断 → silent false-success
    // 修后判据：站点未受理时，工具必须以某种可机读方式暴露"未投递"
    expect(siteResult.ok).toBe(false);
    expect(toolResult.success).toBe(false); // ← 当前为 true，此断言失败 = 复现缺陷
  });

  it("【夹具侧修后判据】把焦点放回编辑器后，同一操作即成功 —— 证明失败可归因于焦点", () => {
    const app = scenarioA();
    expect(app.submit("Enter").ok).toBe(false);
    app.focusTo("editor");
    const r = app.submit("Enter");
    expect(r.ok).toBe(true);
    expect(app.transcript).toHaveLength(1);
    expect(app.attachments).toHaveLength(0);
  });

  /**
   * R2 核心：历史 E2E 里 focusedElement 是 **button**，不是 body。
   * 本批次修复范围只覆盖 body，因此**这条路径修复后仍会静默成功**。
   * 本用例把这一残留缺口显式钉住，防止后续误以为"场景 A 已全覆盖"。
   */
  it("【残留缺口】焦点在按钮(control)时站点同样忽略，且不在本批次修复范围", () => {
    const app = new MockGeminiComposer({ focusStrict: true });
    app.setText("请看一下这个附件里的内容");
    app.attach({ name: "n023-probe.txt", size: 269 }, { uploadDelayMs: 0 });
    app.markReady(app.attachments[0].id);
    app.focusTo("control"); // 按钮/其他控件焦点
    const r = app.submit("Enter");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("focus-not-on-editor");
    // P4 只修 body；control 路径修复后依然如此 —— 这是已知残留，不是本轮回归
    expect(app.transcript).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 场景 B —— 复现 F3（上传竞态：预���出现 ≠ 上传完成）
// ─────────────────────────────────────────────────────────────

describe("场景 B · 上传未完成就提交（复现 F3）", () => {
  function scenarioB() {
    const app = new MockGeminiComposer({ uploadGate: "strict" });
    app.setText("请看一下这个附件里的内容");
    app.attach({ name: "n023-probe.txt", size: 269 }, { uploadDelayMs: 60000 }); // 仍在 uploading
    return app;
  }

  it("夹具侧：延迟窗口内提交被站点忽略（无新消息、chip 留存）", () => {
    const app = scenarioB();
    expect(app.hasPendingUpload).toBe(true);
    const r = app.submit("Enter");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("upload-in-progress");
    expect(app.transcript).toHaveLength(0);
    expect(app.attachments).toHaveLength(1);
    expect(app.canSubmit).toBe(false);
  });

  it("夹具侧：延迟窗口结束后同一提交即成功 —— 证明失败归因于上传未完成", () => {
    const app = scenarioB();
    expect(app.submit("Enter").ok).toBe(false);
    app.markReady(app.attachments[0].id);
    expect(app.hasPendingUpload).toBe(false);
    expect(app.canSubmit).toBe(true);
    expect(app.submit("Enter").ok).toBe(true);
    expect(app.transcript).toHaveLength(1);
  });

  it.fails("【修前失败】上传工具与提交工具都报 success，调用方无从得知未就绪", () => {
    const app = scenarioB();
    const uploadResult = currentUploadContract({ name: "n023-probe.txt", size: 269 });
    const siteResult = app.submit("Enter");

    expect(uploadResult.success).toBe(true);   // 修前恒为 true
    expect(siteResult.ok).toBe(false);         // 但站点实际忽略了

    // 修后判据：上传返回必须携带"就绪状态/可等待点"，
    // 使调用方能在提交前确认（或等待）上传完成。
    // 期望形状示例（具体 schema 由 P4 + P3 定）：
    //   uploadResult = { success:true, fileName, size, uploadState:'pending'|'ready', settled:false }
    expect((uploadResult as Record<string, unknown>).uploadState).toBeDefined();
  });

  it("【夹具侧修后判据】仅当全部附件 ready 才允许提交（tolerant 模式除外）", () => {
    const app = new MockGeminiComposer({ uploadGate: "strict" });
    app.setText("x");
    app.attach({ name: "a.txt", size: 10 }, { uploadDelayMs: 60000 });
    app.attach({ name: "b.txt", size: 10 }, { uploadDelayMs: 60000 });
    expect(app.canSubmit).toBe(false);
    app.markReady(app.attachments[0].id);
    expect(app.canSubmit).toBe(false); // 只就绪一半仍不可提交
    app.markReady(app.attachments[1].id);
    expect(app.canSubmit).toBe(true);
    app.dispose();
  });
});
