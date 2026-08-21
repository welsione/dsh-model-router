# dsh-model-router

DeepSeek Harness (DSH) 统一模型路由插件 —— 一个逻辑 ModelID 对应多个供应商的同名模型，按候选链自动路由、故障转移与三档分级。带设置页管理面板与对话窗口实时状态。

[English](README.en.md)

## Overview / 简介

解决的问题：多家供应商提供同名模型（如 `deepseek-v4-flash` 在火山引擎与 OpenCodeGo），手动切换麻烦、单点失败影响体验。

做法：把多个 `provider/model` 候选池配置成一个逻辑 ModelID（**统一 ModelID**），对调用方透明。

- **自动故障转移**：主候选首 token 前失败（限流 / 配额 / 认证 / 网络 / 模型不存在 / 空响应）自动切下一候选；失败候选进入冷却期（可配置时长），每步切换次数受限。
- **健康度择优**：每个候选维护滑动窗口内的成功 / 失败计数，稳定成功的候选自动提前、频繁失败的候选自动后移（面板可见每候选的 ✓/✗ 健康标）——比纯固定顺序更智能，可一键关闭。
- **三档分级**（对标 Claude Haiku / Sonnet / Opus）：`tier1` 轻量（压缩 / 标题）· `tier2` 标准（主对话）· `tier3` 强大（重任务）；按 `purpose` 自动选档，选中档为空时逐级降档；支持会话级手动档位（持久化）。
- **思考级别**：每个候选可配 `reasoningEffort`（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`），面板可配置，保存时校验模型真实支持。
- **管理面板**：DSH 设置页内置「模型路由」卡片 + 对话窗口输入工具行的实时路由状态；每个统一 ID 展示请求数 / 切换数 / 切换率统计与每候选健康标。
- **会话兼容**：注册自定义会话事件类型（含路由事件的会话可恢复）；跨 provider / 模型切换自动清洗历史 `replayState`，避免 `INVALID_REPLAY_STATE` 污染；流级剥离思考包裹标签（`<thinking>` 等，支持跨 chunk 拆散）。

## Compatibility / 兼容性

- DeepSeek Harness：`0.1.0-rc.x`（在 `0.1.0-rc.8` 实测）；依赖以 `peerDependencies` 声明（cordis ≥4、dsh-session/settings/client-ui-* 0.1.0-rc 线）。
- Node.js ≥ 22（Web 端 React 18/19）。
- 最后验证日期：2026-08-20。

## Install / Uninstall · 安装 / 卸载

支持标准 Profile Bundle 安装（**从 1.0.0 起**，此前仅本地 profile 挂载）：

```sh
# 从 npm（发布后）
dsh plugin --profile web add dsh-model-router
# 或本地 tarball 验证
cd dsh-model-router && npm pack
dsh plugin --profile web add ./dsh-model-router-1.1.0.tgz
# 卸载
dsh plugin --profile web remove dsh-model-router
```

装好之后，在设置页出现「模型路由」卡片；对话窗口的模型选择器替换为「套餐」选择器（含三档切换）。

## Quick start / 快速开始

1. 安装（见上）。
2. 打开 设置 → 模型路由，添加统一 ModelID（如 `deepseek-v4-flash`），为 tier1/2/3 各配候选（`provider + model` + 可选 `reasoningEffort`），保存即生效。
3. 或在对话窗口的套餐选择器里传入已配置好的套餐；选中后路由按候选链自动故障转移。

最小配置示例（settings 的 `model-router` 段）：

```yaml
model-router:
  enabled: true
  cooldownMs: 300000
  maxSwitchesPerStep: 3
  healthRanking: true      # 健康度择优（稳定成功的候选优先）
  routes:
    deepseek-v4-flash:      # 统一逻辑 ModelID
      tier1:                # 轻量：压缩 / 标题
        - { provider: opencode-go, model: mimo-v2.5, reasoningEffort: low }
      tier2:                # 标准：主对话
        - { provider: volcengine, model: deepseek-v4-flash }
        - { provider: opencode-go, model: deepseek-v4-flash }
      tier3:                # 强大：重任务
        - { provider: opencode-go, model: deepseek-v4-pro, reasoningEffort: high }
  # 兼容旧字段：simple → tier1, complex → tier2
