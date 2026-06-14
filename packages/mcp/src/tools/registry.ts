// packages/mcp/src/tools/registry.ts
//
// v0.6: tools/list 仅返回 11 个 public 工具（spec L4 §0.2.1 字节预算 ≤ 4500 B）。
// v0.5 的 36 个工具中，25 个内部化（实现保留供 L4 act/extract/observe 内部 dispatch 调用），
// vortex_ping 删除。

import type { ToolDef } from "./schemas.js";
import { getAllToolDefs } from "./schemas.js";
import { PUBLIC_TOOLS } from "./schemas-public.js";

const publicMap = new Map<string, ToolDef>();
const internalMap = new Map<string, ToolDef>();

function ensureMaps(): void {
  if (publicMap.size === 0) {
    for (const def of PUBLIC_TOOLS) publicMap.set(def.name, def);
  }
  if (internalMap.size === 0) {
    for (const def of getAllToolDefs()) internalMap.set(def.name, def);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// caps opt-in 机制
// ──────────────────────────────────────────────────────────────────────────────
//
// 默认 enabledCaps 为空 → getToolDefs/getToolDef 行为与现状完全一致（20 公开工具）。
// server.ts 启动时解析 `--caps=<csv>` 并调 setEnabledCaps；之后 internal 工具中
// `cap ∈ enabledCaps` 的会被「提升」进 public 面（出现在 tools/list、可经
// getToolDef 解析）。提升的工具不进 publicMap 本体（保持 PUBLIC_TOOLS 纯净），
// 而是在每次查询时按当前 enabledCaps 动态合并。

/** 模块级已启用 cap 集合。空集 = 无 opt-in（默认）。 */
let enabledCaps = new Set<string>();

/**
 * 设置已启用的 caps。重复调用为幂等覆盖（非追加）；传空数组回到默认面。
 * 由 server.ts 启动期解析 `--caps=<csv>` 后调用，单测亦可直接调用。
 */
export function setEnabledCaps(caps: string[]): void {
  enabledCaps = new Set(caps);
}

/** 当前已启用 caps（只读副本，便于诊断 / 测试）。 */
export function getEnabledCaps(): string[] {
  return [...enabledCaps];
}

/**
 * 收集 internal 工具中 cap 已启用的那些（按 internalMap 顺序，去重 public 已含名）。
 * enabledCaps 为空时返回空数组 → 默认面不变。
 */
function promotedCapTools(): ToolDef[] {
  if (enabledCaps.size === 0) return [];
  const out: ToolDef[] = [];
  for (const def of internalMap.values()) {
    if (def.cap && enabledCaps.has(def.cap) && !publicMap.has(def.name)) {
      out.push(def);
    }
  }
  return out;
}

/**
 * 对外暴露给 LLM 的工具（默认 20 个 public）。
 * 启用 cap 后，额外并入 cap 已启用的 internal 工具。
 */
export function getToolDefs(): ToolDef[] {
  ensureMaps();
  return [...publicMap.values(), ...promotedCapTools()];
}

/**
 * 按名查 public tool（用于 tools/call 入口校验）。
 * 启用 cap 后，cap 已启用的 internal 工具也可被此函数解析。
 */
export function getToolDef(name: string): ToolDef | undefined {
  ensureMaps();
  const pub = publicMap.get(name);
  if (pub) return pub;
  // cap 提升通道：internal 工具且其 cap 已启用
  const internal = internalMap.get(name);
  if (internal?.cap && enabledCaps.has(internal.cap)) return internal;
  return undefined;
}

/**
 * v0.5 全 36 工具（含已内部化的 25 个）。仅用于 L4 dispatch 内部 routing，
 * 不应在 tools/list 暴露。`vortex_ping` 已从 schemas.ts 删除。
 */
export function getInternalToolDef(name: string): ToolDef | undefined {
  ensureMaps();
  return internalMap.get(name);
}
