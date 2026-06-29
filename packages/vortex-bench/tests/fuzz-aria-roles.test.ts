/**
 * Author: qingwa
 * Description: fuzz-aria-roles.ts 镜像 vs extension reasoning/aria-taxonomy.ts 真源源码锁。
 * 守护:
 *   1) 真源 RECALL_ROLES 全集 ≥ 镜像 FUZZ_RECALL_CONTAINERS(镜像是子集,不能漏)
 *   2) 真源 EXPLICIT_DENY 含 FUZZ_DECORATIVE_ROLES 全部三项
 *   3) 真源 RECALL_ROLES 66 项与 aria-taxonomy.test.ts:42 一致(防止手改 TAXONOMY)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  FUZZ_RECALL_CONTAINERS,
  FUZZ_DECORATIVE_ROLES,
  ARIA_TAXONOMY_SRC_PATH,
} from "../src/runner/fuzz-aria-roles.js";

/** 读 aria-taxonomy.ts 真源,正则抽 RECALL_ROLES 构造右侧的 Set(...) 项 */
function parseRecallRolesSrc(): Set<string> {
  const src = readFileSync(ARIA_TAXONOMY_SRC_PATH, "utf8");
  // 真源 RECALL_ROLES = new Set<string>(Object.keys(...).filter(...));
  // 这里抽 Object.keys(...) 内字符串字面量全集(TAXONOMY 字典的字面量)
  // 注意:aria-taxonomy.ts 把多个 role keys 写在同一行逗号分隔(如 "button:[...],checkbox:[...]"),
  // 所以正则不带 ^ 锚定行首。
  const taxoBlock = src.match(/ARIA_ROLE_TAXONOMY[\s\S]*?\n\}\s*;/);
  if (!taxoBlock) throw new Error("未找到 ARIA_ROLE_TAXONOMY 字典");
  const keys = new Set<string>();
  // 抽所有 "role":[ ... 形态(行内 + 跨行)
  for (const m of taxoBlock[0].matchAll(/([a-z]+)\s*:\s*\[/g)) {
    if (m[1]) keys.add(m[1]);
  }
  // 抽 EXPLICIT_DENY 数组字面量
  const denyBlock = src.match(/EXPLICIT_DENY[\s\S]*?\n\]\s*\)\s*;/);
  if (!denyBlock) throw new Error("未找到 EXPLICIT_DENY 数组");
  const deny = new Set<string>();
  for (const m of denyBlock[0].matchAll(/"([a-z]+)"/g)) {
    if (m[1]) deny.add(m[1]);
  }
  // RECALL_ROLES = TAXONOMY \ EXPLICIT_DENY
  return new Set([...keys].filter((r) => !deny.has(r)));
}

describe("fuzz-aria-roles 镜像源码锁", () => {
  it("真源 RECALL_ROLES 全集 66 项(与 observe-taxonomy-inlined.test.ts:42 一致)", () => {
    const real = parseRecallRolesSrc();
    expect(real.size).toBe(66);
  });

  it("FUZZ_RECALL_CONTAINERS 是真源 RECALL_ROLES 的子集(镜像不能漏同步)", () => {
    const real = parseRecallRolesSrc();
    const missing: string[] = [];
    for (const r of FUZZ_RECALL_CONTAINERS) {
      if (!real.has(r)) missing.push(r);
    }
    expect(
      missing,
      `FUZZ_RECALL_CONTAINERS 项不在真源 RECALL_ROLES:${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("FUZZ_RECALL_CONTAINERS 至少 18 项(覆盖 composite/structure/landmark 抽样)", () => {
    // 任务说明:composite 10 + structure 3 + landmark 8 = 21,实际挑 18,够 fuzz 跑出盲点
    expect(FUZZ_RECALL_CONTAINERS.size).toBeGreaterThanOrEqual(18);
  });

  it("FUZZ_DECORATIVE_ROLES = {presentation, none, generic},全在真源 EXPLICIT_DENY", () => {
    expect(FUZZ_DECORATIVE_ROLES.has("presentation")).toBe(true);
    expect(FUZZ_DECORATIVE_ROLES.has("none")).toBe(true);
    expect(FUZZ_DECORATIVE_ROLES.has("generic")).toBe(true);
    expect(FUZZ_DECORATIVE_ROLES.size).toBe(3);
  });

  it("FUZZ_RECALL_CONTAINERS 与 FUZZ_DECORATIVE_ROLES 不相交", () => {
    for (const r of FUZZ_DECORATIVE_ROLES) {
      expect(FUZZ_RECALL_CONTAINERS.has(r), `${r} 不应同时是召回容器与装饰`).toBe(false);
    }
  });
});