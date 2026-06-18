import { describe, it, expect, vi } from "vitest";
import { MessageRouter } from "../src/message-router.js";

/**
 * dev-reload(按需触发扩展自重载)桥接层单测。
 *
 * pushReloadExtension 是被动 dist watcher 的主动版:SW 在线时写一条
 * {type:"control",action:"reload-extension"} 到 NM stdout;离线时直接返回 false
 * (不缓冲),把「写给睡眠 SW 被静默丢弃」(C2)变成显式失败让端点上报。
 */

function mkSessions() {
  return { getClient: () => null } as any;
}

/** 解 writeNmMessage 的帧:第 2 次 write 是 json buffer(第 1 次是 4 字节长度头)。 */
function decodeLastNmFrame(write: ReturnType<typeof vi.fn>): unknown {
  const calls = write.mock.calls;
  const jsonBuf = calls[calls.length - 1][0] as Buffer;
  return JSON.parse(jsonBuf.toString("utf-8"));
}

describe("MessageRouter dev-reload 控制消息", () => {
  it("isNmConnected 反映 setNmConnected 状态", () => {
    const router = new MessageRouter({ write: vi.fn() } as never, mkSessions());
    expect(router.isNmConnected()).toBe(false);
    router.setNmConnected(true);
    expect(router.isNmConnected()).toBe(true);
    router.setNmConnected(false);
    expect(router.isNmConnected()).toBe(false);
  });

  it("已连:pushReloadExtension 写 control/reload-extension 帧并返回 true", () => {
    const write = vi.fn();
    const router = new MessageRouter({ write } as never, mkSessions());
    router.setNmConnected(true);
    const ok = router.pushReloadExtension("dev_reload");
    expect(ok).toBe(true);
    const frame = decodeLastNmFrame(write) as { type: string; action: string; reason?: string };
    expect(frame.type).toBe("control");
    expect(frame.action).toBe("reload-extension");
    expect(frame.reason).toBe("dev_reload");
  });

  it("未连:pushReloadExtension 不写任何帧并返回 false(C2 不静默丢)", () => {
    const write = vi.fn();
    const router = new MessageRouter({ write } as never, mkSessions());
    // 默认未连
    const ok = router.pushReloadExtension("dev_reload");
    expect(ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
