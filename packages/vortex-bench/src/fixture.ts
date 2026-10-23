// suite B 的自包含双 origin fixture（进程内 node:http，端口 0）。
//
// 为什么需要它：bench 既有 99 个 case 依赖 vite playground（localhost:5173，单 origin），
// 跑不快也进不了 CI。本 fixture 让**失败路径用例集（suite B）自包含**：
// 进程内起服务、不依赖任何外部进程，页面内容全部内联（HTML + 少量 JS）。
//
// 双 hostname 是关键：`http://127.0.0.1:<port>` 与 `http://localhost:<port>` 是**两个不同的
// origin**（host 不同即 origin 不同）。首页把 `http://localhost:<port>/child` 嵌成 iframe，
// 就得到一个真跨源（OOPIF）场景 —— 单 origin 的 fixture 造不出这种结构。
//
// 实测（本机 macOS）：`server.listen(0)` 不带 host 会绑 "::"（双栈），127.0.0.1 与 localhost
// 都可达；但 "localhost" 在 dns.lookup 里**先解析到 ::1**（/etc/hosts 两条都有），
// 只绑 0.0.0.0（IPv4）会让 localhost 侧不可达。故这里用「两个 server 共享 handler、
// 同端口分别绑 127.0.0.1 与 ::1」：无论 localhost 解析到哪个地址都可达。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Fixture {
  /** 首页基址，形如 `http://127.0.0.1:<port>`（无尾斜杠） */
  url: string;
  /** 关闭全部监听（幂等） */
  close: () => Promise<void>;
}

/** `/404` 错误页里的可断言标识文本（用例据此判定"页面确实报错了"）。 */
export const FIXTURE_NOT_FOUND_MARKER = "VORTEX_FIXTURE_404_NOT_FOUND";

/** 跨源 iframe 子页里的可断言标识文本。 */
export const FIXTURE_CHILD_MARKER = "CHILD_IFRAME_ORIGIN_OK";

/** 首页按钮点击后的文本（用例据此判定"点击真的生效了"）。 */
export const FIXTURE_TOGGLED_TEXT = "Toggled";

/** 首页按钮点击前的文本。 */
export const FIXTURE_TOGGLE_TEXT = "Toggle";

function homePage(port: number): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Vortex Fixture Home</title></head>
<body>
<h1 id="heading">Vortex Fixture Home</h1>
<button id="toggle" type="button" aria-label="Toggle">${FIXTURE_TOGGLE_TEXT}</button>
<input id="name" type="text" aria-label="Name" />
<iframe id="child-frame" title="Child Frame" src="http://localhost:${port}/child" width="240" height="80"></iframe>
<p id="status">READY</p>
<script>
  var btn = document.getElementById('toggle');
  btn.addEventListener('click', function () {
    btn.textContent = btn.textContent === ${JSON.stringify(FIXTURE_TOGGLE_TEXT)}
      ? ${JSON.stringify(FIXTURE_TOGGLED_TEXT)}
      : ${JSON.stringify(FIXTURE_TOGGLE_TEXT)};
    document.getElementById('status').textContent = 'TOGGLED';
  });
</script>
</body>
</html>`;
}

function childPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Vortex Fixture Child</title></head>
<body>
<p id="child-marker">${FIXTURE_CHILD_MARKER}</p>
</body>
</html>`;
}

function notFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>404 Not Found</title></head>
<body>
<h1 id="error-code">404</h1>
<p id="error-marker">${FIXTURE_NOT_FOUND_MARKER}</p>
<p>The requested fixture path does not exist.</p>
</body>
</html>`;
}

/** 被覆盖层完全盖住的目标页（造 OBSCURED 失败路径）。 */
function occludedPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Vortex Fixture Occluded</title></head>
<body>
<h1 id="heading">Vortex Fixture Occluded</h1>
<div style="position:relative;width:260px">
  <button id="covered" type="button" aria-label="Covered Button">Covered</button>
  <div id="cover" style="position:absolute;inset:0;background:rgba(0,0,0,0.08);z-index:10"></div>
</div>
</body>
</html>`;
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * 起 fixture。返回首页基址（`http://127.0.0.1:<port>`）与关闭函数。
 *
 * 路由：
 * - `/`         首页：按钮 `#toggle`、输入框 `#name`、跨源 iframe（src → `http://localhost:<port>/child`）
 * - `/child`    子页（iframe 目标）
 * - `/404`      明确错误页（404 状态 + `FIXTURE_NOT_FOUND_MARKER` 标识）
 * - `/occluded` 被覆盖层盖住的目标页（造 OBSCURED 失败路径）
 * - `/slow?ms=N` 延迟 N ms 才响应（造后台 tab 的慢请求，测事件隔离）
 */
