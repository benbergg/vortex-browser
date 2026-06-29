/**
 * Author: qingwa
 * Description: mcp 侧 aria-taxonomy 与 extension 真源镜像同步锁。
 *   mcp 包单向依赖 shared,不能 import extension 真源,故在 mcp 侧重建镜像。
 *   本测试静态读两份源码,提取 `ARIA_ROLE_TAXONOMY` 字面 entries 的 key 集合
 *   比对,确保两边大小/键一致(任何扩展需同步两处)。
 *
 *   真源:packages/extension/src/reasoning/aria-taxonomy.ts
 *   镜像:packages/mcp/src/lib/aria-taxonomy.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = packages/mcp/tests
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const EXT_TAXONOMY = resolve(REPO_ROOT, "packages/extension/src/reasoning/aria-taxonomy.ts");
const MCP_TAXONOMY = resolve(REPO_ROOT, "packages/mcp/src/lib/aria-taxonomy.ts");

/**
 * 从源文件中提取 `ARIA_ROLE_TAXONOMY` 对象的字面 keys。
 * 简陋的文本扫描(基于行的 `<key>:[...` 模式),够用——两份源都按统一格式手维护。
 * 不引入 TypeScript compiler 依赖,避免测试时间膨胀。
 */
function extractTaxonomyKeys(src: string): Set<string> {
  const keys = new Set<string>();
  const lines = src.split("\n");
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      // 进入 ARIA_ROLE_TAXONOMY 字面:行内含 `export const ARIA_ROLE_TAXONOMY` + `{`。
      // 用 /\{/ 检查该行有 `{`,而非依赖 = 或 :,因为定义是
      // `export const ARIA_ROLE_TAXONOMY: Record<...> = {`。
      if (/export\s+const\s+ARIA_ROLE_TAXONOMY/.test(line) && line.includes("{")) inBlock = true;
      continue;
    }
    if (line.trim() === "};") break;
    // 匹配 `  <key>:[...` 或 `  <key>:["widget","composite"]`
    const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*\[/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

describe("mcp aria-taxonomy 与 extension 真源镜像同步", () => {
  it("ARIA_ROLE_TAXONOMY 字面 keys 完全一致(mcp ⊆ ext 且 ext ⊆ mcp)", () => {
    const extSrc = readFileSync(EXT_TAXONOMY, "utf8");
    const mcpSrc = readFileSync(MCP_TAXONOMY, "utf8");
    const extKeys = extractTaxonomyKeys(extSrc);
    const mcpKeys = extractTaxonomyKeys(mcpSrc);
    expect(extKeys.size, "ext 真源应有 >0 keys,提取失败?").toBeGreaterThan(0);
    // 子集关系:两边应严格相等
    const missing = [...extKeys].filter(k => !mcpKeys.has(k));
    const extra = [...mcpKeys].filter(k => !extKeys.has(k));
    expect(missing, `mcp 缺失 ext 真源 keys: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `mcp 多出 ext 真源 keys: ${extra.join(", ")}`).toEqual([]);
  });

  it("EXPLICIT_DENY 集合大小一致(粗粒度,与真源严格镜像)", () => {
    const extSrc = readFileSync(EXT_TAXONOMY, "utf8");
    const mcpSrc = readFileSync(MCP_TAXONOMY, "utf8");
    // 提取 EXPLICIT_DENY Set 字面 entries 数 — 用 Set 出现行到下一个 ] 的所有引号包字符串计数。
    const count = (src: string): number => {
      const m = /EXPLICIT_DENY[^]*?new\s+Set\(\[([\s\S]*?)\]\)/.exec(src);
      if (!m) return -1;
      const matches = m[1].match(/"[^"]+"/g) ?? [];
      return matches.length;
    };
    expect(count(mcpSrc)).toBe(count(extSrc));
  });

  it("CATEGORY_PRIORITY 顺序在两边完全一致", () => {
    const extSrc = readFileSync(EXT_TAXONOMY, "utf8");
    const mcpSrc = readFileSync(MCP_TAXONOMY, "utf8");
    const extract = (src: string): string[] => {
      const m = /CATEGORY_PRIORITY\s*:\s*AriaCategory\[\]\s*=\s*\[([^\]]+)\]/.exec(src);
      if (!m) return [];
      return (m[1].match(/"([a-z]+)"/g) ?? []).map(s => s.slice(1, -1));
    };
    expect(extract(mcpSrc)).toEqual(extract(extSrc));
  });
});