# Changelog

## 1.3.1 (2026-08-21)

- **修复 - 未保存候选误报「不支持思考级别」**：面板里新加（未保存）的候选此前不显示思考级别档位——因为 `buildEfforts` 只对已保存候选计算档位，未保存的新候选 `efforts[key]` 为空，下拉被禁用并误标「不支持思考级别」，即使该模型在「自定义供应商模型能力」卡片里已声明 reasoningEfforts（如 `volcengine-mian/glm-5.3`）。
- 新增 `GET /api/model-router/efforts?provider=&model=` 单候选档位查询（目录标注 verified=true；未标注用兜底档位逐个 `resolveCallConfig` 实测）。面板 `effortOptions` 惰性查询：未保存候选发起单候选查询，查询中显示「检测中…」（不误报），返回后实时显示真实档位；已保存候选仍走 `state.efforts`。
- **验证**：面板把未保存候选设为 `volcengine-mian/glm-5.3`，下拉实时显示 `Off/Low/High/Max`（verified），不再「不支持思考级别」。

## 1.3.0 (2026-08-21)

- **新功能 - 自定义供应商模型能力卡片（写回宿主 llm-pi-ai）**：面板新增「自定义供应商模型能力」卡片，列出宿主 `llm-pi-ai` 中**自定义（hand-declared）供应商**的模型，可逐模型编辑 `reasoningEfforts`（思考级别档位 + wire 值）、`contextWindow`、`maxTokens` 并保存。插件用全局 `ctx.settings` 深合并写回 `llm-pi-ai` 命名空间（只改目标 provider/model，其余配置保留），llm-pi-ai 的 onChange 热重载 adapter——**无需重启即生效**，面板思考级别下拉与路由预检立即反映新能力。
- **仅自定义供应商可写**：模型能力编辑只对 `ctx.llm.listConfigurableProviders()` 中 `declared === true`（pi-ai 不内置、完全由配置声明的 gateway/self-hosted）的供应商开放；内置目录供应商被 GET 过滤、POST 拒绝（403），其能力由宿主模型目录管理。这避免了本插件改写宿主内置目录。
- **这解决了「为什么有的模型不支持思考级别」**：volcengine-mian 等 hand-declared 模型此前不声明 `reasoningEfforts`，宿主 pi-ai 判定其不支持推理（`reasoning: false`），因此任何 effort 都被拒。现在可在卡片直接声明档位（如 `off`/`low`/`medium`/`high`），写回后模型立即可配思考级别。
- **后端**：新增 `GET/POST /api/model-router/model-capabilities`（读 `llm-pi-ai` 原始配置 / 深合并写回，仅允许 contextWindow/maxTokens/reasoningEfforts 字段，且仅限自定义供应商）。
- **UI 合规优化（web-design-guidelines）**：表单输入补 `name`/`autocomplete="off"`/`inputMode`；代码 token（wire 值、统一模型 ID）补 `spellCheck={false}` + `translate="no"`；健康计数/冷却剩余用 `font-variant-numeric: tabular-nums`；面板 `touch-action: manipulation` + `-webkit-tap-highlight-color: transparent`；时间戳改用 `Intl.DateTimeFormat`；标题/副文本 `text-wrap: balance`/`pretty`；保存/写回错误信息附下一步指引（换档位 / 内置供应商去宿主 Models 页 / 至少勾选一个 off 之外的档位）。

## 1.2.0 (2026-08-21)

- **新功能 - 思考级别兜底（reasoning-efforts-fallback）**：目录未标注推理能力的候选，之前下拉被禁用且保存被拒；现在默认提供 `low/medium/high` 兜底档位（参考 models.dev 全量数据中出现频率最高的档位集），可手动选择并透传供应商（UI 标注「手动·未验证」）。兜底集可通过 `reasoningEffortsFallback` 自定义（如完整集 `none/minimal/low/medium/high/xhigh/max`，设 `[]` 关闭）。目录已标注的候选仍严格校验档位。
- **预检（实际请求）**：保存思考级别时改用 `ctx.llm.resolveCallConfig` 做实际能力预检——宿主在 provider I/O 之前拒绝不支持的显式 effort（`UNSUPPORTED_REASONING_EFFORT`），不支持的档位在**保存时**即被拒绝并给出明确报错，不再等到运行时才失败。面板思考级别下拉同样按预检结果过滤：目录未标注的候选逐个实测兜底档位，只保留宿主真正接受的档位；完全不被接受的模型显示「不支持思考级别」（此前会让用户选了运行时才报错的档位）。
- **测试**：`tests/core.test.mjs` 新增 `effortsForCandidate` / `validateReasoningEffort` 纯函数用例（30 个用例全绿）。

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
