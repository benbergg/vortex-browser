/**
 * Author: qingwa
 * Description: I23 — enableDomain 只能用于确实有 enable 命令的 CDP 域。
 *
 * 运行时守卫只在那条路径被执行时才响；很多 CDP 分支在单测里根本跑不到。
 * 这条静态不变量在 CI 就拦下来，代价是一次源码扫描。
 *
 * 取代了原先针对 Emulation 的两条字符串源码锁 —— 那种写法只防上一个 bug，
 * 下一个域出问题照样漏。
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAINS_WITH_ENABLE } from "../../src/lib/cdp-domains.js";
import { findEnableDomainCalls } from "../helpers/scan-enable-domain.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (name.endsWith(".ts")) yield p;
  }
}

describe("扫描器本身", () => {
  it("认出字面量域名", () => {
    const calls = findEnableDomainCalls('await debuggerMgr.enableDomain(tabId, "Emulation");');
    expect(calls).toEqual(["Emulation"]);
  });

  it("认出带类型断言与不同变量名的写法", () => {
    const src = `
      await (debuggerMgr as DebuggerManager).enableDomain(tabId, "DOM");
      await debuggerMgr.enableDomain(tid, 'Network');
    `;
    expect(findEnableDomainCalls(src).sort()).toEqual(["DOM", "Network"]);
  });

  it("不把方法定义本身当调用", () => {
    expect(findEnableDomainCalls("async enableDomain(tabId: number, domain: string)")).toEqual([]);
  });
});

describe("I23: enableDomain 的域必须有 enable 命令", () => {
  const found: string[] = [];
  for (const file of tsFiles(SRC)) found.push(...findEnableDomainCalls(readFileSync(file, "utf8")));

  it("扫描确实命中了调用点（否则空集会让这条不变量假绿）", () => {
    expect(found.length).toBeGreaterThan(5);
  });

  it("每个被 enable 的域都在白名单里", () => {
    const bad = [...new Set(found)].filter((d) => !DOMAINS_WITH_ENABLE.has(d));
    expect(bad).toEqual([]);
  });
});
