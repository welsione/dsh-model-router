# Changelog

## 1.1.0 (2026-08-21)

- **新功能 - 健康度择优**：每个候选维护滑动窗口内成功/失败计数，候选链按健康度重排（稳定成功提前、频繁失败后移），默认开启（`healthRanking`，窗口大小 `healthWindowSize`）。面板全局设置可一键关闭恢复纯配置顺序。
- **新功能 - 按统一 ID 统计面板**：`/api/model-router/state` 新增 `health` 字段；面板每个路由头展示请求数 / 切换数 / 切换率，每个候选行展示 ✓成功 / ✗失败健康标（悬停看窗口大小）。
- **可访问性打磨（客户端）**：总开关改为 `<button role="switch">`（原生键盘可操作）；供应商/模型/思考级别下拉与图标按钮补 `aria-label`；`outline: none` 全部补 `:focus-visible`；保存提示加 `aria-live="polite"`；下拉菜单加 `overscroll-behavior: contain`；动效尊重 `prefers-reduced-motion`。
- **测试**：`tests/core.test.mjs` 新增健康度评分/择优的纯函数用例（24 个用例全绿）。

## 1.0.0 (2026-08-20)

- **安装形态**：补齐 `dsh.bundle` manifest + `cordis.patch.yml` —— 现在可通过 `dsh plugin --profile <name> add dsh-model-router`（或 tarball / npm）一键安装并被收录进插件市场；`dsh.client` 有配套 bundle（此前只有 client，不可安装）。
- **结构**：路由/选档/降档/错误判定/思考标签剥离/replayState 清洗等纯逻辑抽取到 `lib/core.mjs`，`lib/index.js` 保持接线；宿主入口改为命名导出（name/inject/apply）。
- **修复**：修复路由流中思考标签剥离未实际应用、且引用未定义 `cleanChunk` 的潜在崩溃（每次正常完成都会 `ReferenceError`）。
- **工程卫生**：新增 `tests/core.test.mjs`（node:test 单测，覆盖选档/降档/错误转移/标签剥离/replayState 清洗）；`package.json` 补依赖声明（peerDependencies 用正确的预发布 `\|\|` 分支）、`files` 白名单、`repository`、`engines`、`keywords`，去掉 `private` 以便发布；`.gitignore` 补 `.dsh/`、`*.tgz`。
- **文档**：README 补齐 9 小节 + 安装/卸载示例 + 权限声明；新增 `README.en.md`。
