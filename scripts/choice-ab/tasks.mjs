// 工具选择盲测语料。
//
// 硬约束:任务文本**不得出现任何工具名**(vortex / playwright / MCP / 浏览器工具…),
// 否则被试是在读答案而不是做选择。措辞只描述场景与约束,由被试自己判断该用谁。
//
// expect 是**预先注册的判据**——必须在跑之前写死,否则就是事后找解释。
// clean-account 是反向对照:正确答案是 playwright。没有它就无法区分
// 「规则生效」与「规则把模型压成无脑选 vortex」。

export const TASKS = [
  {
    id: "dev-visual",
    expect: "vortex",
    why: "本地 dev server 视觉验收。历史上 6/7 大流量会话在此直选 playwright,是分歧最大的场景",
    prompt: (ctx) =>
      `dev server 在 ${ctx.port} 跑着，别动任何代码——只做观察，看完给结论就行：打开首页看一眼实际渲染有没有明显问题。`,
  },
  {
    id: "dev-responsive",
    expect: "vortex",
    why: "需要改视口。vortex_resize 上线前这是 100% playwright 的场景",
    prompt: (ctx) =>
      `dev server 在 ${ctx.port} 跑着，别改代码。把视口切到 375px 窄屏，看主要内容有没有被挤裂或溢出，给结论。`,
  },
  {
    id: "reuse-tabs",
    expect: "vortex",
    why: "复用用户已打开的标签页。独立实例做不到,能力上只有一个答案",
    prompt: () =>
      `看一下我现在浏览器里开着的标签页，把当前活跃那个的标题和 URL 告诉我。不要新开窗口，我正在用。`,
  },
  {
    id: "clean-account",
    expect: "playwright",
    why: "反向对照:需要干净登录态 + 不能碰用户既有账号,正确答案是独立实例",
    prompt: (ctx) =>
      `帮我把注册流程从头走一遍验证一下：${ctx.port}/signup。注册一个全新的临时账号，` +
      `全程不能碰我日常浏览器里已经登录的账号，我的登录态不许受任何影响。`,
  },
];

export const byId = (ids) =>
  ids?.length ? TASKS.filter((t) => ids.includes(t.id)) : TASKS;
