import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import {
  TERMINAL_ADAPTERS,
  collectTerminalLines,
  cleanTerminalLine,
  selectTerminal,
  serializeTerminalLines,
  splitCommandOutput,
  type TerminalProbe,
} from "../src/lib/terminal-readback.js";

/**
 * 终端逻辑行读回单测(2026-11-02 聚石塔远程登录 Web 终端 dogfood)。
 * xterm 把每行补齐到终端列宽 → innerText 被尾随空格淹没,必须逐行读 .xterm-rows。
 * 本组只测纯逻辑(选择器优先级 / 去尾空白 / 页面文本剔除 / 命令-输出切分);
 * 采集函数用 JSDOM 最小 xterm fixture 真跑,不 mock 内部。
 */

function emptyProbe(): TerminalProbe {
  return {
    xterm: { lines: [], containerText: "" },
    monaco: { lines: [], containerText: "" },
    codemirror: { lines: [], containerText: "" },
  };
}

describe("cleanTerminalLine", () => {
  it("去行尾补齐空白,保留前导缩进与行内空格", () => {
    expect(cleanTerminalLine("root@host:/tmp# ls -la      ")).toBe("root@host:/tmp# ls -la");
    expect(cleanTerminalLine("    indented output   ")).toBe("    indented output");
    expect(cleanTerminalLine("a  b")).toBe("a  b");
  });

  it("纯空白行清洗成空串", () => {
    expect(cleanTerminalLine("      ")).toBe("");
    expect(cleanTerminalLine("")).toBe("");
  });

  it("xterm 的 NBSP 补齐空白与行内空格：行尾补齐去掉，行内空格还原成普通空格", () => {
    // xterm.js 把空格渲染成 &nbsp;(U+00A0)，并把每行补齐到列宽 —— 真机实测
    // 「远程登录」Web 终端的行尾补齐就是 NBSP，只按 [ \t] 洗不掉。
    expect(cleanTerminalLine("root@host:/tmp#\u00a0\u00a0\u00a0\u00a0")).toBe("root@host:/tmp#");
    expect(cleanTerminalLine("ls\u00a0-la\u00a0\u00a0")).toBe("ls -la");
    expect(cleanTerminalLine("\u00a0\u00a0\u00a0")).toBe("");
  });
});

describe("selectTerminal", () => {
  it("优先级 xterm > monaco > codemirror", () => {
    const probe = emptyProbe();
    probe.xterm.lines = ["a"];
    probe.monaco.lines = ["b"];
    probe.codemirror.lines = ["c"];
    expect(selectTerminal(probe)?.adapter).toBe("xterm");

    const noXterm = emptyProbe();
    noXterm.monaco.lines = ["b"];
    noXterm.codemirror.lines = ["c"];
    expect(selectTerminal(noXterm)?.adapter).toBe("monaco");

    const onlyCm = emptyProbe();
    onlyCm.codemirror.lines = ["c"];
    expect(selectTerminal(onlyCm)?.adapter).toBe("codemirror");
  });

  it("没有终端控件返回 null", () => {
    expect(selectTerminal(emptyProbe())).toBeNull();
  });

  it("全空行的控件不算命中,继续看下一个控件", () => {
    const probe = emptyProbe();
    probe.xterm.lines = ["   ", ""];
    probe.codemirror.lines = ["real"];
    expect(selectTerminal(probe)?.adapter).toBe("codemirror");
  });

  it("清洗行并去尾部空行", () => {
    const probe = emptyProbe();
    probe.xterm.lines = ["root@host:/tmp# ls   ", "", "  ", ""];
    const t = selectTerminal(probe);
    expect(t?.lines).toEqual(["root@host:/tmp# ls"]);
  });
});

describe("serializeTerminalLines", () => {
  it("按行 join", () => {
    expect(serializeTerminalLines(["a", "b"])).toBe("a\nb");
    expect(serializeTerminalLines([])).toBe("");
  });
});

describe("splitCommandOutput", () => {
  it("按提示符切分 {prompt, command, output}", () => {
    const lines = [
      "root@host:/tmp# uname -a",
      "Linux host 5.10",
      "root@host:/tmp# df -h",
      "Filesystem Size",
    ];
    const segs = splitCommandOutput(lines);
    expect(segs).toHaveLength(2);
    expect(segs[0].prompt).toBe("root@host:/tmp#");
    expect(segs[0].command).toBe("uname -a");
    expect(segs[0].output).toEqual(["Linux host 5.10"]);
    expect(segs[1].command).toBe("df -h");
    expect(segs[1].output).toEqual(["Filesystem Size"]);
  });

  it("认得 ~$ 结尾的提示符与 $ 单独提示符", () => {
    expect(splitCommandOutput(["user@host:~$ ls -l"])[0].prompt).toBe("user@host:~$");
    expect(splitCommandOutput(["$ ls -l"])[0].prompt).toBe("$");
  });

  it("缩进行与普通输出不当提示符", () => {
    const segs = splitCommandOutput(["  indented line", "plain output"]);
    expect(segs).toHaveLength(1);
    expect(segs[0].prompt).toBe("");
    expect(segs[0].output).toEqual(["  indented line", "plain output"]);
  });

  it("提示符行前的内容归入前导段,不丢行", () => {
    const segs = splitCommandOutput(["boot log", "root@host:/tmp# ls"]);
    expect(segs).toHaveLength(2);
    expect(segs[0].output).toEqual(["boot log"]);
    expect(segs[1].command).toBe("ls");
  });
});

describe("collectTerminalLines(JSDOM 最小 xterm fixture)", () => {
  beforeEach(() => {
    const dom = new JSDOM(
      `<body><div class="xterm-rows"><div>root@host:/tmp# ls   </div><div>total 0        </div></div></body>`,
    );
    globalThis.document = dom.window.document as unknown as Document;
    globalThis.window = dom.window as any;
  });

  it("采到 xterm 行且选择器来自同一份常量", () => {
    const probe = collectTerminalLines(TERMINAL_ADAPTERS, null);
    expect(probe.xterm.lines).toHaveLength(2);
    expect(probe.xterm.lines[0]).toContain("root@host");
    const t = selectTerminal(probe)!;
    expect(t.adapter).toBe("xterm");
    expect(t.lines).toEqual(["root@host:/tmp# ls", "total 0"]);
  });

  it("跳过隐藏终端和隐藏行，选择后续可见终端", () => {
    document.body.innerHTML = '<section hidden><div class="xterm-rows"><div>SECRET</div></div></section><div class="xterm-rows"><div>VISIBLE<span hidden>INLINE_SECRET</span></div><div hidden>HIDDEN</div></div>';
    const probe = collectTerminalLines(TERMINAL_ADAPTERS, null);
    expect(probe.xterm.lines).toEqual(["VISIBLE"]);
  });

  it("页面没有终端时各控件均为空", () => {
    const dom = new JSDOM(`<body><div>plain</div></body>`);
    globalThis.document = dom.window.document as unknown as Document;
    globalThis.window = dom.window as any;
    const probe = collectTerminalLines(TERMINAL_ADAPTERS, null);
    expect(selectTerminal(probe)).toBeNull();
  });
});
