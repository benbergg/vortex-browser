/**
 * Snapshot 存储：由 observe handler 写入，由 dom.* handler 按 index 读出。
 *
 * 设计：
 * - Map<snapshotId, SnapshotEntry>
 * - 60s TTL，每次 newSnapshotId 前做一次被动 GC
 * - MV3 service worker 休眠会清空内存——这是 MV3 的固有限制，
 *   实际影响小（LLM 一般在 60s 内使用 snapshot）
 *
 * 多 frame（@since 0.4.0）：
 * - SnapshotElement.frameId 为元素所在 frame（跨 frame 全局唯一 index）
 * - SnapshotEntry.frameId 保留作为"主 frame hint"，向后兼容
 * - resolveTarget 优先读 element.frameId，否则回退到 entry.frameId
 */

export interface SnapshotElement {
  index: number;
  selector: string;
  /** 元素所在 frame id；跨 frame snapshot 用于路由。@since 0.4.0 */
  frameId?: number;
  /** descriptor 自愈：observe 计算的 ARIA role；选择器失效时重匹配用。@since v0.10 */
  role?: string;
  /** descriptor 自愈：observe 计算的 accessible name；选择器失效时重匹配用。@since v0.10 */
  name?: string;
}

export interface SnapshotEntry {
  tabId: number;
  /** 向后兼容字段：单 frame snapshot 的 frameId hint；多 frame 时忽略，按 element.frameId 路由 */
  frameId?: number;
  capturedAt: number;
  elements: SnapshotElement[];
}

const snapshots = new Map<string, SnapshotEntry>();
const SNAPSHOT_TTL_MS = 60_000;
let counter = 0;

export function newSnapshotId(): string {
  return `snap_${Date.now().toString(36)}_${++counter}`;
}

export function gcSnapshots(): void {
  const now = Date.now();
  for (const [id, entry] of snapshots) {
    if (now - entry.capturedAt > SNAPSHOT_TTL_MS) snapshots.delete(id);
  }
}

export function setSnapshot(id: string, entry: SnapshotEntry): void {
  snapshots.set(id, entry);
}

export function getSnapshotEntry(snapshotId: string): SnapshotEntry | undefined {
  return snapshots.get(snapshotId);
}
