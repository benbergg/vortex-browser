#!/bin/bash
# Chrome 启动 NM host 时不加载 shell profile，需要手动加载 nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

DIR="$(cd "$(dirname "$0")" && pwd)"

exec node "$DIR/dist/bin/vortex-server.js"
