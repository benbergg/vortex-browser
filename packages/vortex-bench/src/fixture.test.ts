// startFixture 的契约单测：双 origin（127.0.0.1 + localhost 同端口）+ 自包含页面 + /404 错误页。
//
// fixture 是 suite B（失败路径用例集）的唯一外部依赖：
// - 端口 0 自选，进程内 node:http，不依赖 vite playground（suite B 必须自包含）；
// - 同一端口上 127.0.0.1 与 localhost 都能访问 —— 首页嵌 `http://localhost:<port>/child`，
//   host 不同即 origin 不同，iframe 才是**真跨源**（能造出 OOPIF 场景）；
// - 页面内容自包含（内联 HTML + 少量 JS），用例不需要额外静态资源。

import { describe, it, expect, afterEach } from "vitest";
import {
  startFixture,
  FIXTURE_NOT_FOUND_MARKER,
  type Fixture,
} from "./fixture.js";

let fixture: Fixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

describe("startFixture 双 origin fixture", () => {
  it("url 以 http://127.0.0.1:<port> 开头", async () => {
    fixture = await startFixture();
    expect(fixture.url.startsWith("http://127.0.0.1:")).toBe(true);
    const parsed = new URL(fixture.url);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.port).not.toBe("");
  });

  it("同一端口用 localhost 也能拿到响应（造真跨源 iframe 的前提）", async () => {
    fixture = await startFixture();
    const port = new URL(fixture.url).port;
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="toggle"');
  });

  it("首页含按钮 #toggle、输入框 #name 与指向 localhost 的跨源 iframe", async () => {
    fixture = await startFixture();
    const port = new URL(fixture.url).port;
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(body).toContain('id="toggle"');
    expect(body).toContain('id="name"');
    expect(body).toContain(`http://localhost:${port}/child`);
    // iframe 的 origin 与首页 origin 必须不同（host 不同）——否则不是跨源
    expect(`http://localhost:${port}`).not.toBe(new URL(fixture.url).origin);
  });

  it("/404 返回 404 且 body 含错误标识文本", async () => {
    fixture = await startFixture();
    const res = await fetch(`${fixture.url}/404`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain(FIXTURE_NOT_FOUND_MARKER);
  });

  it("close() 之后请求失败", async () => {
    fixture = await startFixture();
    const url = fixture.url;
    await fixture.close();
    fixture = null;
    await expect(fetch(`${url}/`)).rejects.toThrow();
  });
});
