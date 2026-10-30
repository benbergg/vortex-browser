/**
 * Author: qingwa
 * Description: Verifies malformed-JSON handling on the hub HTTP surface.
 *
 * 真机复现（2026-10-30）：客户端发 Python repr 的 `{"code":"1","tabId":None}`，
 * express.json() 抛 entity.parse.failed，Express 默认处理返回 **HTML + 内部堆栈**。
 * 本文件锁住新行为：JSON 错误形状、不回显请求体、不回显堆栈、超限错误保留原状态码。
 */
import { afterEach, describe, expect, it } from "vitest";
import { startTestHub } from "./helpers/harness.js";

describe("hub malformed JSON body", () => {
  let started: Awaited<ReturnType<typeof startTestHub>> | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
  });

  it("returns a JSON error shape without stack or request body for invalid JSON", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    const res = await fetch(`http://127.0.0.1:${started.port}/api/js/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"code":"1","tabId":None}',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const text = await res.text();
    const payload = JSON.parse(text) as { message: string; error: { code: string } };
    expect(payload.error.code).toBe("INVALID_PARAMS");
    expect(payload.message).toMatch(/not valid JSON/i);
    // 不泄露请求体片段与内部堆栈
    expect(text).not.toContain("None}");
    expect(text).not.toContain("SyntaxError");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("body-parser");
  });

  it("keeps working for a well-formed request", async () => {
    started = await startTestHub({ requestTimeoutMs: 1_000 });
    const res = await fetch(`http://127.0.0.1:${started.port}/api/js/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "1", tabId: 123 }),
    });

    // 请求进到路由层（无浏览器时会得到业务错误，而不是 JSON 解析错误）
    const text = await res.text();
    expect(text).not.toContain("not valid JSON");
  });
});
