// packages/mcp/src/tools/schema-fingerprint.ts
//
// MCP 工具集指纹：ping 响应里的 schemaHash 用它算。
//
// 为什么要覆盖 schema 形状（2026-11-20 D-1）：旧实现只哈希
// `${name}:${action}:${description.length}` —— 公开 schema 改了参数（加字段、
// 改类型、改 required）而 description 长度没变时，指纹不变，缓存方察觉不到。
// 现在把 schema 本体也纳入指纹。
//
// 单独成文件的原因：server.ts 有顶层副作用（建 server + connect stdio），
// 单测无法 import 它；指纹算法必须能被单测**直接约束生产实现**，否则测试
// 只能自己复刻一份算法，生产改了也不会红。

import { createHash } from "node:crypto";
import type { ToolDef } from "./schemas.js";

/**
 * 计算工具集指纹（12 位小写 hex）。
 * @param defs 待算指纹的工具定义（生产传公开面 getToolDefs()）。
 */
export function computeSchemaHash(defs: ToolDef[]): string {
  const payload = defs
    .map(
      (d) =>
        `${d.name}:${d.action}:${d.description.length}:${JSON.stringify(d.schema ?? {})}`,
    )
    .sort()
    .join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}
