/**
 * Author: qingwa
 * Description: CLI 测试用的假传输层：按 action 分发响应，tab.list 单独处理。
 *
 * 为什么需要它（定向修复轮 Important ①）：
 * CLI 现在会读一次 **session 当前 tab**（tab.list）来把快照按**实际 tab 身份**绑定与校验，
 * 所以假传输层必须像 hub 一样回答 tab.list —— 它返回的 `current: true` 标注就是
 * 「这次不带 tab 的请求真正会落到的那个 tab」。
 */

/** 一次动作请求的回复。 */
export interface FakeReply {
  /** 成功时的 result。 */
  result?: unknown;
  /** 失败时的错误（抛出去，模拟服务端报错）。 */
  error?: Error;
}

/** 假传输层的句柄。 */
export interface FakeHub {
  /** 排一个回复（按调用顺序消费）。 */
  reply(reply: FakeReply): void;
  /** 排一个成功回复。 */
  ok(result: unknown): void;
  /** 排一个失败回复。 */
  fail(error: Error): void;
  /** 已收到的**动作**请求（不含 tab.list 这种只读查询）。 */
  actionCalls(): Array<[string, Record<string, unknown>, { tabId?: number }]>;
  /** 已收到的全部请求（含 tab.list）。 */
  allCalls(): unknown[][];
  /** 改掉 session 当前 tab（模拟同 session 切了 tab）。 */
  setCurrentTab(tabId: number | null): void;
}

/** 假传输层里 session 当前 tab 的 id。 */
export const FAKE_CURRENT_TAB = 11;

/**
 * 安装假传输层：mock 的 sendRequest 按 action 分发。
 *
 * - `tab.list` → 返回带 `current` 标注的 tab 列表（口径与 hub 的 annotateTabList 一致）；
 * - 其他 action → 消费排好的回复，没排就回 `{ ok: true }`。
 */
export function installFakeHub(sendRequestMock: (action: string, ...rest: unknown[]) => unknown): FakeHub {
  const replies: FakeReply[] = [];
  let currentTabId: number | null = FAKE_CURRENT_TAB;
  const tabs = [
    { id: FAKE_CURRENT_TAB, active: true, lastFocused: true },
    { id: 12, active: false, lastFocused: false },
  ];

  sendRequestMock.mockImplementation(async (action: string, ...rest: unknown[]) => {
    if (action === "tab.list") {
      return {
        action,
        id: "cli-tab-list",
        result: tabs.map((tab) => ({ ...tab, current: tab.id === currentTabId })),
      };
    }
    const next = replies.shift();
    if (next?.error) throw next.error;
    return { action, id: "cli-action", result: next?.result ?? { ok: true } };
  });

  return {
    reply: (reply: FakeReply) => {
      replies.push(reply);
    },
    ok: (result: unknown) => {
      replies.push({ result });
    },
    fail: (error: Error) => {
      replies.push({ error });
    },
    actionCalls: () =>
      sendRequestMock.mock.calls.filter((call) => call[0] !== "tab.list") as Array<
        [string, Record<string, unknown>, { tabId?: number }]
      >,
    allCalls: () => sendRequestMock.mock.calls as unknown[][],
    setCurrentTab: (tabId: number | null) => {
      currentTabId = tabId;
    },
  };
}
