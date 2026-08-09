/**
 * Author: qingwa
 * Description: Derives a human readable browser name for hub assignment.
 */
export interface BrowserLabelSource {
  brands?: readonly { brand: string; version?: string }[];
  userAgent: string;
}

const PLACEHOLDER = /not[\W_]*a[\W_]*brand/i;

export function detectBrowserLabel(source: BrowserLabelSource): string {
  const real = source.brands?.find(
    (item) => !PLACEHOLDER.test(item.brand) && item.brand !== "Chromium",
  );
  if (real) return real.brand;
  if (source.userAgent.includes("Edg/")) return "Microsoft Edge";
  if (source.userAgent.includes("OPR/")) return "Opera";
  if (source.userAgent.includes("Chrome/")) return "Google Chrome";
  return "Chromium";
}
