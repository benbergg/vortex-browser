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
  bindFixtureServers,
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

describe("bindFixtureServers 的 host 回退", () => {
  it("首选双 host 失败后逐个回退，最后落到纯 IPv4（不因 servers 被清空而崩）", async () => {
    // 192.0.2.x 是 TEST-NET-1，本机没有这些地址 → bind 必然失败（EADDRNOTAVAIL）。
    // 于是走"首选双 host 失败 → 回退单 server"分支；第一个回退目标也失败，
    // 第二个回退目标 0.0.0.0（纯 IPv4）必须成功。
    const { servers, port } = await bindFixtureServers(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("v4-ok");
      },
      {
        pair: ["127.0.0.1", "192.0.2.1"],
        fallbacks: ["192.0.2.2", "0.0.0.0"],
      },
    );
    try {
      expect(port).toBeGreaterThan(0);
      expect(servers.length).toBe(1);
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("v4-ok");
    } finally {
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections?.();
              s.close(() => resolve());
            }),
        ),
      );
    }
  });

  it("所有候选 host 都绑不上时抛错（错误信息带每个候选地址）", async () => {
    await expect(
      bindFixtureServers(() => {}, {
        pair: ["192.0.2.1", "192.0.2.2"],
        fallbacks: ["192.0.2.3"],
      }),
    ).rejects.toThrow(/都绑不上/);
  });
});
