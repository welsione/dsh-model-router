# Changelog

## 0.0.7 (2026-08-25)

- **修复 - `reasoningEffortsFallback` 被面板保存重置**：面板此前未处理该字段（load/canonicalCfg 均缺失），保存时后端 schema 填默认 `['low','medium','high']` + `settings.replace` 整段替换 → 用户自定义的兜底档位集被静默重置。与 manualTiers 同源问题，同方案修复：服务端 `validateSection` 在 body 未携带时保留现有值；前端 load/canonicalCfg/baselineRef 补上该字段。
- **修复 - 流自然结束（无 finish chunk）时缺 served 事件与健康度记录**：`routeThrough` 的 `normalEnd` 分支此前直接 `return`，导致 OverlayStatus 卡在「请求中」高亮、健康度漏记成功。现补记 served 事件 + `markHealth(true)`（罕见路径：正常适配器都会发 finish）。
- **修复 - 档位徽章与模型徽章不一致（NPC 档显示夯档的 glm-5.3 + max）**：`OverlayStatus` 的模型名取自**最新路由事件**（`latest.try/by`，可能是历史/其他档位请求的残留），而思考级别取自**当前档位配置反查**——两个数据源不同步会拼出配置里不存在的组合（如档位 NPC 但显示夯档的 `zai-coding-cn/glm-5.3`，且 `max` 徽章其实来自 NPC 档首候选 deepseek-v4-flash 的配置）。修复两点：
  1. **effort 与模型名同源**：路由事件（started/served）新增 `effort` 字段（记录候选真实 `reasoningEffort`），前端优先取 `latest.effort`，与 `full` 永远来自同一候选；
  2. **历史残留兜底**：若最新事件的候选**不属于当前档位链**（手动档位已切走、事件是历史残留），则显示「当前档位（手动档或默认 tier2）首候选 + 其 effort」，与 PackageSelect 档位徽章一致。cfgInfo 反查新增 `effSlot/slotChain/effFirst` 字段支撑判断。

## 0.0.6 (2026-08-25)

- **新功能 - 瞬时错误重试（feature: retry-on-throttle）**：限流/配额/服务端/超时/传输/空响应等**瞬时错误**不再「立刻冷却并切换候选」——先对**同一候选**短暂等待后重试（默认最多 2 次，间隔 1s/2s 线性退避），大概率能恢复；重试耗尽才进冷却并切换。AUTH/未知模型等**配置类错误**不重试（重试无意义），直接走现有 failover。只有「首 token 前失败」才重试；已输出内容后失败 → 透传/上抛，不重试（避免内容重复）。新增配置 `retryOnThrottle`（默认 true）/ `maxRetriesPerCandidate`（默认 2，0-5）/ `retryBackoffMs`（默认 1000），设置面板新增「瞬时错误重试」开关 + 重试次数/间隔输入框。核心函数 `isTransientFailure` 与可转移判定 `isRetryableFailure` 分离（后者含配置类，前者只含瞬时类），带单测覆盖。

## 0.0.5 (2026-08-25)

- **修复 - 模型徽章在 agent 工具循环中高频闪烁（二次修复）**：0.0.4 统一了两条路径的 active 判定，但「高亮跟随单个请求 started→served 亮灭」在 agent 场景下本身仍是闪烁源——agent 每步工具调用都是一对请求，徽章每步亮一次灭一次。本次改为**高亮恒定**：有路由状态即恒亮（`dsh-mr-overlay-active`），仅 `all-failed` 显示红色错误态；移除 active state 与 setActive 调用。请求开始/完成不再引起任何样式切换。
- **修复 - 手动档位被面板自动保存清空（夯自动变 NPC）**：设置面板保存的 body 不携带 `manualTiers`（会话手动档位由 `/api/model-router/tier` 的 mutate 路径维护），而 schema 对缺失字段填默认 `{}`，`settings.replace` 整段替换后手动档位被清空——表现为「明明选了夯(tier3)，改一次面板配置（任何自动保存）后就自动变回 NPC(tier2 默认档)」。修复双保险：服务端 `validateSection` 在 body 未显式提供 `manualTiers` 时保留现有持久化值；前端 `doAutoSave` 提交时从 state 快照原样回传 `manualTiers`（canonicalCfg 比对不含该字段，不会触发保存循环）。
- **改进 - 面板「冷却中的候选」展示失败原因**：冷却记录从单一时间戳升级为 `{until, durationMs, code, status, streak}`，面板每条冷却显示失败原因（如 `RATE_LIMIT HTTP 429`）+ 剩余时间，悬浮显示连续失败次数与本次冷却时长。空态提示补充冷却机制说明（分级冷却 + 指数退避 + 过期自动清理）。之前「看不到冷却」的直接原因：0.0.4 分级冷却后限流类仅 60 秒、服务端类 150 秒，过期条目在下次请求遍历时被清理，打开面板时常已清空——这不是冷却失效，是冷却变短了。