export async function startFixture(): Promise<Fixture> {
  let port = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/") return sendHtml(res, 200, homePage(port));
    if (path === "/child") return sendHtml(res, 200, childPage());
    if (path === "/404") return sendHtml(res, 404, notFoundPage());
    if (path === "/occluded") return sendHtml(res, 200, occludedPage());
    if (path === "/slow") {
      const ms = Number.parseInt(url.searchParams.get("ms") ?? "3000", 10);
      const delay = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : 3000;
      const timer = setTimeout(() => {
        sendHtml(res, 200, `<!doctype html><html lang="en"><body><p id="slow-marker">SLOW_DONE</p></body></html>`);
      }, delay);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    return sendHtml(res, 404, notFoundPage());
  };

  const { servers, port: boundPort } = await bindFixtureServers(handler);
  port = boundPort;

  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.all(servers.map((s) => closeServer(s)));
    },
  };
}

/**
 * fixture 的绑定方案：
 * - `pair`：首选"同端口双 host"——第一个 server 绑 127.0.0.1，第二个共享同一 handler 绑另一个 host
 *   （::1）。这样 localhost 无论解析到 ::1 还是 127.0.0.1 都可达。
 * - `fallbacks`：首选失败时（无 IPv6 的机器）单 server 的回退顺序（依次尝试，同端口）。
 *
 * 可注入是为了单测能覆盖回退分支（真实 bind 失败，不 mock 网络）。
 */
export interface FixtureHostPlan {
  pair: readonly [string, string];
  fallbacks: readonly string[];
}

export const DEFAULT_HOST_PLAN: FixtureHostPlan = {
  pair: ["127.0.0.1", "::1"],
  fallbacks: ["::", "0.0.0.0"],
};

/**
 * 起 fixture 的服务并返回 { servers, port }。
 * - 首选：两个 server 共享 handler，同端口分别绑 pair[0] 与 pair[1]；
 * - 回退：pair[1] 绑不上 → 关掉第一个 server，按 fallbacks 顺序逐个试单 server
 *   （"::" 双栈 → "0.0.0.0" 纯 IPv4）；
 * - 全绑不上 → 抛错（错误信息带上每个候选地址的失败原因）。
 */
export async function bindFixtureServers(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  plan: FixtureHostPlan = DEFAULT_HOST_PLAN,
): Promise<{ servers: Server[]; port: number }> {
  const [firstHost, secondHost] = plan.pair;
  const failures: string[] = [];
  const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const primary = createServer(handler);
  try {
    await listen(primary, 0, firstHost);
  } catch (err) {
    failures.push(`${firstHost}:0 → ${errMsg(err)}`);
    throw new Error(
      `fixture 起不来：${[firstHost, secondHost, ...plan.fallbacks]
        .map((h) => `${h}:0`)
        .join(" / ")} 都绑不上（${failures.join("; ")}）`,
    );
  }
  const port = (primary.address() as AddressInfo).port;

  try {
    const secondary = createServer(handler);
    await listen(secondary, port, secondHost);
    return { servers: [primary, secondary], port };
  } catch (err) {
    // 第二个 host 绑不上（无 IPv6 的机器）→ 关掉第一个，回退单 server。
    failures.push(`${secondHost}:${port} → ${errMsg(err)}`);
    await closeServer(primary);
    const servers: Server[] = [];
    for (const host of plan.fallbacks) {
      const server = createServer(handler);
      try {
        await listen(server, port, host);
        servers.push(server);
        return { servers, port };
      } catch (err2) {
        failures.push(`${host}:${port} → ${errMsg(err2)}`);
        // 关掉**这个**刚绑失败的 server（它从未 listen 成功 → 立即返回）。
        // 注意：不能去关 servers[0] —— 此刻 servers 已被清空，会拿到 undefined。
        await closeServer(server);
        servers.length = 0;
      }
    }
    throw new Error(
      `fixture 起不来：${[firstHost, secondHost, ...plan.fallbacks]
        .map((h) => `${h}:${port}`)
        .join(" / ")} 都绑不上（${failures.join("; ")}）`,
    );
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * 关服。必须先断连接：Node 的 keep-alive 连接（fetch/undici 会留着）会让
 * `server.close()` 的回调一直不触发，close() 就会挂住。
 * 允许 undefined：调用点可能没有可关的 server（例如 bind 失败的回退分支）。
 */
function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
