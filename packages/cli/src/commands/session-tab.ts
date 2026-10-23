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
  /** 扩展标注：这个 tab 是不是活动 tab。 */
  active?: unknown;
  /** 扩展标注：这个 tab 是不是最后拿到焦点的 tab。 */
  lastFocused?: unknown;
  /** hub 标注：self | other | none（相对请求方 session 的归属）。 */
  owner?: unknown;
}

/**
 * 读出该 session 的当前 tab id；判不出来返回 undefined。
 *
 * 只读 tab.list（tabless action）：它不会改动 session 的 tab 归属，
 * 所以**请求发出前**读它不会影响这次请求落到哪个 tab 上。
 *
 * 口径 = hub 对不带 tabId 的请求的路由依据（session.currentTabId），
 * 所以这里读回来的就是那次请求真正会落到的 tab。
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
 * 读一次 tab.list；读不到就抛原始错误（调用方渲染成可读错误）。
 *
 * 注意：tab.list 是 tabless action，它不会改动 session 的 tab 归属，
 * 所以**请求发出前**读它不会影响这次请求落到哪个 tab 上。
 */
async function listSessionTabs(port: number, session: string): Promise<TabRecord[]> {
  const resp = await sendRequest("tab.list", {}, { port, session });
  const result = resp.result;
  if (!Array.isArray(result)) return [];
  return result.filter(
    (tab): tab is TabRecord => Boolean(tab) && typeof tab === "object",
  );
}

/**
 * 解析一次 observe 请求**发出前**要绑定的 tab 身份。
 *
 * **为什么必须提前解析**（定向修复轮 Important ① 的并发竞态）：
 * 「先发请求、后查 tab」有竞态 —— observe A 的请求执行期间（或响应回来之后、
 * 查 tab 之前），同 session 的另一个请求把 current tab 切到 B，
 * A 的快照就会被登记到 B 上（快照属于 B，ref 却来自 A）。
 * 所以这里**先**解析出目标 tab，调用方拿**同一个**身份做两件事：
 * ① 请求参数里的显式 tabId（请求确定落在那个 tab 上）；
 * ② 快照登记的 tab 槽位（登记的就是请求真正观察的那个 tab）。
 * 两者同源 ⇒ 不存在「事后推断」。
 *
 * **解析口径与 hub 一致**（packages/hub/src/tab-ownership.ts 的 ensureCurrentTab）：
 * - session 已有当前 tab（hub 在 tab.list 里标的 current）⇒ 就是它；
 * - session 还没有当前 tab ⇒ hub 会认领一个没人认领的 tab（lastFocused+active 优先，
 *   其次 active，最后任意无人认领的），这里照同一口径挑同一个，
 *   免得请求落在别的 tab 上、快照也登记到别的 tab 上。
 *
 * 判不出来就抛可读错误：**宁可拒绝，也不猜**——猜错等于把快照登记到别的 tab 上。
 */
export async function resolveObserveTargetTab(opts: {
  port: number;
  session: string;
  tab?: number;
}): Promise<number> {
  // 显式 --tab：就是它，不额外问服务端（与既有行为一致）。
  if (typeof opts.tab === "number") return opts.tab;

  const tabs = await listSessionTabs(opts.port, opts.session);

  // session 的当前 tab（别的 session 抢走了就不算：hub 也不会再用它）。
  const current = tabs.find(
    (tab) => tab.current === true && typeof tab.id === "number" && tab.owner !== "other",
  );
  if (current && typeof current.id === "number") return current.id;

  // session 还没有当前 tab：按 hub 的口径挑一个（lastFocused+active 优先、其次 active）。
  // 只认「没人认领的」tab：别的 session 认领的 tab 不碰（hub 也不会去认领它）。
  const candidates = tabs.filter(
    (tab) => typeof tab.id === "number" && (tab.owner === "none" || tab.owner === undefined),
  );
  const picked = candidates.find((tab) => tab.active === true && tab.lastFocused === true)
    ?? candidates.find((tab) => tab.active === true)
    ?? candidates[0];
  if (picked && typeof picked.id === "number") return picked.id;

  throw new Error(formatCliError({
    code: VtxErrorCode.STALE_SNAPSHOT,
    message:
      "observe: cannot determine the session's current tab; refusing to take a snapshot that cannot be bound to a tab",
    hint:
      "Open or activate a tab for this session and run `vortex observe` again, " +
      "or pass --tab <id> to target a tab explicitly.",
    recoverable: true,
  }));
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