## 0.0.4 (2026-08-25)

- **修复 - 对话窗口模型徽章高亮抖动**：`OverlayStatus`（显示 `provider/model + 思考级别`，如 `opencode-go/deepseek-v4-flash high`）有两条更新路径——session 事件流（实时）与 2 秒轮询兜底——它们对 `active`（高亮）的判定互相矛盾：事件流「历史里出现过 started 就恒高亮」，轮询「最新事件是 started 才高亮」。请求完成瞬间事件流设高亮 → 2 秒后轮询变灰 → 下个请求又高亮，视觉上每 2 秒闪烁。修法：两条路径统一为「取最新一条状态事件（started/served/all-failed），active = 最新事件是 started」；同时跳过 `manual-tier` 事件（它不携带 try/by，作为最新状态会把显示清空导致徽章消失又出现）。请求开始高亮一次、完成熄灭一次，不再闪烁。
- **优化 - 分级冷却 + 指数退避（feature: cooldown-grading）**：冷却不再一刀切。按失败类型分级——AUTH/未知模型等「硬失败」用满额基础时长；服务端/超时/传输（SERVER/TIMEOUT/TRANSPORT/5xx）按 0.5 倍；限流/配额/空响应（RATE_LIMIT/QUOTA/429/EMPTY_RESPONSE）按 0.2 倍。连续失败按 `cooldownBackoff^(连续失败次数)` 指数退避，封顶 `cooldownMaxMs`（默认 30 分钟）。新增配置 `cooldownMaxMs` / `cooldownBackoff`（cooldownMs 语义变为「基础时长」，兼容旧配置）；设置面板新增「冷却退避」「冷却封顶」输入框。
- **修复 - `isRetryableFailure` 对 429/408 的判定矛盾**：此前 `status >= 500` 才可转移，429（限流）与 408（请求超时）被排除——首个候选被限流时整个请求直接失败。现 429/408 视为可转移（瞬时可恢复类），与 `RATE_LIMIT`/`TIMEOUT` 错误码语义一致。
- **优化 - 健康度择优升级（时间衰减 + 错误码加权）**：评分从「窗口内 ok - 2×fail 计数」改为逐记录**指数时间衰减**（半衰期 5 分钟，最近结果权重高、陈旧结果快速失效）加**错误码加权**（服务端/网络类失败 -3、限流/配额类 -1、其余 -2）。候选「刚恢复」或「刚劣化」能更快反映到排序；面板健康度数据新增 `streak`（连续失败次数）。

## 0.0.3 (2026-08-24)

- **修复 - client bundle 加载报错 `loaded without registering`**：`lib/client.js` 里 `window.__ModuleLoader__.load` 的 `id` 原本是短名 `dsh-model-router`，但 DSH web 的 client-modules Loader 以**完整包名**注册/校验 factory（官方 client bundle 均用 `@deepseek-ai/...` 全名），导致 bundle 加载后找不到对应注册 → 启动时报 `Failed to load plugins / loaded without registering "@welsione/dsh-model-router"`。改为 `id: '@welsione/dsh-model-router'` 后正常注册。已用 dsh-plugin-developer 复验：check 93/100 (A) + 运行级 test（打包→安装→层生效→启动冒烟→卸载）全 PASS。

## 0.0.2 (2026-08-23)

- **修复 - cordis.patch.yml 的 scoped 包名未加引号导致 YAML 解析失败**：`name: @welsione/dsh-model-router` 中 `@` 是 YAML 锚点字符，patch 解析失败 → `dsh plugin add` 安装后 bundle 层不生效。改为 `name: "@welsione/dsh-model-router"`。已用 dsh-plugin-developer 复验：check 100/100 (A) + 运行级 test 全 PASS。**0.0.1 已从 npm 上的损坏状态被 0.0.2 取代。**

## 0.0.1 (2026-08-21)

