/**
 * Author: qingwa
 * Description: 解析「实际目标 tab 身份」——一个不带 tab 的请求真正会落在哪个 tab 上。
 *
 * **为什么要有这个模块**（定向修复轮 Important ①）：
 * 快照上下文必须按**实际 tab 身份**绑定，而不是按「用户有没有传 --tab」。
 * - 未指定 tab 时，请求落在**该 session 当时的当前 tab**上；
 * - 同一个 session 切了 tab 之后，旧 tab 的快照就不能再被沿用
 *   （扩展 resolveTarget 的 boundTabId 优先于请求里的 tab，沿用就真点在别的 tab 上）；
 * - 反过来，同一个 tab 的 `act --tab A` 必须放行（那是同一个 tab，不是跨 tab）。
 *
 * 「session 当前 tab」的口径与 hub 一致：hub 把不带 tabId 的请求路由到
 * `session.currentTabId`，并在 tab.list 的结果里给该 tab 打 `current: true` 标注
 * （packages/hub/src/router.ts 的 annotateTabList）。
 * 所以这里读 tab.list 的 `current` 标注，拿到的是**同一个口径**的值，不是另起炉灶的猜测。
 *
 * 判不出来时**宁可拒绝**：返回一个可读错误，让调用方重新 observe，绝不沿用
 * 可能属于别的 tab 的快照。
 */
import { VtxErrorCode } from "@vortex-browser/shared";
import { sendRequest, formatCliError } from "../client.js";

/** tab.list 里的一条 tab（只取本模块用得到的字段）。 */
interface TabRecord {
  id?: unknown;
  /** hub 标注：这一条是不是该 session 的当前 tab。 */
  current?: unknown;
}

/**
 * 读出该 session 的当前 tab id；判不出来返回 undefined。
 *
 * 只读 tab.list（tabless action）：它不会改动 session 的 tab 归属，
 * 因此在 observe 之后调用是安全的——那时 hub 已经给这次请求回填了 tabId，
 * 读回来的就是**扩展真正观察到的那一个 tab**。
 */
export async function resolveSessionCurrentTab(port: number, session: string): Promise<number | undefined> {
  let result: unknown;
  try {
    const resp = await sendRequest("tab.list", {}, { port, session });
    result = resp.result;
  } catch {
    // tab.list 失败 = 判不出当前 tab：调用方按「宁可拒绝」处理。
    return undefined;
  }
  if (!Array.isArray(result)) return undefined;
  const current = (result as TabRecord[]).find(
    (tab) => tab && typeof tab === "object" && tab.current === true && typeof tab.id === "number",
  );
  return current && typeof current.id === "number" ? current.id : undefined;
}

/**
 * 解析一次请求的**实际目标 tab**。
 *
 * - 显式给了 tab（`--tab`）⇒ 就是它，不额外问服务端；
 * - 没给 ⇒ 读该 session 的当前 tab（即不带 tab 的请求真正会落到的 tab）。
 *
 * 判不出来就抛一个可读错误（调用方转成进程退出）：
 * 沿用可能属于别的 tab 的快照，比直接失败危险得多。
 */
export async function resolveTargetTab(opts: {
  port: number;
  session: string;
  tab?: number;
}): Promise<number> {
  if (typeof opts.tab === "number") return opts.tab;
  const current = await resolveSessionCurrentTab(opts.port, opts.session);
  if (current !== undefined) return current;
  throw new Error(formatCliError({
    code: VtxErrorCode.STALE_SNAPSHOT,
    message:
      "act: cannot determine the session's current tab; refusing to reuse a snapshot that may belong to another tab",
    hint:
      "Run `vortex observe` again to bind a fresh snapshot to the current tab, " +
      "or pass --tab <id> to target a tab explicitly.",
    recoverable: true,
  }));
}
