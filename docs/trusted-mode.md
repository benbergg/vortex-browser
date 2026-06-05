# Trusted 模式(P1,手动)

vortex 默认用合成事件点击(无黄条,覆盖多数站)。少数站(如淘宝搜索)的按钮要求
`isTrusted` 真事件,合成会被丢弃。带 `--silent-debugger-extension-api` 启动 Chrome 即可
让 vortex 自动走 CDP 真鼠标(trusted),且**不弹调试黄条**。

## macOS 手动启动(P1)

1. 完全退出 Chrome(⌘Q;`killall "Google Chrome"` 确保进程清掉)。
2. 带 flag 启动:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --silent-debugger-extension-api`
3. 加载 vortex 扩展(若未随 profile 恢复),`/mcp` 重连。

启动后 server 经 `ps` 检测到 flag,`vortex_act(click)` 自动走 CDP trusted。
不带 flag 启动则回退现状(合成 + submit-intent),无黄条、覆盖多数站。

> P2 将提供扩展内「重启进入 trusted 模式」一键入口,免手动命令。
