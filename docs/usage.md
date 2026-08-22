# dsh-model-router 使用文档（Usage）

> 这是 README 门面的完整细节页：快速开始、配置表、模型能力写回、面板 API 与故障排查。功能总览看 [README](../README.md)。

## 快速开始

1. 安装：`dsh plugin --profile web add dsh-model-router`（卸载 `… remove …`）。
2. 打开 设置 → 模型路由，添加统一 ModelID（如 `deepseek-v4-flash`），为 tier1/2/3 各配候选（`provider + model` + 可选 `reasoningEffort`）。
3. **修改自动保存、即时生效**：任何改动去抖 600ms 后自动写入配置，无需点保存按钮；右下角显示保存状态，失败时红色提示。
4. 或在对话窗口的套餐选择器里选中已配置好的套餐；选中后路由按候选链自动故障转移。

最小配置示例（settings 的 `model-router` 段）：

```yaml
model-router:
  enabled: true
  cooldownMs: 300000
  maxSwitchesPerStep: 3
  healthRanking: true      # 健康度择优（稳定成功的候选优先）
  routes:
    deepseek-v4-flash:      # 统一逻辑 ModelID
      tierNames: { tier3: 旗舰 }   # 可选：该套餐的自定义档位显示名
      tier1:                # 轻量：压缩 / 标题
        - { provider: opencode-go, model: mimo-v2.5, reasoningEffort: low }
      tier2:                # 标准：主对话
        - { provider: volcengine, model: deepseek-v4-flash }
        - { provider: opencode-go, model: deepseek-v4-flash }
      tier3:                # 强大：重任务
        - { provider: opencode-go, model: deepseek-v4-pro, reasoningEffort: high }
  # 兼容旧字段：simple → tier1, complex → tier2
```

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| enabled | true | 总开关；false 时全部放行原路径 |
| cooldownMs | 300000 | 失败候选冷却时长（ms） |
| maxSwitchesPerStep | 3 | 每个 step 最多切换候选次数（1-10） |
| healthRanking | true | 健康度择优：按滑动窗口内成功/失败重排候选链（稳定成功提前、频繁失败后移） |
| healthWindowSize | 8 | 每个候选健康度统计的滑动窗口大小（3-30） |
| reasoningEffortsFallback | ["low","medium","high"] | 目录未标注推理能力的候选，允许手动选择的思考级别候选集。保存/面板时用实际请求预检 `resolveCallConfig` 过滤，只保留宿主真正接受的档位。默认取 models.dev 最常见档位，可自定义如 ["none","minimal","low","medium","high","xhigh","max"]，设 [] 关闭兜底 |
| routes | {} | 统一 ModelID → { tier1/2/3: [候选] } |
| routes.<id>.tierNames | {} | 该套餐的自定义档位显示名：tier1/tier2/tier3 → 显示名（如 `{tier3: 旗舰}`）；缺省回退 pro / normal / lite。同名档位只展示一次；设置面板彩色胶囊点击即改名（Enter 提交 / Esc 取消 / 清空恢复默认） |
| manualTiers | {} | sessionId → 手动档位（面板写入，跨重启保留） |

每个候选：`provider`（必填）、`model`（必填）、`reasoningEffort`（可选，保存时校验模型支持）。

### 模型能力（写回宿主 llm-pi-ai · 仅自定义供应商）

面板「自定义供应商模型能力」卡片列出宿主 `llm-pi-ai` 中**自定义（hand-declared）供应商**的模型，可逐模型编辑 `reasoningEfforts`（思考级别档位 + wire 值）、`contextWindow`、`maxTokens` 并保存。插件用全局 `ctx.settings` 深合并写回 `llm-pi-ai` 命名空间（只改目标 provider/model，其余配置保留），llm-pi-ai 的 onChange 热重载 adapter，**无需重启即生效**。

- **仅自定义供应商可写**：只对 `ctx.llm.listConfigurableProviders()` 中 `declared === true`（pi-ai 不内置的 gateway/self-hosted）开放；内置目录供应商被过滤 / 拒绝，其能力由宿主模型目录管理。
- 典型用途：`volcengine-mian/deepseek-v4-flash` 这类 hand-declared 模型（settings 里只有 `id/name`）不声明 `reasoningEfforts` 时，宿主 pi-ai 判定其不支持推理，任何思考级别都会被拒。在卡片声明档位（如 `off`/`low`/`medium`/`high`）写回后，该模型立即可配思考级别。

### 面板 API（同源 `webServer`）

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/model-router/state` | 配置 + 模型目录 + 思考级别 + 冷却 + 事件历史 + 统计 + 每候选健康度 |
| POST | `/api/model-router/save` | 整段保存（校验模型存在性与思考级别；面板自动保存即调此接口） |
| POST | `/api/model-router/cooldowns/clear` | 清空全部冷却 |
| POST | `/api/model-router/tier` | 设置 / 清除会话手动档位 |
| GET | `/api/model-router/model-capabilities` | 读宿主 `llm-pi-ai` 的 provider/models 能力（reasoningEfforts/contextWindow/maxTokens） |
| POST | `/api/model-router/model-capabilities` | 写回某 provider/model 的能力（深合并，热重载生效） |

## 故障排查

- **设置页没有「模型路由」卡片** → 确认 `dsh` 版本 ≥ 0.1.0-rc.6，且插件已作为 bundle 安装（`dsh --profile web --dump-config | grep model-router` 应有该行）。
- **面板报「候选不存在于当前模型目录」** → 先在该 provider 下确认模型 id 拼写，或重新保存让目录刷新。
- **面板提示「自动保存失败：…」** → 多为思考级别校验未过（候选不支持该档位），按提示换档位或留空；修复后下一次修改会自动重试保存。
- **全部候选失败 / 一直切换** → 查 `GET /api/model-router/state` 的 `cooldowns` 与 `history`；多为限流/配额，等冷却或「全部清除」。
- **会话打不开 / 一直失败在第 1 步** → 可能是历史里已有跨 provider 的旧 `replayState` 污染；本插件在下次请求时自动清洗，新请求自愈。
- **想手动切档** → 对话窗口「套餐」下拉里点 pro / normal / lite（或该套餐的自定义档位名），持久化到 settings，重启保留。

## 已知限制

- 冷却期为内存态，重启丢失（可接受：主要防同机会话内反复打失败 provider）。
- 手动档位持久化上限 500 条会话，超出自动淘汰最早条目。
- 思考档位支持矩阵依赖各 provider 实际行为，保存时按模型目录校验。
- 自动保存为去抖（600ms）后写入：连续修改会在停止输入后一次性落盘，不会每个按键都写一次。