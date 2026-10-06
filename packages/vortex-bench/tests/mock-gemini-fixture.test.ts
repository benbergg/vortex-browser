// packages/vortex-bench/tests/mock-gemini-fixture.test.ts
//
// 夹具自检（fixture self-test）—— 回答"夹具自身如何被验证是有效的"。
//
// 风险：夹具自己有 bug 却证明不了任何事。本文件专门防这个。
// 做法不是测业务，而是证明状态机**同时具备**"能提交"与"会忽略"两种能力，
// 且两者可由开关切换。若夹具是只能复现缺陷的单向陷阱（只会 IGNORED），
// 本文件必红——因为它要求健康配置下必须能提交成功。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MockGeminiComposer, DEFAULT_CONFIG } from "../playground/public/mock-gemini-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, "..", "playground", "public", "mock-gemini-composer.html");
const corePath = join(here, "..", "playground", "public", "mock-gemini-core.js");
const pageHtml = readFileSync(pagePath, "utf8");
const coreSource = readFileSync(corePath, "utf8");

describe("夹具自检 · 状态机双向能力", () => {
  it("健康配置下必须能提交成功 —— 否则夹具是只会失败的陷阱", () => {
    const app = new MockGeminiComposer({ focusStrict: false, uploadGate: "tolerant" });
    app.setText("hello");
    const r = app.submit("Enter");
    expect(r.ok).toBe(true);
    expect(app.transcript).toHaveLength(1);
    expect(app.editorText).toBe("");
  });

  it("focusStrict 打开且焦点被移出时必须被忽略 —— 证明该开关真的起作用", () => {
    const app = new MockGeminiComposer({ focusStrict: true });
    app.setText("hello").focusTo("body");
    const r = app.submit("Enter");
    expect(r.ok).toBe(false);
    // R2 核销：body 与 control 是**两回事**，reason 必须能区分
    expect(r.reason).toBe("no-actionable-focus-target");
    // 用户签名 F4：无新消息 + 内容留存
    expect(app.transcript).toHaveLength(0);
    expect(app.editorText).toBe("hello");
  });

  it("焦点在按钮/控件（control）时站点同样忽略，但 reason 与 body 不同", () => {
    // 对应历史 E2E 的真实状态：focusedElement 是 button，不是 body
    const app = new MockGeminiComposer({ focusStrict: true });
    app.setText("hi").focusTo("control");
    const r = app.submit("Enter");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("focus-not-on-editor"); // 与 body 的 reason 区分开
  });

  it("同一实例上关掉 focusStrict 立刻恢复成功 —— 证明是可开关而非写死", () => {
    const app = new MockGeminiComposer({ focusStrict: true });
    app.setText("hi").focusTo("body");
    expect(app.submit("Enter").ok).toBe(false);
    app.config.focusStrict = false;
    expect(app.submit("Enter").ok).toBe(true);
  });

  it("点「发送」按钮不受焦点约束 —— 与 Enter 路径可区分", () => {
    const app = new MockGeminiComposer({ focusStrict: true });
    app.setText("hi").focusTo("body");
    expect(app.submit("Enter").ok).toBe(false);
    expect(app.submit("send-button").ok).toBe(true);
  });

  it("uploadGate=strict 时未就绪附件被忽略，tolerant 时照发 —— 证明 F3 开关有效", () => {
    const strict = new MockGeminiComposer({ uploadGate: "strict" });
    strict.attach({ name: "a.txt", size: 10 }, { uploadDelayMs: 10000 });
    expect(strict.submit("Enter")).toEqual({ ok: false, reason: "upload-in-progress" });

    const tolerant = new MockGeminiComposer({ uploadGate: "tolerant" });
    tolerant.attach({ name: "a.txt", size: 10 }, { uploadDelayMs: 10000 });
    expect(tolerant.submit("Enter").ok).toBe(true);
  });

  it("空提交（无文字无附件）被拒", () => {
    const app = new MockGeminiComposer();
    expect(app.submit("Enter")).toEqual({ ok: false, reason: "nothing-to-send" });
  });

  it("markReady 可跳过真实计时器，让竞态测试不依赖墙钟", () => {
    const app = new MockGeminiComposer({ uploadGate: "strict" });
    const id = app.attach({ name: "a.txt", size: 10 }, { uploadDelayMs: 60000 });
    expect(app.submit("Enter").ok).toBe(false);
    app.markReady(id);
    expect(app.submit("Enter").ok).toBe(true);
    app.dispose();
  });

  it("菜单项确实延迟插入，且可配置为 0", async () => {
    const slow = new MockGeminiComposer({ menuItemDelayMs: 60 });
    const p = slow.openMenu();
    expect(slow.menuItemsInserted).toBe(false); // 立刻检查：还没插入
    await p;
    expect(slow.menuItemsInserted).toBe(true);

    const fast = new MockGeminiComposer({ menuItemDelayMs: 0 });
    await fast.openMenu();
    expect(fast.menuItemsInserted).toBe(true);
  });

  it("默认配置暴露菜单延迟开关，D1b 实测值 5100 可被复现", () => {
    expect(DEFAULT_CONFIG).toHaveProperty("menuItemDelayMs");
    const app = new MockGeminiComposer({ menuItemDelayMs: 5100 });
    expect(app.config.menuItemDelayMs).toBe(5100);
  });
});

