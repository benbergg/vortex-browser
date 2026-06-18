import { VtxErrorCode, vtxError } from "@vortex-browser/shared";
import { getSnapshotEntry } from "./snapshot-store.js";

/**
 * handler 接受 `selector` 或 `{ index, snapshotId }` 两种元素定位方式，
 * 本 helper 统一解析并在必要时从 snapshot store 中反查 selector。
 */
export interface ResolvedTarget {
  selector: string;
  /** 使用 snapshot index 时绑定的 tab/frame，优先级高于 args.tabId / args.frameId */
  boundTabId?: number;
  boundFrameId?: number;
  /** stale 选择器自愈用；仅 index 路径且 snapshot 存了 role/name 时有值。@since v0.10 */
  descriptor?: { role?: string; name: string };
}

export function resolveTarget(args: Record<string, unknown>): ResolvedTarget {
  const selector = args.selector as string | undefined;
  const index = args.index as number | undefined;
  const snapshotId = args.snapshotId as string | undefined;

  if (selector != null && index !== undefined) {
    throw vtxError(
      VtxErrorCode.INVALID_PARAMS,
      "Provide either `selector` or `index`, not both",
    );
  }

  if (selector != null && selector !== "") {
    return { selector };
  }

  if (index !== undefined) {
    if (!snapshotId) {
      throw vtxError(
        VtxErrorCode.INVALID_PARAMS,
        "`index` requires `snapshotId` (obtain from vortex_observe)",
      );
    }
    const entry = getSnapshotEntry(snapshotId);
    if (!entry) {
      throw vtxError(
        VtxErrorCode.STALE_SNAPSHOT,
        `Snapshot ${snapshotId} expired or not found`,
        { snapshotId },
      );
    }
    const hit = entry.elements.find((e) => e.index === index);
    if (!hit) {
      throw vtxError(
        VtxErrorCode.INVALID_INDEX,
        `Index ${index} not found in snapshot ${snapshotId}`,
        { snapshotId, index },
      );
    }
    // name 非空时才带 descriptor，向后兼容（无 descriptor 的旧 snapshot 保持 undefined）
    const descriptor =
      hit.name != null && hit.name !== ""
        ? { role: hit.role, name: hit.name }
        : undefined;
    return {
      selector: hit.selector,
      boundTabId: entry.tabId,
      // 跨 frame snapshot 时 element.frameId 才是权威；回退到 entry.frameId（兼容旧单 frame snapshot）
      boundFrameId: hit.frameId ?? entry.frameId,
      ...(descriptor ? { descriptor } : {}),
    };
  }

  throw vtxError(
    VtxErrorCode.INVALID_PARAMS,
    "Missing required param: provide `selector` or `index` + `snapshotId`",
  );
}

/**
 * selector/index 都可缺省的变体（如 dom.scroll 允许按 position 滚动）。
 * 两者都未提供时返回 undefined，调用方走原有无目标路径。
 */
export function resolveTargetOptional(
  args: Record<string, unknown>,
): ResolvedTarget | undefined {
  if (args.selector == null && args.index == null) return undefined;
  return resolveTarget(args);
}
