// packages/extension/src/lib/empty-diagnosis.ts
//
// debug_read 返回空时的自陈。纯函数,只吃 handler 本地已有的计数,不额外探测。
//
// 面向调用方(LLM)所以用英文,与 VtxError 的 hint 一致。每条自陈都必须回答
// 「下一步做什么」——只说"没有结果"等于没说,基线里模型正是在这种情况下
// 反复微调无关参数重试。

/** pattern 是 url.includes() 子串;含这些写法说明调用方当成正则了 */
const REGEX_ISH = /[|*+?^$\\]|\.\*|\[[^\]]*\]|\([^)]*\)|\{\d/;

export interface ConsoleEmptyFacts {
  /** 本次调用才 attach —— 此前的日志从未进过缓冲区 */
  justSubscribed: boolean;
  /** 任何过滤之前的缓冲条数 */
  buffered: number;
  level?: string;
  limit?: number;
}

export interface NetworkEmptyFacts {
  justSubscribed: boolean;
  buffered: number;
  /** includeResources=false 时只留 XHR/Fetch 之后 */
  afterTypeFilter: number;
  afterPattern: number;
  afterStatus: number;
  includeResources: boolean;
  pattern?: string;
  statusMin?: number;
  statusMax?: number;
  limit?: number;
}

export interface QueryScanFacts {
  shadowRoots: number;
  /** 同页 iframe 数。executeScript 不带 frameIds 只跑顶层 frame,这些没被搜到 */
  iframes: number;
  /** 调用方已显式指定 frameId,不必再劝 */
  frameScoped: boolean;
}

export interface QueryTextEmptyFacts extends QueryScanFacts {
  chars: number;
  nodes: number;
  pattern: string;
  isRegex: boolean;
}

export interface QueryCssEmptyFacts extends QueryScanFacts {
  elements: number;
  selector: string;
}

function iframeNote(f: QueryScanFacts): string | null {
  if (f.frameScoped || f.iframes <= 0) return null;
  return `${f.iframes} same-page iframe(s) were NOT searched — query runs in one frame at a time. ` +
    "Call vortex_observe to list frames, then pass frameId.";
}

export function diagnoseEmptyQueryText(f: QueryTextEmptyFacts): string {
  const parts: string[] = [];
  if (f.chars === 0) {
    parts.push("No visible text was collected under document.body — this frame is blank or its content is elsewhere.");
  } else {
    parts.push(
      `Scanned ${f.chars} chars across ${f.nodes} visible text node(s)` +
        (f.shadowRoots > 0 ? ` and ${f.shadowRoots} open shadow root(s)` : "") + ".",
    );
  }
  // pattern 被转义成字面量:基线里传 `a|b|c` 而不设 isRegex 的写法反复出现
  if (!f.isRegex && REGEX_ISH.test(f.pattern)) {
    parts.push(
      "The pattern contains regex syntax but isRegex is not set, so it was escaped and matched literally. " +
        "Pass isRegex:true to use '|' as alternation.",
    );
  }
  const iframes = iframeNote(f);
  if (iframes) parts.push(iframes);
  if (f.chars > 0 && !iframes) {
    parts.push("Out of scope: hidden text (display:none / visibility:hidden) and closed shadow DOM.");
  }
  return parts.join(" ");
}

export function diagnoseEmptyQueryCss(f: QueryCssEmptyFacts): string {
  const parts = [
    `Scanned ${f.elements} element(s) across ${f.shadowRoots} open shadow root(s); ` +
      `nothing matched '${f.selector}'.`,
  ];
  const iframes = iframeNote(f);
  if (iframes) parts.push(iframes);
  else parts.push("Out of scope: closed shadow DOM.");
  return parts.join(" ");
}

export function diagnoseEmptyConsole(f: ConsoleEmptyFacts): string {
  if (f.limit === 0) {
    return `tail=0 asks for zero entries; ${f.buffered} message(s) are buffered. Pass a positive tail.`;
  }
  if (f.buffered === 0) {
    return f.justSubscribed
      ? "Console capture for this tab started with this call — messages logged before it were never recorded. " +
        "Reproduce the action (or reload the tab), then read again."
      : "Console buffer for this tab is empty: nothing has been logged since capture started. " +
        "This is a real 'no messages', not a filter miss — widening filter.level will not help.";
  }
  const level = f.level && f.level !== "all" ? f.level : null;
  if (level) {
    return `${f.buffered} message(s) buffered but none at level='${level}'. ` +
      "Drop filter.level (or use 'all') to see them.";
  }
  return `${f.buffered} message(s) buffered yet none returned — filters removed all of them.`;
}

export function diagnoseEmptyNetwork(f: NetworkEmptyFacts): string {
  if (f.buffered === 0) {
    return f.justSubscribed
      ? "Network capture for this tab started with this call — requests that finished earlier were only " +
        "recoverable as Resource Timing summaries, and none were found. Reproduce the request (or reload the tab), " +
        "then read again."
      : "No requests recorded for this tab at all. Reproduce the request, then read again.";
  }
  if (f.afterTypeFilter === 0) {
    return `${f.buffered} request(s) recorded, but all of them are static resources (img/css/script/font). ` +
      "Pass includeResources:true to see them.";
  }
  if (f.afterPattern === 0 && f.pattern) {
    // 基线里 8/10 次 network 空返回都传了 `a|b|c` 或 `.*` —— 当成正则用了
    const regexNote = REGEX_ISH.test(f.pattern)
      ? " It is matched as a plain substring, not a regex: '|', '.*' and friends match literally. " +
        "Pass one URL fragment instead, and read again per fragment."
      : " Matching is plain substring (case-sensitive); try a shorter fragment.";
    return `${f.afterTypeFilter} API request(s) recorded, none whose URL contains '${f.pattern}'.${regexNote}`;
  }
  if (f.afterStatus === 0) {
    const range = [
      f.statusMin != null ? `statusMin=${f.statusMin}` : null,
      f.statusMax != null ? `statusMax=${f.statusMax}` : null,
    ].filter(Boolean).join(" / ");
    return `${f.afterPattern} request(s) matched the pattern but none passed ${range || "the status filter"} ` +
      "(entries without a status, e.g. Resource Timing summaries, are excluded when a status bound is set). " +
      "Drop the status bounds to see them.";
  }
  if (f.limit === 0) {
    return `tail=0 asks for zero entries; ${f.afterStatus} request(s) matched. Pass a positive tail.`;
  }
  return `${f.buffered} request(s) recorded yet none returned — filters removed all of them.`;
}
