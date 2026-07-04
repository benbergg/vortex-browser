/**
 * 通用图表 readback 真源(纯逻辑)。ChartData 是各 adapter 归一化后的图表数据模型
 * (title/series/axes/legend),serializeChart 渲染 summary(默认,可读摘要+内嵌结构数据)
 * 或 json(纯结构)。
 * ⚠ page-side probe(query.ts chartProbeFunc)内联同一逻辑(注入丢模块作用域),
 * 改一处须改两处;query-chart-parity.test.ts 校验。纯读,不调用图表实例的写方法(只读安全)。
 *
 * MVP:echarts adapter(win.echarts.getInstanceByDom → getOption)。G2/Chart.js 留 adapter seam。
 */
export interface ChartSeries {
  name?: string;
  type: string;
  /** 系列数据点(可能被截断,见 truncated) */
  data: unknown[];
  /** 被截断时:原始总点数 */
  truncated?: number;
}
export interface ChartAxis {
  type?: string;
  name?: string;
  data?: unknown[];
}
export interface ChartData {
  title?: string;
  /** 主图表类型(取 series[0].type):bar/line/pie/scatter… */
  chartType: string;
  series: ChartSeries[];
  xAxis?: ChartAxis[];
  yAxis?: ChartAxis[];
  legend?: string[];
}
export type ChartFormat = "summary" | "json";

/** 每系列数据点默认上限,超出截断 + 标注 total。 */
export const CHART_MAX_POINTS = 200;

/** 归一化 echarts getOption() 的 axis 数组(可能是对象或数组)。 */
function normAxis(ax: unknown): ChartAxis[] | undefined {
  if (ax == null) return undefined;
  const arr = Array.isArray(ax) ? ax : [ax];
  const out = arr
    .filter((a) => a && typeof a === "object")
    .map((a) => {
      const o = a as Record<string, unknown>;
      const r: ChartAxis = {};
      if (typeof o.type === "string") r.type = o.type;
      if (typeof o.name === "string") r.name = o.name;
      if (Array.isArray(o.data)) r.data = o.data;
      return r;
    });
  return out.length ? out : undefined;
}

/** 归一化 echarts getOption() 的 legend(取第一个 legend 的 data)。 */
function normLegend(legend: unknown): string[] | undefined {
  if (legend == null) return undefined;
  const arr = Array.isArray(legend) ? legend : [legend];
  for (const l of arr) {
    if (l && typeof l === "object" && Array.isArray((l as Record<string, unknown>).data)) {
      return ((l as Record<string, unknown>).data as unknown[]).map((x) =>
        typeof x === "string" ? x : x && typeof x === "object" && "name" in (x as object) ? String((x as Record<string, unknown>).name) : String(x),
      );
    }
  }
  return undefined;
}

/** 归一化 echarts getOption() 的 title(取第一个非空 text/subtext)。 */
function normTitle(title: unknown): string | undefined {
  if (title == null) return undefined;
  const arr = Array.isArray(title) ? title : [title];
  for (const t of arr) {
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      const txt = (o.text as string) || (o.subtext as string);
      if (txt) return String(txt);
    }
  }
  return undefined;
}

/** 归一化单个 echarts option → ChartData。maxPoints 控制系列数据截断。 */
export function normalizeEchartsOption(
  opt: Record<string, unknown>,
  maxPoints: number = CHART_MAX_POINTS,
): ChartData {
  const rawSeries = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : [];
  const series: ChartSeries[] = rawSeries
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const o = s as Record<string, unknown>;
      const data = Array.isArray(o.data) ? o.data : [];
      const cs: ChartSeries = { type: String(o.type ?? "unknown"), data: data.slice(0, maxPoints) };
      if (typeof o.name === "string") cs.name = o.name;
      if (data.length > maxPoints) cs.truncated = data.length;
      return cs;
    });
  const cd: ChartData = { chartType: series[0]?.type ?? "unknown", series };
  const title = normTitle(opt.title);
  if (title) cd.title = title;
  const xAxis = normAxis(opt.xAxis);
  if (xAxis) cd.xAxis = xAxis;
  const yAxis = normAxis(opt.yAxis);
  if (yAxis) cd.yAxis = yAxis;
  const legend = normLegend(opt.legend);
  if (legend) cd.legend = legend;
  return cd;
}

