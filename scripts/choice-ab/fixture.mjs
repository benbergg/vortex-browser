// 盲测靶场:一个自带的最小站点,让 harness 不依赖用户任何真实项目。
//
// 依赖用户的 dev server 有两个问题:server 没起时被试会直接放弃(测不到选择),
// 且 CHANGELOG/代码里可能有 vortex 字样污染被试。这里的 fixture 目录是空的干净目录。

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE = (title, body) => `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{--fg:#111;--bg:#fff;--line:#e5e5e5}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui;color:var(--fg);background:var(--bg)}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:16px 24px;display:flex;gap:24px}
main{max-width:960px;margin:0 auto;padding:32px 24px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{border:1px solid var(--line);border-radius:8px;padding:16px}
.wide{min-width:640px;overflow-x:auto}
label{display:block;margin:12px 0 4px}input{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px}
button{margin-top:16px;padding:10px 20px;border:0;border-radius:6px;background:#111;color:#fff}
</style></head><body>${body}</body></html>`;

const HOME = PAGE(
  "Fixture 首页",
  `<header><strong>Fixture</strong><a href="/">首页</a><a href="/signup">注册</a></header>
   <main><h1>产品概览</h1>
   <div class="grid"><div class="card"><h3>指标 A</h3><p>1,284</p></div>
   <div class="card"><h3>指标 B</h3><p>96.5%</p></div>
   <div class="card"><h3>指标 C</h3><p>32ms</p></div></div>
   <div class="card wide"><h3>宽内容(窄屏下会横向溢出)</h3>
   <p>这一块最小宽度 640px，视口小于它时应出现横向滚动。</p></div></main>`,
);

const SIGNUP = PAGE(
  "注册",
  `<header><strong>Fixture</strong><a href="/">首页</a></header>
   <main><h1>创建账号</h1><form>
   <label for="e">邮箱</label><input id="e" name="email" type="email">
   <label for="p">密码</label><input id="p" name="password" type="password">
   <button type="submit">注册</button></form></main>`,
);

/** 起 fixture 站点 + 一个空的干净工作目录(无 CLAUDE.md,无仓库文件) */
export async function startFixture() {
  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const html = path.startsWith("/signup") ? SIGNUP : HOME;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const dir = mkdtempSync(join(tmpdir(), "choice-ab-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2));

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    cwd: dir,
    stop: () => new Promise((r) => server.close(r)),
  };
}
