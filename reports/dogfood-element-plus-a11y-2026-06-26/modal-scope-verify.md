# modal-scope verify report

**任务**: N002 T2-2 vortex observe 模态作用域(Modal Scoping)实机 live 复验记录

**修复 commit**:
- `d44278f` feat(observe): 模态作用域纯函数 isModalOverlayRoot/selectActiveModal/scopeCandidatesToModal
- `c0fa932` feat(observe): inject func 模态裁剪 + page result modal 字段
- `a967040` feat(observe): 聚合透传 modal + observe-render 渲染 # modal: meta
- `6737ec2` feat(observe): filter=all 背景元素标 [behind-modal]

**修复前(ant.design / Element Plus 实证)**: aria-modal=true 弹层打开时,observe 把模态控件与整页背景平铺混合,模态 3 按钮混进 56 个背景元素。agent「点开了却找不到模态按钮」。

**修复后预期**:
1. 默认 `vortex_observe({})` (filter=interactive):只见模态内按钮 + 顶部 `# modal: dialog "<name>" (suppressed N background elements)`。
2. `vortex_observe({ filter: "all" })`:返回全集,背景元素行尾 `[behind-modal]`,模态内元素无标。
3. `role=dialog` 无 `aria-modal`(伪模态)→ 零漂移,仍走 overlay-priority 前置,行为不变。
4. 跨库通用:Element Plus / antd / MUI 的 Modal/Drawer/MessageBox 全部 aria-modal=true → 修复一致。

## 实机验证清单

### 1. Element Plus dialog (`element-plus.org/zh-CN/component/dialog.html`)
- [ ] 打开 dialog → `vortex_observe(filter=interactive)` 应只返回模态 3 按钮 + 顶部 `# modal: dialog "Tips" (...)`
- [ ] `vortex_observe(filter=all)` → 返回全集,背景链接带 `[behind-modal]`
- [ ] 关闭 dialog → 无 `# modal:` 行,行为与 baseline 一致

### 2. Element Plus drawer (`element-plus.org/zh-CN/component/drawer.html`)
- [ ] 打开 drawer → 同 dialog 行为(aria-modal=true)
- [ ] drawer 嵌套 form 输入框 → 模态内 input 也召回

### 3. Element Plus message-box (`element-plus.org/zh-CN/component/message-box.html`)
- [ ] confirm 弹窗 → 同 dialog 行为
- [ ] prompt 弹窗 → 含 input 元素召回

### 4. antd Modal (`ant.design/components/modal`)
- [ ] Modal.confirm / Modal.info → 同 dialog 行为

### 5. MUI Dialog (`mui.com/material-ui/react-dialog/`)
- [ ] 打开 Dialog → 模态按钮召回 + # modal: 行

### 6. 负样本:select 下拉(`element-plus.org/zh-CN/component/select.html`)
- [ ] 打开 select → 无 `# modal:` 行(role=listbox 非 aria-modal)
- [ ] 候选选项正常前置召回(走 overlay-priority,baseline 不破)

### 7. 嵌套对话框
- [ ] dialog 内嵌 dialog(两层 aria-modal=true)→ 仅内层被识别为 active modal,外层被裁剪

## bench 全量回归

待 `pnpm --filter vortex-bench run --all` 跑全量回归,核对:
- antd overlay-priority DEFECT-1 case 不被模态判据误伤
- Cascader portal / select-v2 虚拟列表等既有 case 通过率零下降
- 新 fixture `modal-scope-suppress-background` recall ≥ 4/4

## 截图归档

待人工跑活浏览器后追加,目录:`reports/dogfood-element-plus-a11y-2026-06-26/screenshots/`。

## 结论

待人工验证后填入。