function fmtVals(data: unknown[], truncated?: number): string {
  const shown = data
    .slice(0, 12)
    .map((d) => {
      if (d && typeof d === "object") {
        const o = d as Record<string, unknown>;
        // echarts pie/自定义:{name, value}
        if ("value" in o) return o.name != null ? `${o.name}:${o.value}` : String(o.value);
        return JSON.stringify(o);
      }
      return String(d);
    })
    .join(", ");
  const more = truncated ? ` …共${truncated}点` : data.length > 12 ? ` …共${data.length}点` : "";
  return `[${shown}${more}]`;
}

/** 渲染可读摘要(每图表:标题/类型/系列/x轴/图例)。 */
function renderSummary(charts: ChartData[]): string {
  const lines: string[] = [`检测到 ${charts.length} 个图表(echarts):`];
  charts.forEach((c, i) => {
    lines.push(`\n[图表${i + 1}] ${c.title ?? "(无标题)"} — 类型 ${c.chartType},${c.series.length} 系列`);
    if (c.xAxis?.[0]?.data) lines.push(`  x轴(${c.xAxis[0].type ?? "?"}): ${fmtVals(c.xAxis[0].data)}`);
    if (c.legend) lines.push(`  图例: [${c.legend.join(", ")}]`);
    for (const s of c.series) {
      lines.push(`  系列 ${s.name ?? "(无名)"}(${s.type}): ${fmtVals(s.data, s.truncated)}`);
    }
  });
  return lines.join("\n");
}

export function serializeChart(charts: ChartData[], format: ChartFormat): string {
  if (format === "json") return JSON.stringify({ charts });
  // summary(默认):可读摘要 + 内嵌结构数据(满足"结构 JSON + 可读摘要")
  return `${renderSummary(charts)}\n\n结构数据:\n${JSON.stringify({ charts })}`;
}

export interface ChartAdapter {
  name: string;
  detect(doc: Document, win: unknown): boolean;
  read(doc: Document, win: unknown, maxPoints: number): ChartData[] | null;
}

/** echarts adapter:定位 `[_echarts_instance_]` 容器 → getInstanceByDom → getOption。 */
export const echartsAdapter: ChartAdapter = {
  name: "echarts",
  detect(doc: Document, win: unknown): boolean {
    const w = win as { echarts?: { getInstanceByDom?: unknown } };
    return !!w.echarts && typeof w.echarts.getInstanceByDom === "function" && !!doc.querySelector("[_echarts_instance_]");
  },
  read(doc: Document, win: unknown, maxPoints: number): ChartData[] | null {
    const w = win as {
      echarts?: {
        getInstanceByDom?: (el: Element) => { getOption?: () => Record<string, unknown> } | null | undefined;
        getInstanceById?: (id: string) => { getOption?: () => Record<string, unknown> } | null | undefined;
      };
    };
    const ec = w.echarts;
    if (!ec) return null;
    const divs = Array.from(doc.querySelectorAll("[_echarts_instance_]"));
    const charts: ChartData[] = [];
    for (const div of divs) {
      let inst = ec.getInstanceByDom ? ec.getInstanceByDom(div) : null;
      if (!inst && ec.getInstanceById) {
        const id = div.getAttribute("_echarts_instance_");
        if (id) inst = ec.getInstanceById(id);
      }
      if (inst && typeof inst.getOption === "function") {
        try {
          charts.push(normalizeEchartsOption(inst.getOption(), maxPoints));
        } catch {
          /* 单图表读失败不阻断其余 */
        }
      }
    }
    return charts.length ? charts : null;
  },
};

const CHART_ADAPTERS: ChartAdapter[] = [echartsAdapter];

/** 遍历 adapter 检测并读取图表。返回 {adapter, charts} 或 null(无图表)。 */
export function detectAndReadChart(
  doc: Document,
  win: unknown,
  maxPoints: number = CHART_MAX_POINTS,
): { adapter: string; charts: ChartData[] } | null {
  for (const a of CHART_ADAPTERS) {
    if (a.detect(doc, win)) {
      const charts = a.read(doc, win, maxPoints);
      if (charts && charts.length) return { adapter: a.name, charts };
    }
  }
  return null;
}
