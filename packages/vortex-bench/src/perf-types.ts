// 深 DOM 压测的类型。判据分两层:结构事实(节点数/上溯步数)是确定量,可以断言;
// 耗时是参考量 —— 实测同一次端到端调用重复 10 次为 96–132ms(1.4×),做不了阈值门。

/** 一种语料形状。painted 决定 contrast 上溯是第一层就 break 还是走满整条链。 */
export interface CorpusShape {
  id: string;
  /** 目标总节点数(实际生成数见 CorpusPlan.expect.domNodes) */
  nodes: number;
  /** 主链深度 */
  depth: number;
  /** 目标元素个数 */
  targets: number;
  /** 最近祖先是否有绘制背景。true=真站常态,false=最坏情况 */
  painted: boolean;
}

/** 语料 + 它的结构真值。真值由生成器算出,不从被测代码反推。 */
export interface CorpusPlan {
  shape: CorpusShape;
  /** 在页内执行的建树脚本(自包含,不依赖模块作用域) */
  buildScript: string;
  expect: {
    /** 生成的子树节点数(不含落脚页自身的 head/body) */
    domNodes: number;
    /** 每个目标元素的 contrast 祖先上溯步数 */
    ancestorStepsPerTarget: number;
  };
}

/** 一个维度在一种语料上的观测。counters 是确定量,ms 是参考量。 */
export interface DimensionSample {
  dimension: string;
  /** 端到端多轮耗时,单位 ms */
  msSamples: number[];
  /** 页内命中测试次数 */
  hitTests: number;
  /** 页内祖先上溯总步数 */
  ancestorSteps: number;
}

export interface PerfRun {
  shapeId: string;
  domNodes: number;
  matched: number;
  samples: DimensionSample[];
  /** 结构真值与实测不符时逐条记下,这才是可阻断的信号 */
  structuralMismatches: string[];
}

export interface PerfReport {
  generatedAt: string;
  browser: string;
  runs: PerfRun[];
}
