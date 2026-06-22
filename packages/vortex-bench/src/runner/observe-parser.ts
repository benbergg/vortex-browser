// packages/vortex-bench/src/runner/observe-parser.ts
// observe compact 文本 → 结构化。契约见 observe-render.ts:57-121。

import type { ObserveRow, ObserveHeader, ParsedObserve } from "../scan-types.js";

// ── 树格式（新，a11y-tree）─────────────────────────────────────────────────
// 每行：{indent}- {role} "{name}"? [ref=@..] {[flag]..}? {…中间段…}? {bbox=[..]}? {:}?
// 缩进 2 空格/层；role 裸词；name 可含转义 \"；flag 容忍 = 与 :（cursor=pointer / sort:asc）；
// 中间段（value= / compound=(...) / error= / controls= / desc= / [offscreen] / [virtual:..] /
// [blindspot=..]，顺序见 observe-render.ts:458）由惰性 .*? 整体跳过——不进 ObserveRow。bbox=
// 恒为末尾数据段(可选,后仅跟 children 冒号),用前置 .*? + 末尾捕获稳妥提取。旧版只容忍
// value=/bbox=,遇 compound=(...) 等中间段整行失配被静默丢(native-form file/range input 假
// recall-miss,2026-06-22 FullCalendar/native-form dogfood)。
const TREE_ROW_RE =
  /^(\s*)-\s+(\S+)(?:\s+"((?:\\.|[^"\\])*)")?\s+\[ref=(@[\w:]+)\]((?:\s+\[[a-z:=]+\])*).*?(?:\s+bbox=\[(\d+),(\d+),(\d+),(\d+)\])?\s*:?\s*$/;

// ── 旧扁平格式（向后兼容）──────────────────────────────────────────────────
// 元素行: @<ref> [<role>] "<name>"? (<flags>)* (…中间段…)? (bbox=[..])?
// flag 段容忍 `:`:aria-sort 渲染为 [sort:asc]/[sort:desc]（observe-render.ts），
// 旧 [a-z]+ 不含冒号会让整行失配被静默丢（2026-06-02 AC，同 value= 段教训）。
// 中间段(value=/compound=(...)/desc= 等)同树格式由惰性 .*? 跳过,只保 bbox= 末尾捕获。
const FLAT_ROW_RE =
  /^(@[\w:]+)\s+\[([^\]]+)\](?:\s+"((?:\\.|[^"\\])*)")?((?:\s+\[[a-z:]+\])*).*?(?:\s+bbox=\[(\d+),(\d+),(\d+),(\d+)\])?\s*$/;

// flag 匹配（树格式：含 = 符，如 cursor=pointer；扁平格式：仅含 a-z:）
const FLAG_RE_TREE = /\[([a-z:=]+)\]/g;
const FLAG_RE_FLAT = /\[([a-z:]+)\]/g;

// /url 属性行（树格式 link 节点子行），不计入 rows
const URL_RE = /^\s*-\s+\/url:/;

const OFFSET_RE = /^#\s+frame\s+(\d+)\s+offset=\[(\d+),(\d+)\]/;
const VIEWPORT_RE = /^Viewport:\s+(\d+)x(\d+),\s+scrollY=(\d+)\/(\d+)/;

/** 从 ref 提取 frameId:@h:f<N>e<M> → N;无 fN 段 → 0 */
function frameIdOf(ref: string): number {
  const m = ref.match(/f(\d+)e\d+$/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

export function parseObserveSnapshot(text: string): ParsedObserve {
  const header: ObserveHeader = { snapshotId: "", url: "" };
  const rows: ObserveRow[] = [];
  const frameOffsets: Record<number, [number, number]> = {};
  // 缩进栈：stack[depth] = 该深度最近一行的 ref，用于推导 parentRef
  const stack: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();

    // ── header 分支（保持不变）──────────────────────────────────────────
    if (line.startsWith("SnapshotId:")) {
      header.snapshotId = line.slice("SnapshotId:".length).trim();
      continue;
    }
    if (line.startsWith("URL:")) {
      header.url = line.slice("URL:".length).trim();
      continue;
    }
    if (line.startsWith("Title:")) {
      header.title = line.slice("Title:".length).trim();
      continue;
    }
    const vp = line.match(VIEWPORT_RE);
    if (vp) {
      header.viewport = {
        width: Number.parseInt(vp[1], 10),
        height: Number.parseInt(vp[2], 10),
        scrollY: Number.parseInt(vp[3], 10),
        scrollHeight: Number.parseInt(vp[4], 10),
      };
      continue;
    }
    const off = line.match(OFFSET_RE);
    if (off) {
      frameOffsets[Number.parseInt(off[1], 10)] = [
        Number.parseInt(off[2], 10),
        Number.parseInt(off[3], 10),
      ];
      continue;
    }

    // ── /url 属性行（树格式 link 节点子行，不计入 rows）─────────────────
    if (URL_RE.test(line)) continue;

    // ── 树格式元素行（新 a11y-tree 格式）────────────────────────────────
    const mt = line.match(TREE_ROW_RE);
    if (mt) {
      const indent = mt[1].length;
      const depth = indent / 2; // 2 空格/层
      const flags = mt[5] ? [...mt[5].matchAll(FLAG_RE_TREE)].map((f) => f[1]) : [];
      const bbox: ObserveRow["bbox"] =
        mt[6] !== undefined
          ? [Number.parseInt(mt[6], 10), Number.parseInt(mt[7], 10), Number.parseInt(mt[8], 10), Number.parseInt(mt[9], 10)]
          : null;
      // 缩进栈：截断到当前深度，父 = stack[depth-1]
      stack.length = depth;
      const parentRef = depth > 0 ? (stack[depth - 1] ?? null) : null;
      stack[depth] = mt[4];
      rows.push({
        ref: mt[4],
        role: mt[2],
        name: mt[3] !== undefined ? mt[3].replace(/\\"/g, '"') : null,
        flags,
        bbox,
        frameId: frameIdOf(mt[4]),
        depth,
        parentRef,
      });
      continue;
    }

    // ── 旧扁平格式元素行（向后兼容，depth/parentRef 不注入）────────────
    const mf = line.match(FLAT_ROW_RE);
    if (mf) {
      const flags = mf[4] ? [...mf[4].matchAll(FLAG_RE_FLAT)].map((f) => f[1]) : [];
      const bbox: ObserveRow["bbox"] =
        mf[5] !== undefined
          ? [Number.parseInt(mf[5], 10), Number.parseInt(mf[6], 10), Number.parseInt(mf[7], 10), Number.parseInt(mf[8], 10)]
          : null;
      rows.push({
        ref: mf[1],
        role: mf[2],
        name: mf[3] !== undefined ? mf[3].replace(/\\"/g, '"') : null,
        flags,
        bbox,
        frameId: frameIdOf(mf[1]),
      });
    }
  }
  return { header, rows, frameOffsets };
}
