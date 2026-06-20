import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerPageHandlers } from "../src/handlers/page.js";
import { setSnapshot } from "../src/lib/snapshot-store.js";

/**
 * BUG-002 (N0063): page.wait(mode=element) 支持 @ref。server.ts 把 @ref 翻成
 * index+snapshotId 后,WAIT handler 须经 resolveTarget 反查 selector(与 dom.* handler
 * 同源),再用现有 querySelector 轮询。历史实现只读 args.selector,index+snapshotId
 * 被忽略 → 落到无目标 plain-wait,等异步元素出现的诉求失效。
 */
function mkReq(args: Record<string, unknown>, tabId?: number): NmRequest {
  return {
    type: "tool_request",
    tool: "page.wait",
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  } as NmRequest;
}

function makeDebuggerMock() {
  return {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    sendCommand: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
    isAttached: vi.fn().mockReturnValue(true),
  } as never;
}

describe("page.wait @ref 解析 (BUG-002 N0063)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn().mockResolvedValue([{ result: true }]); // 元素已找到
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerPageHandlers(router, makeDebuggerMock());
  });

  it("index+snapshotId(来自 @ref 翻译)→ 经 resolveTarget 反查 selector 并轮询", async () => {
    setSnapshot("snap_x", {
      tabId: 42,
      capturedAt: Date.now(),
      elements: [{ index: 5, selector: "#inp" }],
    });
    const resp = await router.dispatch(
      mkReq({ index: 5, snapshotId: "snap_x", timeout: 1000 }, 42),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ found: true, selector: "#inp" });
    // executeScript 收到反查出的 selector 作 args[0]
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0][0].args[0]).toBe("#inp");
  });

  it("纯 CSS selector 仍直接轮询(无回归)", async () => {
    const resp = await router.dispatch(
      mkReq({ selector: ".btn", timeout: 1000 }, 42),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ found: true, selector: ".btn" });
  });

  it("无 target(纯等待)→ 不调 executeScript,走 plain wait", async () => {
    const resp = await router.dispatch(mkReq({ timeout: 30 }, 42));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ waited: 30 });
    expect(executeScript).not.toHaveBeenCalled();
  });

  // 空串 selector 历史上是 falsy → 落 plain-wait;改用 resolveTargetOptional 后 "" 非 null
  // 会进 resolveTarget 抛 INVALID_PARAMS。规范化为无目标,保持旧行为不回归(review N0063)。
  it("空串 selector → plain wait(不抛 INVALID_PARAMS,保持旧行为)", async () => {
    const resp = await router.dispatch(mkReq({ selector: "", timeout: 30 }, 42));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ waited: 30 });
    expect(executeScript).not.toHaveBeenCalled();
  });
});

/**
 * element 模式 MutationObserver 属性变更失明回归锁(白盒实机复现,2026-06-20)。
 *
 * 现象:wait_for(mode=element, "#x.ready") 等已存在元素的 class/属性翻转满足时,
 *   observer 配置 `{ childList: true, subtree: true }` 缺 attributes,classList.add
 *   不触发回调 → 即便条件满足仍 TIMEOUT。机制级(0 churn、DOM 匹配、回调从不触发)
 *   + live(class 8s 加上、元素真实匹配、12s TIMEOUT)双证。有后台 DOM churn 的页面
 *   会间歇性掩盖,静止/完成态页面可靠失败。
 *
 * 修复:observer 加 attributes:true,attributeName=class/aria-* 等翻转即重查 querySelector。
 */
describe("page.wait element 模式属性变更检测", () => {
  const PAGE_SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "page.ts"),
    "utf8",
  );
  it("MutationObserver 监听 attributes(已存在元素 class/属性翻转可被检测)", () => {
    // observer.observe 配置须含 attributes: true(否则纯属性变更失明)。
    const cfg = PAGE_SRC.match(
      /observer\.observe\(\s*document\.body,\s*\{[^}]*attributes:\s*true[^}]*\}\s*\)/,
    );
    expect(cfg).not.toBeNull();
    // childList/subtree 不回归(节点增删仍检测)。
    expect(PAGE_SRC).toMatch(/observer\.observe\(\s*document\.body,\s*\{[^}]*childList:\s*true[^}]*subtree:\s*true/);
  });
});
