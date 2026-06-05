#!/usr/bin/env bash
# 把一段录屏(.mov/.mp4)转成 README 用的优化 gif。
# 用法: scripts/make-demo-gif.sh <输入视频> [输出.gif] [fps] [宽度px]
# 默认输出 docs/assets/demo.gif,fps=12,宽 960。
# 依赖: ffmpeg(palettegen 两遍法,质量远好于单遍)。
set -euo pipefail

IN="${1:?用法: scripts/make-demo-gif.sh <输入视频> [输出.gif] [fps] [宽度px]}"
OUT="${2:-docs/assets/demo.gif}"
FPS="${3:-12}"
WIDTH="${4:-960}"

[ -f "$IN" ] || { echo "错误: 找不到输入文件 $IN" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "错误: 需要 ffmpeg(brew install ffmpeg)" >&2; exit 1; }

PALETTE="$(mktemp -t demo-palette).png"
trap 'rm -f "$PALETTE"' EXIT

# 第 1 遍:按目标 fps/宽度生成最优调色板(stats_mode=diff 偏向运动区域)
ffmpeg -y -i "$IN" \
  -vf "fps=$FPS,scale=$WIDTH:-1:flags=lanczos,palettegen=stats_mode=diff" \
  "$PALETTE" 2>/dev/null

# 第 2 遍:用调色板渲染 gif(rectangle diff + 轻抖动,体积/质量平衡好)
ffmpeg -y -i "$IN" -i "$PALETTE" \
  -lavfi "fps=$FPS,scale=$WIDTH:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  "$OUT" 2>/dev/null

SIZE="$(du -h "$OUT" | cut -f1)"
echo "✓ 已生成 $OUT (${SIZE})"
echo "  GitHub 建议 gif < 10MB(理想 < 5MB)。过大就降 fps(如 10)或宽度(如 800),或裁短片段。"
