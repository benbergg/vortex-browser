/**
 * Author: qingwa
 * Description: Which CDP domains actually have an enable command.
 */

import { VtxErrorCode, vtxError } from "@vortex-browser/shared";

// 发 `${domain}.enable` 给没有这条命令的域,真机报 -32601 'X.enable' wasn't found。
// Emulation 就这么让高 DPR 截图坏了很久 —— 而单测里的假 DebuggerManager 把任意
// `.enable` 一律 resolve,危险路径在测试里变安全,一路假绿。
//
// 白名单只收本仓库确认在用且确认存在 enable 的域。**不要凭印象往里加**:
// 加错一个,守卫就放行一条注定 -32601 的调用,等于白做。新增前查 CDP 协议文档。
export const DOMAINS_WITH_ENABLE: ReadonlySet<string> = new Set([
  "Accessibility",
  "CSS",
  "DOM",
  "Network",
  "Page",
  "Runtime",
]);

/** 没有 enable 的域(如 Emulation / Input / DOMDebugger)只需 attach 后直接发命令 */
export function assertEnableable(domain: string): void {
  if (DOMAINS_WITH_ENABLE.has(domain)) return;
  throw vtxError(
    VtxErrorCode.INTERNAL_ERROR,
    `CDP domain "${domain}" has no enable command (sending it yields -32601). ` +
      `If commands on this domain only need a debugger session, call attach() instead. ` +
      `If the domain really does have enable, verify against the CDP protocol and add it to DOMAINS_WITH_ENABLE.`,
    { extras: { domain } },
  );
}