- **改名 - npm 包名改为 `@welsione/dsh-model-router`**：npm 上 `dsh-model-router` 已被其他发布者占用（`thedeveloper256` 的 `@0.6.2`），无法以原名发布。改为 scoped 包 `@welsione/dsh-model-router`（`package.json` 加 `publishConfig.access: public`）。安装/卸载命令同步改为 `dsh plugin --profile web (add|remove) @welsione/dsh-model-router`；`cordis.patch.yml` 的 `name` 字段同步更新（插件内部 `id`/`export const name` 保持 `dsh-model-router` 不变，与 scoped 插件惯例一致，如 `@deepseek-ai/dsh-llm-pi-ai` → `llm-pi-ai`）。
- **移除 - 流级思考标签剥离逻辑**：`makeThinkingTagStripper`（`lib/core.mjs`）、`lib/index.js` 中 `routeThrough` 对 `text-delta` 的 `stripThinking` 变换、配套单测与 `probe-stream.mjs` 复现脚本全部删除。理由：路由插件的职责是「选路 + 首 token 前故障转移」，输出内容改写（剥离 `<thinking>` 等标签）属于供应商适配层（llm-pi-ai adapter）的职责，不属于本插件。现在 `routeThrough` 对流只做**透传 + 观察**（`sawContent` / `finish` 判定），不再改动任何 chunk 内容；`replayState` 清洗保留（跨 provider 路由必需）。README「会话安全」行同步去掉「流级剥离 `<thinking>` 标签」。
- **实时自动保存（去掉「保存全部」按钮）**：设置面板的任何修改（档位名称、候选链、全局参数、总开关等）去抖 600ms 后自动写入配置并即时生效，无需手动点保存；面板右下角显示保存状态（「保存中… / 修改自动保存 · 已保存 HH:MM:SS」），失败时红色提示。用「本地草稿 vs 服务端基线」的规范形比对避免保存回写形成循环，保存期间的新修改会在完成后自动补存。
- **套餐选择菜单宽度按内容自适应**：对话窗口「套餐 · 档位」下拉菜单去掉 `min-width: 280px` 强制宽度，改为 `width: max-content` 贴合内容（保留 max-width 上限防超长套餐名撑爆）。
- **去除档位名称重复展示**：删除路由卡片顶部的「档位名称」胶囊区，编辑能力合并到各档位区块标题的可编辑胶囊（点击区块标题胶囊就地改名，Enter 提交 / Esc 取消 / 清空恢复默认），档位名每处只出现一次。
- **档位名称胶囊点击即编辑**：设置面板的档位名称从「标签 + 输入框」改为彩色胶囊，点击胶囊就地变为输入框（自动聚焦并全选），Enter 提交、Esc 取消、失焦兜底提交，清空恢复默认名。
- **档位名称支持每套餐独立设置**：`tierNames` 从全局配置改为每个路由套餐单独配置（`routes.<id>.tierNames`），对话窗口套餐选择器按套餐展示各自的档位显示名；未设置的档位回退默认（pro/normal/lite）。
- **UI 文字精简（web-design-guidelines Content & Copy）**：减少页面文字密度，把解释性说明移到鼠标悬浮框（`title`）：
  - 副标题长文 → 一行「统一模型路由 · 故障转移 · 思考级别」，详细说明移入悬浮框
  - 「失败冷却（毫秒，5 分钟 = 300000）」→「失败冷却」；「单步最多切换候选次数」→「最多切换」；「健康度择优（稳定成功…频繁失败…）」→「健康度择优」——解释均移入悬浮框
  - 「已停用（全部放行）」→「已停用」；模型能力卡片「写回宿主 llm-pi-ai，热重载生效」移入悬浮框
  - 路由统计「N 请求 / M 切换（切换率 X%）」→「N 请求 · 切 M」，切换率详移入悬浮框
  - 路由/候选/供应商空态长句 → 「暂无套餐」「空」「暂无自定义供应商」等，说明移入悬浮框

## 1.3.7 (2026-08-21)

- **UI 合规优化（web-design-guidelines）**：
  - 「+ 添加档位」弹层（思考级别选择器）现支持**点击外部关闭**（document mousedown 监听，点击非 `.dsh-mr-caps-pickwrap` 区域即收起）与 **Escape 关闭**（keydown 监听），符合「弹层/模态需可键盘/外部关闭」规范。
  - 统计与提示文本（请求数/切换数/切换率等 `.dsh-mr-hint`）补 `font-variant-numeric: tabular-nums`，数字列对齐。
  - 复核全量 a11y：所有交互元素均有 `:focus-visible` 焦点环（含新 chip/pick/pickitem）；表单输入 `name`/`autocomplete`/`inputMode` 齐全；`transition` 均列出具体属性（无 `transition: all`）；动效尊重 `prefers-reduced-motion`。

## 1.3.6 (2026-08-21)

