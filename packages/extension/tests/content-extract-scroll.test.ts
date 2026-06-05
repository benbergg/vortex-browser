import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerContentHandlers } from "../src/handlers/content.js";
import { _resetPageSideLoader } from "../src/adapter/page-side-loader.js";

/**
 * P1: vortex_extract `scroll: boolean` —— 提取前分步滚动触发懒加载。
 * 确诊见 0023 设计文档:懒加载内容不滚动不进 DOM,裸 extract 整页返回内容
 * 但缺目标数据(正确性失败)。scroll-until-settled:滚到 scrollHeight 稳定
 * (连续 2 次不增)或触 15 步 / 10s 上限(防无限滚动),提取后恢复 scrollY。
 *
 * 注入 func 的页内行为(滚动循环)由 live 验证(同 dom.waitSettled 模式);
 * 此处测 ① scroll 标志透传进 func args ② 源码契约 ③ 向后兼容。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "src", "handlers", "content.ts"), "utf8");

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "content.getText", args, requestId: "r-1", tabId: 42 };
}

describe("content.getText scroll (P1) — 源码契约", () => {
  it("注入 func 为 async(支持 await 滚动延时)", () => {
    expect(SRC).toMatch(/func:\s*async\s*\(/);
  });

  it("scroll 经 opts 传入页内,且按 opts.scroll 守卫", () => {
    expect(SRC).toMatch(/scroll/);
    expect(SRC).toMatch(/opts\.scroll/);
  });

  it("grow-or-stop:每步等 scrollHeight 增长(> __before),增长则继续", () => {
    expect(SRC).toMatch(/scrollHeight/);
    // 锁定 grow-or-stop 语义:轮询比较 scrollHeight > 起始值,而非"短期不变即停"
    // (后者会把 AJAX 在途误判为 settle 提前终止 —— live 验证 quotes.toscrape 实证)
    expect(SRC).toMatch(/scrollHeight\s*>\s*__before/);
    expect(SRC).toMatch(/__grew/);
    expect(SRC).toMatch(/if\s*\(!__grew\)\s*break/);
  });

  it("grace 窗口容忍 AJAX 延迟(1500ms)", () => {
    expect(SRC).toMatch(/__graceEnd/);
    expect(SRC).toMatch(/1500/);
  });

  it("硬上限防无限滚动(15 步)", () => {
    expect(SRC).toMatch(/MAX_SCROLL_STEPS\s*=\s*15/);
  });

  it("整体时间预算兜底(15s deadline)", () => {
    expect(SRC).toMatch(/Date\.now\(\)/);
    expect(SRC).toMatch(/15000|15_000/);
  });

  it("提取后恢复原 scrollY(不扰用户视图)", () => {
    expect(SRC).toMatch(/scrollY/);
    expect(SRC).toMatch(/scrollTo\(0,\s*__?orig/);
  });
});

describe("content.getText scroll (P1) — 透传与兼容", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetPageSideLoader();
    vi.unstubAllGlobals();
    executeScript = vi.fn((arg: any) => {
      // loadPageSideModule 走 files 分支;主提取走 func 分支
      if (arg && arg.files) return Promise.resolve([]);
      return Promise.resolve([{ result: { result: "TEXT" } }]);
    });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      scripting: { executeScript },
    });
    router = new ActionRouter();
    registerContentHandlers(router);
  });

  function funcCallOpts() {
    const call = executeScript.mock.calls.map((c) => c[0]).find((a: any) => a.func);
    return call?.args?.[1] as Record<string, unknown> | undefined;
  }

  it("scroll:true → 注入 func 的 opts 收到 scroll=true", async () => {
    await router.dispatch(mkReq({ scroll: true }));
    expect(funcCallOpts()?.scroll).toBe(true);
  });

  it("不传 scroll → opts.scroll 为 falsy(向后兼容,默认不滚动)", async () => {
    await router.dispatch(mkReq({}));
    expect(funcCallOpts()?.scroll).toBeFalsy();
  });

  it("scroll:true 仍返回正常文本结果(不破坏提取)", async () => {
    const resp = await router.dispatch(mkReq({ scroll: true }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBe("TEXT");
  });
});
