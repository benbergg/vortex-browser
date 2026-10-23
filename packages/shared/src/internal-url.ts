/**
 * Author: qingwa
 * Description: Browser-internal page URL rule shared by hub and cli.
 *
 * 内容脚本注入不进浏览器的内部页（chrome:// / devtools:// 等），所以这些 tab
 * 不能当工作 tab 用：认领了也注不进去，请求会静默失败。
 *
 * **为什么放在 shared**：hub（路由层）与 cli（自己解析目标 tab 的那条路）都必须用
 * **同一个**判定，否则两端口径不一致 —— hub 排除了内部页、cli 却把它当目标发出去。
 * shared 无依赖，hub 与 cli 本来就都依赖它 ⇒ 不新增任何依赖。
 */

// 内容脚本注入不进这些方案；edge 系由 install --all-channels 纳入后同样会撞上
export const INTERNAL_SCHEMES = [
  "chrome",
  "chrome-untrusted",
  "chrome-devtools",
  "devtools",
  "edge",
] as const;

/**
 * 判断一个 URL 是不是浏览器内部页（不能当工作 tab）。
 *
 * 非字符串一律当作「不是内部页」—— tab.list 的 url 字段可能缺失，
 * 缺失不等于内部页，不该因此把可用的普通 tab 也排掉。
 */
export function isInternalUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const normalized = url.trim().toLowerCase();
  return INTERNAL_SCHEMES.some((scheme) => normalized.startsWith(`${scheme}://`));
}
