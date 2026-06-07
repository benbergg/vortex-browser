/**
 * Author: 青蛙
 * Description: Regression lock for 缺陷⑤: MCP 端 activeSnapshotId
 *   导航时不清空, bare ref 绕过 v0.8 hash 严格检查。
 *
 * Trigger: v4 评价信息操作深度评测（淘宝）— 旧 ref 跨页点中:
 *   1. vortex_observe #1 (taobao.com home) → snapshot H1, "@H1:e121" = "1待评价"
 *   2. vortex_act @H1:e121 click → 导航到 buyertrade
 *   3. vortex_act @H1:e121 click (stale ref, 但 hash 一致) → "success" (错!)
 *      应 throw STALE_SNAPSHOT。
 *
 * 根因: server.ts:85 状态变量 + line 350-352 仅在 observe path 更新, 没有
 * 任何代码监听 navigation/tab change 来清空。ref-parser.ts:107 bare ref
 * 只记统计 + 一次 deprecation warn, **不**拒绝; line 118 严判对 bare ref
 * 不生效 (r.hash === undefined 时跳过)。
 *
 * 修法（评审 #1+#3 组合, 适配 MCP 跑在 Node 无 chrome.webNavigation）:
 *   - server.ts 维护 activeSnapshotTabId + activeSnapshotCapturedAt
 *   - resolveTargetParam 接受 tabId 参数, 与 activeSnapshotTabId 对比
 *   - 不一致 throw STALE_SNAPSHOT（覆盖 bare ref + 带 hash ref 两种）
 *
 * 备注: 真 Chrome E2E 时, 导航事件实际通过 extension 端转发到 server 再
 * 转发到 mcp（NM ↔ WS ↔ stdio 三段链路）。本测试聚焦 mcp 端的解析与状态
 * 校验逻辑, 不模拟全链路。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseRef,
  resolveTargetParam,
  getBareRefStats,
  _resetBareRefStats,
} from "../src/lib/ref-parser.js";

describe("缺陷⑤: MCP 端 activeSnapshotId 导航不清空 + bare ref bypass (2026-06-07 淘宝评测)", () => {
  beforeEach(() => {
    _resetBareRefStats();
  });

  // ============================================================
  // 现有行为保留测试
  // ============================================================

  it("现有 CSS selector 原样返回", () => {
    expect(
      resolveTargetParam("#my-btn", "snap_1", "abcd", 100),
    ).toEqual({ selector: "#my-btn" });
  });

  it("现有 bare ref 在 activeSnapshotId 存在 + tabId 匹配时通过 (向后兼容)", () => {
    // 现有: bare ref + 有效 snapshot + tab 匹配 → 应返回 index
    const r = resolveTargetParam("@e3", "snap_1", "abcd", 100);
    expect(r).toEqual({ index: 3, snapshotId: "snap_1", frameId: 0 });
  });

  it("现有 bare ref 无 activeSnapshotId 时 throw STALE_SNAPSHOT", () => {
    expect(() => resolveTargetParam("@e3", null, null, 100)).toThrow(
      /no active snapshot/i,
    );
  });

  it("现有带 hash 的 ref 在 hash 匹配时通过", () => {
    const r = resolveTargetParam("@abcd:e3", "snap_1", "abcd", 100);
    expect(r).toEqual({ index: 3, snapshotId: "snap_1", frameId: 0 });
  });

  it("现有带 hash 的 ref 在 hash 不匹配时 throw STALE_SNAPSHOT (v0.8 严判)", () => {
    expect(() => resolveTargetParam("@abcd:e3", "snap_1", "efgh", 100)).toThrow(
      /expired snapshot/i,
    );
  });

  // ============================================================
  // 新行为测试 — 修复应新增这些逻辑
  // ============================================================

  it("新行为 1: bare ref 在 activeSnapshotId 存在但 tabId 不匹配时 throw STALE_SNAPSHOT (导航后失效)", () => {
    // 模拟: observe 记录 tabId=100, 之后导航到 tabId=200, 旧 bare ref 命中
    // 修复后: 抛 STALE_SNAPSHOT ("tab changed since observe") 而非 success
    expect(() => resolveTargetParam("@e3", "snap_1", "abcd", 100, 200)).toThrow(
      /STALE_SNAPSHOT|tab changed|expired/i,
    );
  });

  it("新行为 2: 带 hash 的 ref 在 hash 匹配但 tabId 不匹配时 throw STALE_SNAPSHOT (更深保险)", () => {
    // 评审指出: 即便 hash 一致, 导航后 active snapshot hash 未清空仍 === 自身
    // hash, 严判放行, 但实际 snapshot 已失效。修复: tabId 维度校验独立于 hash。
    expect(() => resolveTargetParam("@abcd:e3", "snap_1", "abcd", 100, 200)).toThrow(
      /STALE_SNAPSHOT|tab changed|expired/i,
    );
  });

  it("新行为 3: 跨 tab observe-click 走两次不同 tabId 流程的 bare ref 应 throw", () => {
    // 完整流程: observe on tabA → navigate → use old ref on tabB
    // 应 throw 而非静默 success
    expect(() => resolveTargetParam("@e121", "snap_obs1", "3f5f", 984521590, 984521633)).toThrow(
      /STALE_SNAPSHOT|tab changed|expired/i,
    );
  });

  it("新行为 4: parseRef 不应受 tabId 校验影响 (parseRef 只解析格式, tabId 在 resolve 阶段)", () => {
    // parseRef 保持纯解析, 不引入 tabId 维度
    expect(parseRef("@e3")).toEqual({ kind: "ref", index: 3, frameId: 0 });
    expect(parseRef("@abcd:e3")).toEqual({
      kind: "ref",
      index: 3,
      frameId: 0,
      hash: "abcd",
    });
  });
});
