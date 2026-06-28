// 极简 MCP-over-stdio stub child(集成测试用):
// 响应 initialize / tools/list / 其他请求,description 带 pid 供测试断言重启换进程。
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "0.0.0" },
      }});
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [{ name: "stub_tool", description: `pid:${process.pid}`, inputSchema: { type: "object" } }],
      }});
    } else if (msg.method && msg.id != null) {
      send({ jsonrpc: "2.0", id: msg.id, result: { ok: true, pid: process.pid } });
    }
    // 通知(无 id):忽略
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
