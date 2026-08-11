/**
 * Author: qingwa
 * Description: Extracts literal domain arguments passed to enableDomain, for I23.
 */

// 只认字面量。目前 src 里 11 处调用全是字面量,所以没有盲区;真出现动态域名时
// 这里会漏,但运行时守卫(assertEnableable)仍然拦得住。
const CALL = /\.enableDomain\s*\(\s*[^,()]+,\s*["']([A-Za-z]+)["']\s*\)/g;

export function findEnableDomainCalls(source: string): string[] {
  return [...source.matchAll(CALL)].map((m) => m[1]);
}
