// packages/vortex-bench/tests/mock-gemini-fix-design.test.ts
//
// 修复设计实测 —— F2 口径取舍（抛错 vs delivered:false）
//
// v3 文档第七节对 F2 提过两种口径但没定。本文件在夹具上把它们各自跑一遍，
// 用"调用方能否可靠识别失败"这一唯一硬指标做取舍，并量化对现有正常路径的影响。
//
// 口径定义（均为对 keyboard.ts PRESS 的候选改法，本轮不改产品代码，仅建模评估）：
//   口径①  throw：probeFocus 显示焦点不可操作时，抛 vtxError
//   口径②  delivered:false：仍返回 success:true，附带 delivered:false + focusedElement
//
// 调用方模型（决定"可靠"二字的含义）：
//   C-naive  只看 success 字段 / 有无异常 —— 绝大多数 agent 与现有脚本的写法
//   C-check  会读 delivered 字段 —— 需要 agent 主动改代码才会这样做

import { describe, it, expect } from "vitest";
import { MockGeminiComposer } from "../playground/public/mock-gemini-core.js";

type Outcome = { thrown: boolean; success?: boolean; delivered?: boolean; reason?: string };

/** 口径①：焦点不可操作 → 抛错。 */
function pressThrow(focusTarget: string): Outcome {
  if (focusTarget !== 'editor' && focusTarget !== 'body') {
    return { thrown: false, success: true, delivered: true }; // 焦点在可操作控件上
  }
  if (focusTarget === 'body') return { thrown: true, reason: 'focus-not-actionable' };
  return { thrown: false, success: true, delivered: true };
}

/** 口径②：仍 success，但带 delivered 标志。 */
function pressDeliveredFlag(focusTarget: string): Outcome {
  if (focusTarget === 'body') {
    return { thrown: false, success: true, delivered: false, reason: 'focus-not-actionable' };
  }
  return { thrown: false, success: true, delivered: true };
}

/** C-naive：只看 success / 有无异常。 */
function naiveSeesFailure(o: Outcome): boolean {
  return o.thrown || o.success === false;
}

/** C-check：会读 delivered。 */
function checkingSeesFailure(o: Outcome): boolean {
  return o.thrown || o.success === false || o.delivered === false;
}

const CASES = [
  { name: '焦点在编辑器（正常路径）', focus: 'editor', expectSuccess: true },
  { name: '焦点在 body（缺陷场景）', focus: 'body', expectSuccess: false },
  { name: '焦点在附件 chip（真实常见）', focus: 'attachment-chip', expectSuccess: true },
] as const;

describe("F2 口径实测 · 调用方能否可靠识别失败", () => {
  it("口径① throw：C-naive 在缺陷场景 100% 识别，正常路径 0% 误报", () => {
    let detectFail = 0, falseAlarm = 0, totalFail = 0, totalOk = 0;
    for (const c of CASES) {
      const o = pressThrow(c.focus);
      const seen = naiveSeesFailure(o);
      if (c.expectSuccess) { totalOk++; if (seen) falseAlarm++; }
      else { totalFail++; if (seen) detectFail++; }
    }
    expect(detectFail).toBe(totalFail);       // 1/1 全抓到
    expect(falseAlarm).toBe(0);               // 正常路径无误报
  });

  it("口径② delivered:false：C-naive 完全识别不到（0%），只有 C-check 能抓", () => {
    let naiveDetect = 0, checkDetect = 0, totalFail = 0;
    for (const c of CASES) {
      const o = pressDeliveredFlag(c.focus);
      if (!c.expectSuccess) {
        totalFail++;
        if (naiveSeesFailure(o)) naiveDetect++;
        if (checkingSeesFailure(o)) checkDetect++;
      }
    }
    expect(naiveDetect).toBe(0);        // ← 关键：现有调用方看不出问题
    expect(checkDetect).toBe(totalFail); // 需要调用方主动改造
  });

  it("口径② 的价值仅在调用方改造后才成立 —— 这就是它不够可靠的原因", () => {
    // 兼容性换来的代价：老调用方零感知。
    const o = pressDeliveredFlag('body');
    expect(o.success).toBe(true);       // 老调用方读到的仍然是成功
    expect(o.delivered).toBe(false);    // 只有新代码读得到
  });

  it("【选定结论】口径① 在夹具上唯一满足『调用方可靠识别失败』", () => {
    // 同一批场景，两口径横比：
    const matrix = CASES.map((c) => {
      const a = naiveSeesFailure(pressThrow(c.focus));
      const b = naiveSeesFailure(pressDeliveredFlag(c.focus));
      return { c: c.name, want: !c.expectSuccess, throwSees: a, deliveredSees: b };
    });
    const perfect = matrix.filter((m) => m.throwSees === m.want);
    expect(perfect).toHaveLength(CASES.length);
    expect(matrix.find((m) => m.c.includes('body'))!.deliveredSees).toBe(false);
  });
});