- **修复 - 路由思考级别下拉只显示部分档位**：用户在「自定义供应商模型能力」卡片配置了全部思考级别档位，但统一模型路由里同一模型的下拉只显示宿主认可的档位（如 anthropic-messages adapter 把 reasoningEfforts 裁剪成 `off/low/medium/high`，xhigh/max 等被丢弃）。
- **根因**：`resolveEffortsFor` 只用 `ctx.llm.resolveModelInfo` 返回的 `reasoning.efforts`（宿主裁剪后的档位），未合并用户在 llm-pi-ai 配置的 reasoningEfforts。
- **修复**：新增 `configuredEffortsFor(provider, model)` 读取模型在 llm-pi-ai 配置里的 reasoningEfforts 档位，`resolveEffortsFor` 做「宿主认可 ∪ 用户配置」合并——用户显式配置的档位即使被宿主裁剪也保留在下拉。保存时 `validateSection` 仍会 `resolveCallConfig` 预检，宿主真正不支持的档位保存即拒。
- **验证**：deepseek-v4-flash 配置 7 档保存后，路由下拉显示默认+Off/Minimal/Low/Medium/High/Xhigh/Max（此前只有 Off/Low/High/Max）✅。

## 1.3.5 (2026-08-21)

- **UI 重构 - 思考级别改为胶囊 + 选择器弹层（tag-input 多选）**：按用户参考的形态重做——`思考级别` 一行排开：`[+ 添加档位 ▾]` 按钮 + 已选档位胶囊 `{low ×} {high ×}`。
  - **胶囊**：已选档位显示为圆角胶囊（档位名 + × 按钮），点 × 移除；wire 值与档位名相同时不显示输入框（保持 `{low ×}` 简洁），不同时才在胶囊内显示可编辑 wire 输入。
  - **选择器**：`+ 添加档位` 是按钮（非原生 select），点击弹出自定义列表（`role=listbox`），列出全部档位，已添加项标 ✓ + 高亮（点它 = 移除，即 toggle），未添加项点它 = 添加。
  - 弹层绝对定位 + z-index、`aria-haspopup`/`aria-expanded`、Escape 可收起。
- **替代了** 1.3.4 的原生 `<select>` 下拉（已添加项禁用、点标签删除）——交互更直观：胶囊 × 删除 + 列表点选添加/移除。

## 1.3.4 (2026-08-21)

- **修复 - 已选思考级别档位无法取消**：模型能力卡片的思考级别标签此前只能点 × 移除，点标签本身无反应。现标签整体可点击（或按 Enter/Space）移除档位，wire 输入框内点击不触发（stopPropagation）；标签补 `role="button"` + `aria-label` + 焦点态 + hover 反馈。
- **改进 - 「+ 添加档位」下拉改为 toggle**：下拉里已添加的档位不再禁用（此前是灰色点不动，用户以为没法取消），改为「已添加，选择移除」——选择即移除该档位，选择未添加项即添加，选择后自动重置回「+ 添加/移除档位」。加上点标签 / 点 ×，共三种取消方式。
- **修复 - 模型能力更新后路由思考级别下拉不刷新**：未保存候选经惰性查询缓存（`extraEfforts`）后，模型能力卡片更新该模型档位并保存时**未清空缓存**，路由下拉仍显示旧档位。现 `saveCapability` 保存成功后清空该候选的 `extraEfforts`/`fetchingEfforts` 缓存，强制重新查询真实能力；已保存候选的 `efforts` 仍随 `load()` 每次刷新，模型能力更新后下拉即时反映新档位。
- **验证**：点标签移除档位 ✅；从下拉选择已添加项移除 ✅；已保存候选在模型能力加档位保存后，路由下拉即时出现新档位 ✅。

## 1.3.3 (2026-08-21)

- **UI 优化 - 模型能力卡片两行布局**：「自定义供应商模型能力」卡片的每个模型行改为明确两行：第一行 `contextWindow` + `maxTokens` 并排（grid 2 列）；第二行「思考级别」整体一行排开——已选档位标签（`nowrap`，超宽横向滚动）+ 右侧「+ 添加档位」下拉。相比之前 7 个胶囊 flex-wrap 或标签换行，垂直空间大幅压缩。
- **修复**：`off` 档位（值为 null，语义「支持但不发送 wire」）此前被判定为未启用而过滤；现改为「键存在即已启用」，off 添加后正确显示为无 wire 的标签、下拉标「已添加」。

## 1.3.2 (2026-08-21)

- **UI 优化 - 思考级别编辑改为胶囊选择器**：「自定义供应商模型能力」卡片的 `reasoningEfforts` 编辑区从 7 行 checkbox+wire 网格改为**胶囊（chip）选择器**：档位是一排可点胶囊，未选中为幽灵态（描边），选中为品牌色高亮填充；选中的胶囊内嵌可编辑 wire 输入框（点击聚焦修改，blur 保留）。`off` 档位选中时不显示 wire（wire 恒为 null）。视觉紧凑现代，贴合现代设置面板形态。
- **可访问性**：胶囊是 `role="button"` + `tabIndex` + `aria-pressed` + `onKeyDown`（Enter/Space 切换）；wire 输入框 `onClick/onKeyDown` stopPropagation 避免误触发胶囊切换。

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