```

## Configuration / 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| enabled | true | 总开关；false 时全部放行原路径 |
| cooldownMs | 300000 | 失败候选冷却时长（ms） |
| maxSwitchesPerStep | 3 | 每个 step 最多切换候选次数（1-10） |
| healthRanking | true | 健康度择优：按滑动窗口内成功/失败重排候选链（稳定成功提前、频繁失败后移） |
| healthWindowSize | 8 | 每个候选健康度统计的滑动窗口大小（3-30） |
| routes | {} | 统一 ModelID → { tier1/2/3: [候选] } |
| manualTiers | {} | sessionId → 手动档位（面板写入，跨重启保留） |

每个候选：`provider`（必填）、`model`（必填）、`reasoningEffort`（可选，保存时校验模型支持）。

面板 API（同源 `webServer`）：

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/model-router/state` | 配置 + 模型目录 + 思考级别 + 冷却 + 事件历史 + 统计 + 每候选健康度 |
| POST | `/api/model-router/save` | 整段保存（校验模型存在性与思考级别） |
| POST | `/api/model-router/cooldowns/clear` | 清空全部冷却 |
| POST | `/api/model-router/tier` | 设置 / 清除会话手动档位 |

## Permissions & data / 权限与数据

- **网络**：不对外部服务发任何请求；仅复用宿主 `llm` 服务（使用你已配置的供应商/模型目录）与同源本机 Web UI 面板接口。
- **文件/数据**：不读写工作区文件、不上报遥测；运行时状态（冷却、历史、统计）为内存态，手动档位写入宿主 settings（同 profile 配置）。
- **凭据**：不接触 API key；模型凭据由宿主各 provider 自行管理。

## Troubleshooting / 故障排查

- 设置页没有「模型路由」卡片 → 确认 `dsh` 版本 ≥ 0.1.0-rc.6，且插件已作为 bundle 安装（`dsh --profile web --dump-config | grep model-router` 应有该行）。
- 面板报「候选不存在于当前模型目录」→ 先在该 provider 下确认模型 id 拼写，或重新保存让目录刷新。
- 全部候选失败 / 一直切换 → 查 `GET /api/model-router/state` 的 `cooldowns` 与 `history`；多为限流/配额，等冷却或「全部清除」。
- 会话打不开 / 一直失败在第 1 步 → 可能是历史里已有跨 provider 的旧 `replayState` 污染；本插件默认在下次请求时自动清洗，升级到 1.0.0 后新请求自愈。
- 想手动切档 → 对话窗口「套餐」下拉里点 pro/normal/lite（持久化到 settings，重启保留）。

## Development / 开发

```sh
npm test                 # 单元测试（node:test，零依赖：tests/core.test.mjs）
node test-model-reasoning.mjs   # 思考档位实测脚本（需配置供应商密钥）
# 发布前四连
npm run typecheck 2>/dev/null || true   # JS 无类型检查；见 npm test
npm test && npm pack --dry-run
```

- 纯逻辑在 `lib/core.mjs`（可单测、无 dsh 依赖）；`lib/index.js` 只做接线（llm/stream 拦截、面板 API、settings 集成）；`lib/client.js` 是 Web 前端（设置面板 + 套餐选择器 + 实时状态）。
- 结构与合规可用本 skill 的自检：`node <dsh-plugin-developer>/scripts/check.mjs .` 与 `node <dsh-plugin-developer>/scripts/test.mjs .`（需 dsh 在 PATH）。

## License & security / 许可证与安全

MIT。安全问题请通过仓库 issue 私下报告。

## 已知限制

- 冷却期为内存态，重启丢失（可接受：主要防同机会话内反复打失败 provider）。
- 手动档位持久化上限 500 条会话，超出自动淘汰最早条目。
- 思考档位支持矩阵依赖各 provider 实际行为，保存时按模型目录校验。