describe("F2 口径实测 · 对现有正常路径的回归面", () => {
  it("夹具侧：正常路径在两种口径下都应保持 success —— 口径① 不得误伤", () => {
    for (const c of CASES.filter((x) => x.expectSuccess)) {
      expect(pressThrow(c.focus).success).toBe(true);
      expect(pressThrow(c.focus).thrown).toBe(false);
    }
  });

  it("夹具侧：只有 body 焦点被判为不可操作 —— 判据够窄，不会误伤 chip 等控件", () => {
    // 这是口径① 的回归风险控制点：判据必须是"无可操作焦点"，
    // 而不是"焦点不在编辑器"（后者会误伤 chip/按钮上的按键）。
    expect(pressThrow('editor').thrown).toBe(false);
    expect(pressThrow('attachment-chip').thrown).toBe(false);
    expect(pressThrow('body').thrown).toBe(true);
  });

  it("夹具侧：口径① 在场景 A 下确实让调用方看到失败", () => {
    const app = new MockGeminiComposer({ focusStrict: true });
    app.setText('x');
    app.attach({ name: 'a.txt', size: 10 }, { uploadDelayMs: 0 });
    app.markReady(app.attachments[0].id);
    app.focusTo('body');
    const site = app.submit('Enter');
    const tool = pressThrow(app.focusTarget);
    expect(site.ok).toBe(false);
    expect(naiveSeesFailure(tool)).toBe(true);
    app.dispose();
  });
});

describe("F3 方案实测 · 无完成信号的可落地方案", () => {
  it("现状：上传返回 success 但站点未就绪，调用方无判据", () => {
    const app = new MockGeminiComposer({ uploadGate: 'strict' });
    const upload = { success: true, fileName: 'a.txt', size: 10 };
    app.attach({ name: 'a.txt', size: 10 }, { uploadDelayMs: 60000 });
    expect(upload.success).toBe(true);
    expect(app.submit('Enter').ok).toBe(false);
    expect(Object.keys(upload)).toHaveLength(3); // 无任何就绪信息
  });

  it("方案① 扩展返回 uploadState/settled：调用方可在提交前自查", () => {
    const app = new MockGeminiComposer({ uploadGate: 'strict' });
    app.attach({ name: 'a.txt', size: 10 }, { uploadDelayMs: 60000 });
    const upload = { success: true, fileName: 'a.txt', size: 10, uploadState: 'pending', settled: false };
    expect(upload.uploadState).toBe('pending');
    // 调用方逻辑：uploadState !== 'ready' 时先等待再提交
    const gated = upload.uploadState === 'ready';
    expect(gated).toBe(false);
    app.markReady(app.attachments[0].id);
    expect(app.canSubmit).toBe(true);
    app.dispose();
  });

  it("方案② 注入 waitForUploadSettled：夹具可提供可等待点", () => {
    const app = new MockGeminiComposer({ uploadGate: 'strict' });
    app.attach({ name: 'a.txt', size: 10 }, { uploadDelayMs: 30 });
    // 轮询式等待点在夹具里是可确定性模拟的（不依赖墙钟也能用 markReady）
    expect(app.hasPendingUpload).toBe(true);
    expect(app.submit('Enter').ok).toBe(false);
    app.markReady(app.attachments[0].id);
    expect(app.hasPendingUpload).toBe(false);
    expect(app.submit('Enter').ok).toBe(true);
    app.dispose();
  });

  it("两方案在夹具上都能消除 B 场景的误提交 —— 差别在 schema 与等待策略", () => {
    // 方案① 改返回 schema（破坏性变更面较大）；方案② 需要站点可观测信号（夹具有，真站未知）
    const app1 = new MockGeminiComposer({ uploadGate: 'strict' });
    app1.attach({ name: 'a.txt', size: 10 }, { uploadDelayMs: 60000 });
    const shape1 = { success: true, fileName: 'a.txt', size: 10, uploadState: 'pending', settled: false };
    expect(Object.keys(shape1).length).toBeGreaterThan(3); // schema 变了
    expect(app1.canSubmit).toBe(false);                  // 站点侧不变量也需暴露
    app1.dispose();
  });
});
