// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * PrimeIcons 图标字体取名(primevue.org dogfood 2026-06-22)。
 *
 * 现象:PrimeVue/PrimeReact 顶栏图标链接/按钮 `<a><i class="pi pi-github"></i></a>`、
 * `<button><i class="pi pi-cog"></i></button>` 无 aria-label/title/text → observe 报
 * `link ""` / `button ""` 全无名,agent 完全不知是 GitHub 链接 / 设置按钮。
 *
 * 根因:既有 iconFontName(display-path 末位兜底,2026-06-03 AP)① 前缀表无 `pi-`;
 * ② 只读 el 自身 className,而 PrimeVue 把图标字体类放在**子 `<i>`**。
 *
 * 修复:① ICON_FONT_PREFIXES 加 `pi-`、ICON_FONT_MODIFIERS 加 pi-spin/pi-pulse/pi-fw;
 * ② iconFontName 先查 el 自身 class,再回退到内部图标元素(i/span)的 class。
 * 仍只在 display-path 末位(不进 gate,守 round-12)。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

// 复刻内联逻辑(纯函数,验证提取行为;内联副本由源码锁保证一致)。
const ICON_FONT_PREFIXES = ["bi-", "fa-", "glyphicon-", "vxe-icon-", "van-icon-", "pi-"];
const ICON_FONT_MODIFIERS = new Set(["fa-solid", "fa-regular", "fa-brands", "pi-spin", "pi-pulse", "pi-fw"]);
function fromClassStr(cls: string): string {
  const tokens = cls.split(/\s+/).filter(Boolean);
  for (const c of tokens) {
    const lower = c.toLowerCase();
    if (ICON_FONT_MODIFIERS.has(lower)) continue;
    for (const p of ICON_FONT_PREFIXES) {
      if (lower.startsWith(p) && lower.length > p.length) return c.slice(p.length).replace(/-/g, " ");
    }
  }
  return "";
}
function iconFontName(el: Element): string {
  const own = fromClassStr(typeof el.className === "string" ? el.className : "");
  if (own) return own;
  for (const innerIcon of el.querySelectorAll("i[class], span[class]")) {
    if (innerIcon === el) continue;
    const n = fromClassStr(typeof innerIcon.className === "string" ? innerIcon.className : "");
    if (n) return n;
  }
  return "";
}
function makeEl(html: string): Element {
  const d = document.implementation.createHTMLDocument("t");
  d.body.innerHTML = html;
  return d.body.firstElementChild!;
}

describe("iconFontName — PrimeIcons 子 <i> 字体图标取名(2026-06-22 primevue dogfood)", () => {
  it("<a><i class='pi pi-github'> → 'github'", () => {
    expect(iconFontName(makeEl('<a><i class="pi pi-github"></i></a>'))).toBe("github");
  });
  it("<button><i class='pi pi-cog z-10'> → 'cog'(设置按钮)", () => {
    expect(iconFontName(makeEl('<button><i class="pi pi-cog z-10"></i></button>'))).toBe("cog");
  });
  it("连字符图标名 pi-chevron-down → 'chevron down'", () => {
    expect(iconFontName(makeEl('<button><i class="pi pi-chevron-down"></i></button>'))).toBe("chevron down");
  });
  it("跳过动画修饰 pi-spin,取真图标 pi-spinner", () => {
    expect(iconFontName(makeEl('<button><i class="pi pi-spin pi-spinner"></i></button>'))).toBe("spinner");
  });
  it("跳过 pi-fw 定宽修饰,取真图标 pi-trash", () => {
    expect(iconFontName(makeEl('<button><i class="pi pi-fw pi-trash"></i></button>'))).toBe("trash");
  });
  it("el 自身带图标类仍优先(Bootstrap `<button class='bi bi-gear'>`)", () => {
    expect(iconFontName(makeEl('<button class="bi bi-gear"></button>'))).toBe("gear");
  });
  it("图标 <i> 排在装饰 span 之后仍命中(PrimeVue cog 按钮:animate-spin span 在前)", () => {
    const html = '<button><span class="absolute animate-spin"></span><span class="bg-surface-0"></span><i class="pi pi-cog z-10"></i></button>';
    expect(iconFontName(makeEl(html))).toBe("cog");
  });
  it("无图标字体(普通装饰 i)→ 空(不误伤)", () => {
    expect(iconFontName(makeEl('<button><i class="some-deco"></i></button>'))).toBe("");
  });
  it("子串 api- 不误命中(前缀 pi- 须 token 起始)", () => {
    expect(iconFontName(makeEl('<button><span class="api-btn"></span></button>'))).toBe("");
  });
});

describe("observe.ts 内联 iconFontName 源码锁", () => {
  it("ICON_FONT_PREFIXES 含 pi-、ICON_FONT_MODIFIERS 含 pi 修饰", () => {
    expect(OBSERVE_SRC).toMatch(/ICON_FONT_PREFIXES\s*=\s*\[[^\]]*"pi-"/);
    expect(OBSERVE_SRC).toMatch(/"pi-spin",\s*"pi-pulse",\s*"pi-fw"/);
  });
  it("iconFontName 先 el 自身、再遍历全部内部图标元素 i/span 的 class", () => {
    expect(OBSERVE_SRC).toMatch(/function iconFontNameFromClassStr\(cls: string\)/);
    expect(OBSERVE_SRC).toContain('el.querySelectorAll("i[class], span[class]")');
  });
});
