// P1-3 薄视觉兑底(Set-of-Mark)。
//
// 硬视觉场景(canvas/地图/无 alt 图)文本感知无从下手时,给一张「叠了 ref 编号」
// 的视口截图:图上的数字 == observe 快照里的 index == vortex_act 的 @ref 参数。
// 一图三用(截图号=DOM ref=act 参数),让模型对纯像素区域也能精确定位并操作,
// 而不是靠坐标猜。
//
// 本文件拆两层:
//  1. computeMarkPlacements —— 纯几何(viewport 相对 CSS px → 截图物理像素),
//     可离线单测,承担过滤(视口外/零尺寸/越界)+ dpr 缩放 + 边界裁剪。
//  2. drawMarksOnImage —— OffscreenCanvas 合成(MV3 SW 原生),依赖浏览器运行时,
//     由真站 spike 验。

/** observe 快照元素在视口内的量测结果(CSS px,viewport 相对)。 */
export interface MarkRect {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** getBoundingClientRect 与视口相交为 true;false 者不叠标(不在截图里)。 */
  inViewport: boolean;
}

/** 落在截图上的标记框(物理像素,已 ×dpr 且裁到图像边界内)。 */
export interface MarkPlacement {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 把视口相对 CSS px 的 bbox 列表映射为截图物理像素的标记框。
 *
 * captureVisibleTab / CDP 截图按 devicePixelRatio 出物理像素图,原点为视口左上;
 * getBoundingClientRect 给的是视口相对 CSS px。故 ×dpr 即对齐。
 *
 * 过滤规则:
 *  - inViewport=false → 丢弃(不在截图里)
 *  - 零/负尺寸 → 丢弃(display:none / 退化 box,画不出)
 *  - ×dpr 后完全落在图像外 → 丢弃
 *  - 部分越界 → 裁剪到 [0,imgW]×[0,imgH](标签与框不出画布)
 */
export function computeMarkPlacements(
  rects: MarkRect[],
  dpr: number,
  imgW: number,
  imgH: number,
): MarkPlacement[] {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const out: MarkPlacement[] = [];
  for (const rc of rects) {
    if (!rc.inViewport) continue;
    if (rc.w <= 0 || rc.h <= 0) continue;

    let x = rc.x * scale;
    let y = rc.y * scale;
    let right = (rc.x + rc.w) * scale;
    let bottom = (rc.y + rc.h) * scale;

    // 完全落在图像外(整块越界)→ 丢弃
    if (right <= 0 || bottom <= 0 || x >= imgW || y >= imgH) continue;

    // 裁剪到图像边界
    x = Math.max(0, x);
    y = Math.max(0, y);
    right = Math.min(imgW, right);
    bottom = Math.min(imgH, bottom);

    const w = right - x;
    const h = bottom - y;
    if (w <= 0 || h <= 0) continue;

    out.push({ index: rc.index, x, y, w, h });
  }
  return out;
}

/**
 * 在截图上叠加 ref 编号标记(每个框左上角一个数字 tag + 描边框)。
 * MV3 service worker 原生支持 OffscreenCanvas / createImageBitmap。
 * 解码一次拿到图像真实尺寸后就地算 placements(computeMarkPlacements),
 * 免去为求宽高二次解码。
 *
 * @param dataUrl 原始截图(data:image/png|jpeg;base64,...)
 * @param rects observe 快照量测的视口相对 bbox(CSS px)
 * @param dpr 设备像素比,叠标坐标缩放 + 字号/线宽按图缩放(2x 图仍清晰)
 * @returns 叠标后 PNG dataUrl(0 个可标元素时返回原图)+ 计数/ref 列表
 */
export async function drawMarksOnImage(
  dataUrl: string,
  rects: MarkRect[],
  dpr: number,
): Promise<{ dataUrl: string; count: number; refs: number[] }> {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const placements = computeMarkPlacements(rects, dpr, bitmap.width, bitmap.height);
  if (placements.length === 0) {
    bitmap.close();
    return { dataUrl, count: 0, refs: [] };
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return { dataUrl, count: 0, refs: [] }; // 取不到 2d context 时退化返回原图(绝不因叠标失败丢截图)
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const line = Math.max(2, Math.round(2 * scale));
  const fontPx = Math.max(11, Math.round(11 * scale));
  ctx.lineWidth = line;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textBaseline = "top";

  for (const p of placements) {
    // 高亮描边框(半透明红,SoM 惯用高对比色)
    ctx.strokeStyle = "rgba(255,0,80,0.95)";
    ctx.strokeRect(p.x + line / 2, p.y + line / 2, Math.max(1, p.w - line), Math.max(1, p.h - line));

    // 左上角编号 tag:红底白字
    const label = String(p.index);
    const padX = Math.round(fontPx * 0.35);
    const padY = Math.round(fontPx * 0.2);
    const tw = ctx.measureText(label).width;
    const tagW = tw + padX * 2;
    const tagH = fontPx + padY * 2;
    // tag 尽量贴框左上;若顶到图像上缘则改贴框内侧下方,避免出画布
    let tagX = p.x;
    let tagY = p.y - tagH;
    if (tagY < 0) tagY = p.y;
    if (tagX + tagW > canvas.width) tagX = Math.max(0, canvas.width - tagW);

    ctx.fillStyle = "rgba(255,0,80,0.95)";
    ctx.fillRect(tagX, tagY, tagW, tagH);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, tagX + padX, tagY + padY);
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const buf = await outBlob.arrayBuffer();
  return {
    dataUrl: `data:image/png;base64,${base64FromArrayBuffer(buf)}`,
    count: placements.length,
    refs: placements.map((p) => p.index),
  };
}

/** ArrayBuffer → base64(SW 无 Buffer,用 btoa + 分块避免大图爆栈)。 */
function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
