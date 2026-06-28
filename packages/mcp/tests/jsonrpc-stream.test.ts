import { describe, it, expect } from "vitest";
import { LineFramer, frame, isRequest, isResponse } from "../src/lib/jsonrpc-stream.js";

describe("LineFramer", () => {
  it("解析单条完整行", () => {
    const f = new LineFramer();
    const out = f.push('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(out).toHaveLength(1);
    expect(out[0].msg.method).toBe("initialize");
    expect(out[0].raw).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
  });

  it("跨分块拼接半行", () => {
    const f = new LineFramer();
    expect(f.push('{"id":1,')).toHaveLength(0);
    const out = f.push('"method":"x"}\n');
    expect(out).toHaveLength(1);
    expect(out[0].msg.id).toBe(1);
  });

  it("一次吐多条 + 忽略空行", () => {
    const f = new LineFramer();
    const out = f.push('{"id":1}\n\n{"id":2}\n');
    expect(out.map((o) => o.msg.id)).toEqual([1, 2]);
  });

  it("跳过非 JSON 行不毒化后续", () => {
    const f = new LineFramer();
    const out = f.push('garbage\n{"id":3}\n');
    expect(out).toHaveLength(1);
    expect(out[0].msg.id).toBe(3);
  });
});

describe("frame / 判型", () => {
  it("frame 追加换行", () => {
    expect(frame({ id: 1, method: "x" })).toBe('{"id":1,"method":"x"}\n');
  });
  it("isRequest = 有 id 有 method", () => {
    expect(isRequest({ id: 1, method: "x" })).toBe(true);
    expect(isRequest({ method: "notifications/initialized" })).toBe(false); // 通知无 id
    expect(isRequest({ id: 1, result: {} })).toBe(false); // 响应无 method
  });
  it("isResponse = 有 id 无 method 有 result/error", () => {
    expect(isResponse({ id: 1, result: {} })).toBe(true);
    expect(isResponse({ id: 1, error: { code: -1 } })).toBe(true);
    expect(isResponse({ id: 1, method: "x" })).toBe(false);
  });
});
