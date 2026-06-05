#!/usr/bin/env bash
# vortex-browser 一键安装脚本
# 职责: 注册 Native Messaging host manifest + 打印扩展加载指引
# 不重新实现 NM 逻辑 —— 直接调用 packages/server/dist/scripts/install-nm-host.js
set -euo pipefail

# ─────────────────────────────────────────────
# 颜色与辅助函数
# ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[info]${NC}  $*"; }
ok()      { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
error()   { echo -e "${RED}[error]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }
step()    { echo -e "\n${BOLD}=== $* ===${NC}"; }

# ─────────────────────────────────────────────
# 定位仓库根目录（脚本始终在 scripts/ 下）
# ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_PKG="$REPO_ROOT/packages/server"
VORTEX_SERVER_BIN="$SERVER_PKG/dist/bin/vortex-server.js"
INSTALL_NM_HOST="$SERVER_PKG/dist/scripts/install-nm-host.js"
EXTENSION_DIST="$REPO_ROOT/packages/extension/dist"

# ─────────────────────────────────────────────
# 1. OS 检测
# ─────────────────────────────────────────────
step "检测运行环境"
OS="$(uname -s)"
case "$OS" in
  Darwin)
    ok "检测到 macOS"
    NM_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    ok "检测到 Linux"
    NM_HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    die "不支持的操作系统: $OS。请在 macOS 或 Linux 上运行此脚本。Windows 用户请参考 docs/INSTALL.md 手动安装。"
    ;;
esac

# ─────────────────────────────────────────────
# 2. 前置检查: Node.js >= 18
# ─────────────────────────────────────────────
step "检查 Node.js 版本"
if ! command -v node &>/dev/null; then
  die "未找到 node 命令。请安装 Node.js >= 18 后重试。\n  下载: https://nodejs.org/"
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  die "Node.js 版本过低 (当前: $(node --version))，需要 >= 18。\n  下载: https://nodejs.org/"
fi
ok "Node.js $(node --version)"

# ─────────────────────────────────────────────
# 3. 检查 server 是否已构建
# ─────────────────────────────────────────────
step "检查 server 构建产物"
if [[ ! -f "$INSTALL_NM_HOST" ]]; then
  warn "未找到构建产物: $INSTALL_NM_HOST"
  info "正在构建 @vortex-browser/server ..."

  if ! command -v pnpm &>/dev/null; then
    die "未找到 pnpm 命令，且 server 尚未构建。\n  请先运行: pnpm --filter @vortex-browser/server build\n  或安装 pnpm: npm i -g pnpm"
  fi

  if ! pnpm --filter @vortex-browser/server build; then
    die "server 构建失败。请检查上方错误信息后重试。"
  fi

  if [[ ! -f "$INSTALL_NM_HOST" ]]; then
    die "构建完成但仍找不到 $INSTALL_NM_HOST。请检查 tsconfig 输出路径。"
  fi
  ok "server 构建成功"
else
  ok "server 构建产物已存在"
fi

# ─────────────────────────────────────────────
# 4. 获取 Chrome 扩展 ID
# ─────────────────────────────────────────────
step "获取 Chrome 扩展 ID"

# 允许通过环境变量或命令行参数传入扩展 ID
EXTENSION_ID="${1:-${VORTEX_EXTENSION_ID:-}}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo ""
  info "需要 Chrome 扩展 ID 才能注册 Native Messaging host。"
  info "获取方式:"
  info "  1. 打开 Chrome，访问 chrome://extensions/"
  info "  2. 开启右上角「开发者模式」"
  info "  3. 点击「加载已解压的扩展程序」，选择目录:"
  info "     $EXTENSION_DIST"
  info "  4. 加载后复制显示的扩展 ID（32 位字母，例如 abcdefghijklmnopabcdefghijklmnop）"
  echo ""
  read -r -p "请输入扩展 ID（留空跳过 NM host 注册）: " EXTENSION_ID
fi

if [[ -z "$EXTENSION_ID" ]]; then
  warn "跳过 NM host 注册。"
  warn "之后可随时重新运行此脚本并输入扩展 ID 完成注册，或手动运行:"
  warn "  node $INSTALL_NM_HOST <扩展ID>"
else
  # 简单格式校验：Chrome 扩展 ID 为 32 位小写字母
  if [[ ! "$EXTENSION_ID" =~ ^[a-z]{32}$ ]]; then
    die "扩展 ID 格式不正确: \"$EXTENSION_ID\"\n  应为 32 位小写字母，例如: abcdefghijklmnopabcdefghijklmnop"
  fi

  # ─────────────────────────────────────────────
  # 5. 注册 Native Messaging host manifest
  # 优先使用 `vortex-server install`（bin/vortex-server.js），
  # 回退到旧版 dist/scripts/install-nm-host.js（向后兼容）。
  # ─────────────────────────────────────────────
  step "注册 Native Messaging host"

  if [[ -f "$VORTEX_SERVER_BIN" ]]; then
    info "调用 vortex-server install (ID: $EXTENSION_ID) ..."
    node "$VORTEX_SERVER_BIN" install "$EXTENSION_ID" || {
      NM_EXIT=$?
      die "NM host 注册失败（退出码 $NM_EXIT）。\n  请检查是否有写入权限: $NM_HOST_DIR"
    }
  else
    info "调用 install-nm-host.js (ID: $EXTENSION_ID) ..."
    node "$INSTALL_NM_HOST" "$EXTENSION_ID" || {
      NM_EXIT=$?
      die "NM host 注册失败（退出码 $NM_EXIT）。\n  请检查是否有写入权限: $NM_HOST_DIR"
    }
  fi

  MANIFEST_PATH="$NM_HOST_DIR/com.vortexbrowser.host.json"
  if [[ -f "$MANIFEST_PATH" ]]; then
    ok "NM host manifest 写入成功: $MANIFEST_PATH"
  else
    die "NM host manifest 未找到（注册脚本成功退出但文件不存在）: $MANIFEST_PATH"
  fi
fi

# ─────────────────────────────────────────────
# 6. 扩展加载指引
# ─────────────────────────────────────────────
step "扩展加载指引"
echo ""
echo -e "${BOLD}如果尚未加载 Chrome 扩展，请按以下步骤操作:${NC}"
echo ""
echo "  1. 打开 Chrome，访问 chrome://extensions/"
echo "  2. 开启右上角「开发者模式」"
echo "  3. 点击「加载已解压的扩展程序」，选择目录:"
echo -e "     ${BOLD}$EXTENSION_DIST${NC}"
echo "  4. 记下扩展 ID（如果还未注册 NM host，再次运行此脚本并输入 ID）"
echo ""

# ─────────────────────────────────────────────
# 7. 完成
# ─────────────────────────────────────────────
step "安装完成"
echo ""
ok "启动 vortex-server："
echo "  node $SERVER_PKG/dist/bin/vortex-server.js"
echo ""
ok "或全局安装后使用："
echo "  npm i -g @vortex-browser/server"
echo "  vortex-server"
echo ""
echo -e "${BOLD}遇到问题？查看 docs/INSTALL.md 的「故障排查」章节。${NC}"
