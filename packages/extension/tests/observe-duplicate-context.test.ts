// 重名元素的区分上下文(2026-08-11 日志 + live 实证)。
//
// 日志实测:3977 个可寻址元素里 731(18.4%)与同快照内另一元素 role+name 完全相同,
// 且 **90.6% 沿父链 6 跳内找不到任何区分信息**。最典型:log.bytenew.com 一屏
// 三个 `button "复制此行"` 平铺在顶层,日志行内容(唯一能区分它们的东西)因
// filter=interactive 被滤掉,压根不在树里。agent 因此无法判断"该点哪一个",
// 转而在 evaluate 里自己写下标消歧 —— 1441 次 evaluate 中 16.4% 用了
// `[7]` / `[0]` / `length-1` / nth-child。
//
// ref 本来就唯一,缺的不是寻址而是**语义**。故做法是给重名成员补一段
// 「最近的、能把它与同组其他成员区分开的祖先文本」,而不是发序号(序号
// 不比 ref 多给任何信息)。
//
// 纯决策函数:祖先文本由调用方逐跳传入,便于喂真实断言而非 mock DOM。

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pickDistinguishingContext, DUP_CTX_MAX_LEN, ancestorContextText } from "../src/handlers/observe.js";

describe("pickDistinguishingContext", () => {
  // 契约:调用方传入的祖先文本**已剔除交互后代**(页面侧克隆后移除),否则同行的
  // 兄弟按钮名(「删除」)会混进上下文。本函数只负责唯一性判定 + 自身名兜底。
  it("取第一个在同组内唯一的祖先文本", () => {
    // 表格:td 层剔掉两个按钮后为空,tr 层含订单号才唯一
    const mine = ["", "SO-20260811-002 洁婷专卖店"];
    const others = [
      ["", "SO-20260811-001 苏菲官方旗舰店"],
      ["", "SO-20260811-003 七度空间"],
    ];
    expect(pickDistinguishingContext(mine, others, "详情")).toBe("SO-20260811-002 洁婷专卖店");
  });

  it("剔除元素自身的名字,只留区分性内容", () => {
    const mine = ["13:22:05 WARN retry rate limit 复制此行"];
    const others = [["13:22:01 ERROR order not found 复制此行"]];
    expect(pickDistinguishingContext(mine, others, "复制此行")).toBe("13:22:05 WARN retry rate limit");
  });

  it("所有跳都无法区分 → undefined(不发误导性上下文)", () => {
    const mine = ["详情", "操作栏 详情"];
    const others = [["详情", "操作栏 详情"], ["详情", "操作栏 详情"]];
    expect(pickDistinguishingContext(mine, others, "详情")).toBeUndefined();
  });

  it("空祖先文本跳过,继续往上找", () => {
    const mine = ["", "  ", "订单 A"];
    const others = [["", "", "订单 B"]];
    expect(pickDistinguishingContext(mine, others, "详情")).toBe("订单 A");
  });

  it("截断到上限,防止长行撑爆 observe 输出", () => {
    const mine = ["X".repeat(300)];
    const others = [["Y".repeat(300)]];
    const out = pickDistinguishingContext(mine, others, "详情");
    expect(out).toHaveLength(DUP_CTX_MAX_LEN);
  });

  it("归一化空白:换行/多空格折叠为单空格", () => {
    const mine = ["订单\n  A\t号"];
    const others = [["订单 B 号"]];
    expect(pickDistinguishingContext(mine, others, "详情")).toBe("订单 A 号");
  });

  it("剔名字后为空 → 该跳不算区分,继续往上", () => {
    // 第 0 跳唯一但剔掉名字后什么都不剩,给出来没有信息量
    const mine = ["详情", "订单 A 详情"];
    const others = [["详情 详情", "订单 B 详情"]];
    expect(pickDistinguishingContext(mine, others, "详情")).toBe("订单 A");
  });

  it("同组只有自己(无 others)→ undefined,重名判定应在调用方", () => {
    expect(pickDistinguishingContext(["订单 A"], [], "详情")).toBeUndefined();
  });
});

describe("inject func 内联接入(源码锁,改一处须同步)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
    "utf8",
  );

  it("页面侧后置遍历调用了内联副本", () => {
    expect(SRC).toContain("__pickDistinguishingContext(");
  });

  it("上下文计算在 parentIndex 后置遍历之后(依赖 collectedEls 已齐)", () => {
    const idxParent = SRC.indexOf("a11y-tree: 为每个收集元素算最近的已收集祖先");
    const idxCtx = SRC.indexOf("__pickDistinguishingContext(");
    expect(idxParent).toBeGreaterThan(-1);
    expect(idxCtx).toBeGreaterThan(idxParent);
  });
});

// live 实测(2026-08-11)发现:直接取 textContent 会把单元格粘连成
// "SO-20260811-001苏菲官方旗舰店" / "13:22:01ERRORorder not found"。
// agent 要拿这段去对用户的自然语言描述,粘连显著影响可读性与匹配。
describe("ancestorContextText(jsdom 真 DOM)", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    (globalThis as any).document = dom.window.document;
    (globalThis as any).Element = dom.window.Element;
  });
  // <tr> 直接塞进 div.innerHTML 会被 HTML 解析器丢弃,须包进 table 才能建出真节点
  const mk = (html: string): Element => {
    if (html.startsWith("<tr")) {
      const t = document.createElement("table");
      t.innerHTML = `<tbody>${html}</tbody>`;
      return t.querySelector("tr")!;
    }
    const d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild!;
  };

  it("元素边界补空格,单元格不粘连", () => {
    const tr = mk(`<tr><td>SO-20260811-001</td><td>苏菲官方旗舰店</td></tr>`);
    expect(ancestorContextText(tr)).toBe("SO-20260811-001 苏菲官方旗舰店");
  });

  it("剔除交互后代:同行按钮名不进上下文", () => {
    const tr = mk(`<tr><td>SO-002</td><td><button>详情</button><button>删除</button></td></tr>`);
    expect(ancestorContextText(tr)).toBe("SO-002");
  });

  it("日志行:时间/级别/正文分开", () => {
    const row = mk(`<div><span>13:22:01</span><span>ERROR</span><span>order not found</span><button>复制此行</button></div>`);
    expect(ancestorContextText(row)).toBe("13:22:01 ERROR order not found");
  });

  it("纯文本节点原样保留", () => {
    expect(ancestorContextText(mk(`<div>订单 A</div>`))).toBe("订单 A");
  });

  it("截断到 200,防止超大容器拖垮输出", () => {
    expect(ancestorContextText(mk(`<div>${"长".repeat(500)}</div>`))).toHaveLength(200);
  });

  it("链接也算交互后代,一并剔除", () => {
    expect(ancestorContextText(mk(`<div>标题<a href="/x">查看</a></div>`))).toBe("标题");
  });
});
