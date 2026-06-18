import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * O-3b 扩展自重载机制的源码级合约测试。
 *
 * server 侧 watcher + 扩展侧 control handler 必须成对存在，任一端脱钩就
 * 不工作。这里断言三处文件的关键不变式：
 *  1. shared/protocol.ts 定义 NmControl 且进入 NmMessageFromServer
 *  2. server/src/index.ts 安装 extension dist watcher，debounce + opt-out + 推送 control 消息
 *  3. extension/src/background.ts 的 NM onMessage 分支里处理 control.reload-extension 并调 chrome.runtime.reload()
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOCOL = readFileSync(
  join(__dirname, "..", "..", "shared", "src", "protocol.ts"),
  "utf8",
);
const SERVER_INDEX = readFileSync(
  join(__dirname, "..", "..", "server", "src", "index.ts"),
  "utf8",
);
// dev-reload 重构:扩展 dist 路径解析抽到 ext-dist.ts(供 watcher + /dev/reload-extension 共用)
const SERVER_EXT_DIST = readFileSync(
  join(__dirname, "..", "..", "server", "src", "ext-dist.ts"),
  "utf8",
);
const BG = readFileSync(
  join(__dirname, "..", "src", "background.ts"),
  "utf8",
);

describe("shared protocol NmControl (@since 0.4.0)", () => {
  it("defines NmControl with type 'control' and action 'reload-extension'", () => {
    expect(PROTOCOL).toMatch(/interface\s+NmControl\s*{/);
    expect(PROTOCOL).toMatch(/type:\s*["']control["']/);
    expect(PROTOCOL).toMatch(/action:\s*["']reload-extension["']/);
  });

  it("NmMessageFromServer includes NmControl", () => {
    expect(PROTOCOL).toMatch(
      /NmMessageFromServer\s*=\s*NmRequest\s*\|\s*NmPing\s*\|\s*NmControl/,
    );
  });
});

describe("server extension-dist watcher (@since 0.4.0 O-3b)", () => {
  it("exposes VORTEX_NO_EXT_AUTO_RELOAD opt-out", () => {
    expect(SERVER_INDEX).toMatch(/VORTEX_NO_EXT_AUTO_RELOAD/);
    // 默认开启：env 未设置也要生效
    expect(SERVER_INDEX).toMatch(
      /process\.env\.VORTEX_NO_EXT_AUTO_RELOAD\s*===\s*["']1["']/,
    );
  });

  it("resolves extension dist path from own module url, not hardcoded (ext-dist.ts)", () => {
    // 路径解析逻辑抽到 ext-dist.ts:watcher 与 /dev/reload-extension 共用同一锚点,
    // 保证「本 server 服务的 dist」单一真源(dev-reload C1 校验依赖此一致性)。
    expect(SERVER_EXT_DIST).toMatch(/fileURLToPath\(import\.meta\.url\)/);
    expect(SERVER_EXT_DIST).toMatch(/\.\.\/\.\.\/\.\.\/extension\/dist/);
    // index.ts 仍经 resolveExtensionDist() 取得 extDist 并 statSync 守卫
    expect(SERVER_INDEX).toMatch(/resolveExtensionDist\(\)/);
  });

  it("debounces multiple change events (vite build writes many files)", () => {
    expect(SERVER_INDEX).toMatch(/clearTimeout\(debounceTimer\)/);
    // 至少 1s 以上防抖，给 vite build 留余地——直接断言字面 "}, 2000);" 即可
    expect(SERVER_INDEX).toMatch(/}, (?:2000|2_000|3000|3_000)\)/);
  });

  it("filters to relevant file extensions only (.js / .html / manifest.json)", () => {
    // 源码里的正则字面量是 /\.(js|html)$|manifest\.json$/，在 TS 源文件里字面出现
    expect(SERVER_INDEX).toMatch(/\\\.\(js\|html\)\$/);
    expect(SERVER_INDEX).toMatch(/manifest\\\.json/);
  });

  it("pushes NmControl reload-extension via writeNmMessage on stdout", () => {
    expect(SERVER_INDEX).toMatch(
      /writeNmMessage\(\s*process\.stdout\s*,\s*\{[^}]*type:\s*["']control["'][^}]*action:\s*["']reload-extension["']/s,
    );
  });

  it("installExtensionDistWatcher is called from startServer near killOldProcess", () => {
    // 直接断言 startServer 体内（killOldProcess 之后不远处）调用 watcher
    expect(SERVER_INDEX).toMatch(
      /killOldProcess\(\);?[\s\S]{0,200}?installExtensionDistWatcher\(\)/,
    );
  });

  it("stat-check skips watch when extension dist is missing", () => {
    // 避免 extension 未 build 时 server 启动崩溃
    expect(SERVER_INDEX).toMatch(/statSync\(extDist\)/);
    expect(SERVER_INDEX).toMatch(/auto-reload disabled/);
  });
});

describe("extension background control handler (@since 0.4.0 O-3b)", () => {
  it("handles msg.type === 'control' in NM onMessage callback", () => {
    expect(BG).toMatch(/msg\.type\s*===\s*["']control["']/);
  });

  it("calls chrome.runtime.reload() on action === 'reload-extension'", () => {
    const hasReloadOnAction = /action\s*===\s*["']reload-extension["'][\s\S]{0,500}?chrome\.runtime\.reload\(\)/.test(
      BG,
    );
    expect(hasReloadOnAction).toBe(true);
  });

  it("reload is wrapped in setTimeout to let console flush", () => {
    // 非必须但有利于调试：reload 前给 console.warn 一个 tick
    expect(BG).toMatch(/setTimeout\(\s*\(\s*\)\s*=>\s*chrome\.runtime\.reload\(\)/);
  });
});
