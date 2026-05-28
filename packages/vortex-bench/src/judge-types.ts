// packages/vortex-bench/src/judge-types.ts
// 自主发现引擎 #5 — LLM-judge 塔尖共享类型。复用 scan-types 的 Finding(recall-miss 已是合法 kind)。

import type { Finding } from "./scan-types.js";

/** LLM 判官报告的一个"漏发"候选 */
export interface ClaimedMiss {
  /** 简短 label,如 "搜索按钮" */
  label: string;
  /** [x,y,w,h] viewport 坐标;parse 时非法/缺失项被丢弃,故此处恒为合法四元组 */
  bbox: [number, number, number, number];
  /** 判定可交互的理由(语义/外观) */
  reason: string;
}

/** synth 消融校准统计 */
export interface CalibrationStats {
  /** 假阳测试:原样列表 2 轮取交集后判官报的 miss 数(理想 0) */
  fpConfirmed: number;
  /** 查全测试:抽掉的已知可见可交互行数 k */
  ablatedCount: number;
  /** 查全:被判官从截图重发现的抽掉行数 */
  ablatedRecovered: number;
}

/** 一页判官结果 */
export interface JudgePageResult {
  /** fixture 名(synth)或 URL(live) */
  page: string;
  totalObserveRows: number;
  /** 两轮自一致取交集后确认的漏发(live 模式;synth FP 也走这里) */
  confirmedMisses: ClaimedMiss[];
  /** 复用 Finding{kind:"recall-miss"} */
  findings: Finding[];
  /** 仅 synth 校准模式有值 */
  calibration?: CalibrationStats;
  /** 截图 profile 快照(有传 screenshotProfile 时才有值) */
  profile?: {
    name: string;
    format: "jpeg" | "png";
    quality?: number;
    deviceScaleFactor: 1 | 2;
    perFrame: boolean;
  };
  /** 环境/工具/LLM 错误(非 finding) */
  error?: string;
}

export interface JudgeReport {
  generatedAt: string;
  model: string;
  mode: "synth" | "live";
  /** 截图 profile 描述符(无则用 "q70-default") */
  profile?: { name: string };
  pages: JudgePageResult[];
  /** 所有 page 扁平化的 findings */
  findings: Finding[];
}
