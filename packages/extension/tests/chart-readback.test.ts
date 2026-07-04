import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import {
  normalizeEchartsOption,
  serializeChart,
  echartsAdapter,
  detectAndReadChart,
  CHART_MAX_POINTS,
  type ChartData,
} from "../src/page-side/chart-readback.js";

/**
 * query mode=chart 真源单测。newbeta dogfood R6 增强候选:echarts 数据非截图 readback。
 * jsdom 构造 [_echarts_instance_] 容器 + mock window.echarts.getInstanceByDom → getOption,
 * 真实执行 adapter,不 mock adapter 内部。
 */

function mkEcharts(optByDom: Map<Element, Record<string, unknown>>) {
  return {
    version: "5.4.3",
    getInstanceByDom(el: Element) {
      const opt = optByDom.get(el);
      return opt ? { getOption: () => opt } : null;
    },
  };
}

describe("normalizeEchartsOption", () => {
  it("提取 title/series/xAxis/legend + chartType 取首系列", () => {
    const opt = {
      title: [{ text: "月度销售" }],
      xAxis: [{ type: "category", data: ["1月", "2月", "3月"] }],
      yAxis: [{ type: "value" }],
      legend: [{ data: ["销售额", "利润"] }],
      series: [
        { name: "销售额", type: "bar", data: [120, 200, 150] },
        { name: "利润", type: "line", data: [20, 40, 30] },
      ],
    };
    const cd = normalizeEchartsOption(opt);
    expect(cd.title).toBe("月度销售");
    expect(cd.chartType).toBe("bar");
    expect(cd.series).toHaveLength(2);
    expect(cd.series[0]).toMatchObject({ name: "销售额", type: "bar", data: [120, 200, 150] });
    expect(cd.xAxis?.[0]).toMatchObject({ type: "category", data: ["1月", "2月", "3月"] });
    expect(cd.legend).toEqual(["销售额", "利润"]);
  });

  it("series data 超上限截断 + 标注 truncated 总数", () => {
    const big = Array.from({ length: 500 }, (_, i) => i);
    const cd = normalizeEchartsOption({ series: [{ type: "line", data: big }] }, 200);
    expect(cd.series[0].data).toHaveLength(200);
    expect(cd.series[0].truncated).toBe(500);
  });

  it("pie {name,value} 数据点保留", () => {
    const cd = normalizeEchartsOption({
      series: [{ type: "pie", data: [{ name: "A", value: 10 }, { name: "B", value: 20 }] }],
    });
    expect(cd.chartType).toBe("pie");
    expect(cd.series[0].data).toEqual([{ name: "A", value: 10 }, { name: "B", value: 20 }]);
  });
});

describe("serializeChart", () => {
  const charts: ChartData[] = [
    {
      title: "月度销售",
      chartType: "bar",
      xAxis: [{ type: "category", data: ["1月", "2月"] }],
      legend: ["销售额"],
      series: [{ name: "销售额", type: "bar", data: [120, 200] }],
    },
  ];
  it("json 格式返回纯结构", () => {
    const out = serializeChart(charts, "json");
    expect(JSON.parse(out)).toEqual({ charts });
  });
  it("summary 格式含可读摘要 + 内嵌结构数据", () => {
    const out = serializeChart(charts, "summary");
    expect(out).toContain("检测到 1 个图表");
    expect(out).toContain("月度销售");
    expect(out).toContain("类型 bar");
    expect(out).toContain("销售额");
    expect(out).toContain("结构数据:");
    // 内嵌 JSON 可解析
    const jsonPart = out.slice(out.indexOf("结构数据:") + "结构数据:".length).trim();
    expect(JSON.parse(jsonPart)).toEqual({ charts });
  });
});

describe("echartsAdapter + detectAndReadChart (jsdom 真实执行)", () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  });

  it("detect+read:[_echarts_instance_] 容器 → getOption 归一化", () => {
    const doc = dom.window.document as unknown as Document;
    const div = doc.createElement("div");
    div.setAttribute("_echarts_instance_", "ec_1");
    doc.body.appendChild(div);
    const optMap = new Map<Element, Record<string, unknown>>([
      [div, { title: [{ text: "图A" }], series: [{ name: "s1", type: "bar", data: [1, 2, 3] }] }],
    ]);
    const win = { echarts: mkEcharts(optMap) };
    expect(echartsAdapter.detect(doc, win)).toBe(true);
    const res = detectAndReadChart(doc, win, CHART_MAX_POINTS);
    expect(res).not.toBeNull();
    expect(res!.adapter).toBe("echarts");
    expect(res!.charts).toHaveLength(1);
    expect(res!.charts[0]).toMatchObject({ title: "图A", chartType: "bar" });
  });

  it("无 window.echarts → detect false, detectAndReadChart null(优雅降级)", () => {
    const doc = dom.window.document as unknown as Document;
    const div = doc.createElement("div");
    div.setAttribute("_echarts_instance_", "ec_1");
    doc.body.appendChild(div);
    expect(echartsAdapter.detect(doc, {})).toBe(false);
    expect(detectAndReadChart(doc, {}, CHART_MAX_POINTS)).toBeNull();
  });

  it("有 echarts 全局但页面无图表容器 → null", () => {
    const doc = dom.window.document as unknown as Document;
    const win = { echarts: mkEcharts(new Map()) };
    expect(echartsAdapter.detect(doc, win)).toBe(false);
    expect(detectAndReadChart(doc, win, CHART_MAX_POINTS)).toBeNull();
  });

  it("多图表容器全部读取", () => {
    const doc = dom.window.document as unknown as Document;
    const d1 = doc.createElement("div"); d1.setAttribute("_echarts_instance_", "a");
    const d2 = doc.createElement("div"); d2.setAttribute("_echarts_instance_", "b");
    doc.body.append(d1, d2);
    const optMap = new Map<Element, Record<string, unknown>>([
      [d1, { series: [{ type: "line", data: [1] }] }],
      [d2, { series: [{ type: "pie", data: [{ name: "x", value: 5 }] }] }],
    ]);
    const res = detectAndReadChart(doc, { echarts: mkEcharts(optMap) }, CHART_MAX_POINTS);
    expect(res!.charts).toHaveLength(2);
    expect(res!.charts.map((c) => c.chartType)).toEqual(["line", "pie"]);
  });
});
