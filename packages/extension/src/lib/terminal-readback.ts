/**
 * 终端 / 虚拟化文本控件的逻辑行读回(纯逻辑,host 侧执行)。
 *
 * 背景(2026-11-02 聚石塔「远程登录」Web 终端 dogfood):xterm 把每一行补齐到终端
 * 列宽,innerText/textContent 于是被大量尾随空格淹没,正则 grep 命中的是补齐后的
 * 行;逐行读 .xterm-rows 才能拿到干净行。Monaco(.view-line)/CodeMirror(.cm-line)
 * 同属「非表格 DOM 文本」家族,行元素本身即真实文本,只是被虚拟化(只渲染视口内行)。
 *
 * 分工:DOM 采集在页面侧(collectTerminalLines,可注入),选择/清洗/序列化/命令-输出
 * 切分在 host 侧(本模块纯函数)。选择器只有一份(TERMINAL_ADAPTERS),页面侧与
 * host 侧共用,避免"两处各写一份选择器"的分叉。
 */

/** 各终端控件的容器选择器与行元素选择器(页面侧采集用)。 */
export const TERMINAL_ADAPTERS = {
  xterm: { container: ".xterm-rows", line: ".xterm-rows > *" },
  monaco: { container: ".view-lines", line: ".view-lines .view-line" },
  codemirror: { container: ".cm-content", line: ".cm-line" },
} as const;

export type TerminalAdapterName = keyof typeof TERMINAL_ADAPTERS;
export type TerminalAdapterSpec = { container: string; line: string };

export interface TerminalBucket {
  /** 行元素的原始文本(未清洗),页面侧 textContent。 */
  lines: string[];
  /** 容器可见文本(用于把终端行从页面文本里剔掉)。 */
  containerText: string;
}

export type TerminalProbe = Record<TerminalAdapterName, TerminalBucket>;

export interface TerminalReadback {
  adapter: TerminalAdapterName;
  /** 清洗后的逻辑行(去行尾补齐空白 + 去尾部空行)。 */
  lines: string[];
  containerText: string;
}

/** 命令-输出成对结果:一段提示符 + 其命令 + 该命令的输出行。 */
export interface TerminalSegment {
  prompt: string;
  command: string;
  output: string[];
}

/**
 * 页面侧采集函数(注入执行)。
 *
 * 注入丢模块作用域 → 函数体只能依赖入参,不得引用本模块其它导出;选择器经 args 传入。
 * 返回各控件的原始行;host 侧再决定用哪个控件、怎么清洗。
 */
export function collectTerminalLines(
  sels: Record<string, TerminalAdapterSpec>,
  rootSelector: string | null,
): TerminalProbe {
  const out: Record<string, TerminalBucket> = {};
  const root: Element | null = rootSelector
    ? ((window as any).__vortexDomResolve?.queryDeep?.(rootSelector) as Element | null) ??
      document.querySelector(rootSelector)
    : document.body;
  for (const name of Object.keys(sels)) {
    const s = sels[name];
    const bucket: TerminalBucket = { lines: [], containerText: "" };
    out[name] = bucket;
    if (!root) continue;
    const isHidden = (el: Element): boolean => {
      for (let current: Element | null = el; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if ((current as HTMLElement).hidden || style.display === "none" || style.visibility === "hidden") return true;
      }
      return false;
    };
    // 目标本身可能就是容器（root 就是 .xterm-rows 元素）——querySelectorAll 只看后代，
    // 根自身要单独认，否则直接查不到容器、读回空。
    const container = root.matches(s.container)
      ? isHidden(root) ? undefined : root
      : Array.from(root.querySelectorAll(s.container)).find(el => !isHidden(el));
    if (!container) continue;
    const visibleText = (node: Node): string => {
      if (node.nodeType === 3) return node.textContent ?? "";
      if (node.nodeType !== 1 || isHidden(node as Element)) return "";
      return Array.from(node.childNodes).map(visibleText).join("");
    };
    const rows = Array.from(container.querySelectorAll(s.line)).filter(row => !isHidden(row));
    bucket.lines = rows.map(row => (row as HTMLElement).innerText ?? visibleText(row));
    bucket.containerText = bucket.lines.join("\n");
  }
  return out as unknown as TerminalProbe;
}

/**
 * 去行尾补齐空白(xterm 把每行补到列宽);保留前导缩进与行内空格。
 *
 * xterm.js 渲染时把空格写成 &nbsp;(U+00A0),行尾补齐也是 NBSP —— 真机实测
 * 「远程登录」Web 终端的行尾就是 NBSP,只按 [ \t] 洗不掉。所以先把 NBSP 还原成
 * 普通空格,再去行尾空白。
 */
export function cleanTerminalLine(raw: string): string {
  return raw.replace(/\u00a0/g, " ").replace(/[ \t]+$/, "");
}

/**
 * 选出要读回的终端控件:优先级 xterm > monaco > codemirror(真实终端优先)。
 * 命中的控件行全为空 → 不算命中,继续看下一个。
 */
export function selectTerminal(probe: TerminalProbe | undefined): TerminalReadback | null {
  if (!probe) return null;
  for (const name of ["xterm", "monaco", "codemirror"] as TerminalAdapterName[]) {
    const bucket = probe[name];
    if (!bucket || bucket.lines.length === 0) continue;
    const lines = bucket.lines.map(cleanTerminalLine);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) continue;
    return { adapter: name, lines, containerText: bucket.containerText ?? "" };
  }
  return null;
}

/** 逻辑行序列化成文本。 */
export function serializeTerminalLines(lines: string[]): string {
  return lines.join("\n");
}

/**
 * 提示符切分:一行是否是 shell 提示符行。
 * 判据(启发式,注释即契约):
 * - 行首无空白(缩进行是输出)
 * - 首 token 含 '@' 或 ':' 且以 # $ ~ % > 之一结尾(如 root@host:/tmp#、user@host:~$)
 * - 或首 token 本身就是提示符字符($ # % >)
 * 已知不判为提示符:bash: xxx(以 ':' 结尾)、URL、纯日志行。
 */
function splitPrompt(line: string): { prompt: string; command: string } | null {
  if (/^\s/.test(line)) return null;
  const m = line.match(/^(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  const token = m[1];
  const isBarePrompt = /^[#$%>~]+$/.test(token);
  const looksLikePrompt =
    (token.includes("@") || token.includes(":")) && /[#$~%>]$/.test(token);
  if (!isBarePrompt && !looksLikePrompt) return null;
  return { prompt: token, command: m[2] ?? "" };
}

/**
 * 按提示符把行切成 {prompt, command, output} 段。
 * 提示符之前的行归入前导段(prompt 为空串),不丢行。
 */
export function splitCommandOutput(lines: string[]): TerminalSegment[] {
  const segments: TerminalSegment[] = [];
  const preamble: string[] = [];
  let current: TerminalSegment | null = null;
  for (const line of lines) {
    const parsed = splitPrompt(line);
    if (parsed) {
      if (current) segments.push(current);
      current = { prompt: parsed.prompt, command: parsed.command, output: [] };
      continue;
    }
    if (current) current.output.push(line);
    else preamble.push(line);
  }
  if (current) segments.push(current);
  if (preamble.length > 0) {
    segments.unshift({ prompt: "", command: "", output: preamble });
  }
  return segments;
}