describe("夹具自检 · 页面与核心的一致性（静态契约）", () => {
  // 页面不在单测里跑（bench 无 jsdom 依赖），故用静态契约锁住"页面确实在用这份核心、
  // 且含实测要求的关键结构"。这些断言对应 v3 文档 4.2 节列出的实测结构。
  it("页面 import 的是同一份核心模块", () => {
    expect(pageHtml).toContain("from './mock-gemini-core.js'");
    expect(pageHtml).toContain("new MockGeminiComposer(");
  });

  it("含实测结构：contenteditable + role=textbox + 真实可访问名", () => {
    expect(pageHtml).toMatch(/contenteditable="true"/);
    expect(pageHtml).toContain('role="textbox"');
    expect(pageHtml).toContain('aria-label="为 Gemini 输入提示"');
  });

  it("含实测结构：上传按钮 haspopup=menu 且 aria-expanded 有 false→true 翻转", () => {
    expect(pageHtml).toContain('aria-haspopup="menu"');
    expect(pageHtml).toContain('aria-expanded="false"');
    expect(pageHtml).toMatch(/setAttribute\('aria-expanded',\s*'true'\)/);
  });

  it("含实测结构：菜单项延迟后才创建隐藏 input[type=file]", () => {
    expect(pageHtml).toMatch(/await app\.openMenu\(\);[\s\S]{0,120}ensureFileInput\(\)/);
    expect(pageHtml).toMatch(/<input type="file"[^>]*style="width:0;height:0/);
  });

  it("含实测结构：附件 chip + 发送按钮 disabled 随状态切换", () => {
    expect(pageHtml).toContain('class="chip"');
    expect(pageHtml).toMatch(/sendBtn\.disabled = !app\.canSubmit/);
  });

  it("含实测结构：提交成功后对话区追加消息并消费 chip", () => {
    // 追加/消费发生在核心 submit() 内（core 源码），页面只负责调用并在成功时清空编辑器。
    expect(coreSource).toMatch(/this\.transcript\.push\(entry\)[\s\S]{0,200}this\.attachments = \[\]/);
    expect(pageHtml).toMatch(/app\.submit\('Enter'\)/);
    expect(pageHtml).toMatch(/if \(r\.ok\) \{ editor\.innerText = ''; render\(\); \}/);
  });

  it("场景 A 两个触发点都在页面上，且分别产出 button 焦点与 body 焦点", () => {
    // R2 核销：不得再把 button 当 body。页面必须提供**两个**不同触发点，
    // 并且模型分类由真实 document.activeElement 反推（syncFocusFrom），不得直接赋值。
    expect(pageHtml).toContain("btnStealFocus");   // → 按钮焦点
    expect(pageHtml).toContain("btnDropFocus");    // → body 焦点
    expect(pageHtml).toMatch(/e\.currentTarget\.focus\(\)/);
    expect(pageHtml).toMatch(/document\.activeElement\.blur\(\)/);
    expect(pageHtml).toContain("app.syncFocusFrom(document.activeElement)");
    // 旧写法（把模型直接设成 body + body.focus()）必须已消失
    expect(pageHtml).not.toMatch(/app\.focusTo\('body'\)/);
    expect(pageHtml).not.toMatch(/document\.body\.focus\(\)/);
  });
});
