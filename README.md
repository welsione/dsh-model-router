# dsh-model-router

DeepSeek Harness (DSH) 统一模型路由插件 —— 一个逻辑 ModelID 对应多个供应商的同名模型，按候选链自动路由、故障转移与三档分级。

> ⚠️ **未完成 (Work in Progress)**
>
> 本项目仍在开发中，接口与行为可能随时变更，暂不建议在正式环境大规模使用。
> 具体进度见下方 [当前进度](#当前进度)。

## 能力

- **统一 ModelID**：多个供应商的同名模型（如 `deepseek-v4-flash` 在火山引擎与 OpenCodeGo）配置成一个逻辑 ID，按候选链路由，客户端无感知。
- **三档分级**（对标 Claude Haiku / Sonnet / Opus）：
  - `tier1` 轻量（压缩 / 标题）· `tier2` 标准（主对话）· `tier3` 强大（重任务）
  - 按 `purpose` 自动选档（`compaction` / `session-title` → tier1，主对话 → tier2，`options.tier` → tier3），选中档为空时逐级降档。
- **自动故障转移**：主候选首 token 前失败（限流 / 配额 / 认证 / 网络 / 模型不存在 / 空响应）自动切换下一候选；失败候选进入冷却期（可配置时长），每步切换次数受限。
- **思考级别**：每个候选可配 `reasoningEffort`（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`），管理面板可配置，保存时校验模型真实支持。
- **管理面板**：DSH 设置页内置「模型路由」卡片（启停 / 冷却 / 路由编辑 / 思考级别 / 手动档位），并可在输入框工具行实时显示当前档位与命中供应商 / 模型。
- **会话兼容**：注册自定义会话事件类型，含路由决策事件的会话可正常恢复；跨 provider / 模型切换时自动清洗历史 `replayState`，避免 `INVALID_REPLAY_STATE` 污染。

## 当前进度

> 最后更新：2026-08-18

### 已完成 ✅

- 核心路由：`llm/stream` 中间件拦截，统一 ModelID → 候选链（tier1/2/3）路由
- 自动故障转移：首 token 前失败切换下一候选 + 冷却期 + 每步切换上限
- 三档自动选档 + 空档逐级降档 + 会话级手动档位（持久化到 settings）
- 思考级别 `reasoningEffort` 传递，保存时按模型目录 / 推理能力校验
- 管理面板 API：`GET /api/model-router/state`、`POST /api/model-router/save`、`POST /api/model-router/cooldowns/clear`、`POST /api/model-router/tier`
- 客户端：设置页管理卡片 + 输入框工具行实时状态（档位 / 供应商 / 模型）+ 手动档位下拉
- 会话恢复兼容：`model-router/route` 事件类型注册进 `KNOWN_SESSION_EVENT_TYPES`
- 历史消息 `replayState` 清洗，跨 provider / 模型切换不污染会话
- 流级思考标签剥离（`<thinking>` 等，支持跨 chunk 拆散）
- 思考档位探测脚本 `test-model-reasoning.mjs`（复用 DSH 的 pi-ai 对每个候选模型实测各档位是否真实生效）

### 待办 / 未完成 🚧

- 无自动化单元测试（当前为开发环境手工 + 探测脚本验证）
- 未发布到 npm，未提供 `dsh plugin` 一键安装（当前为本地 profile 直接挂载）
- 冷却期为内存态，重启丢失
- 手动档位持久化上限 500 条会话，超出自动淘汰最早条目
- 面板 UI 为自绘实现，样式与交互待打磨
- 思考档位支持矩阵尚未固化进文档（依赖各 provider 实际行为）
- 无独立英文文档

## 项目结构

```
dsh-model-router/
├── lib/
│   ├── index.js    # Host 侧：路由核心 + 面板 API
│   └── client.js   # 客户端：设置页管理面板 + 运行时状态
├── test-model-reasoning.mjs  # 思考档位实测脚本（开发者工具）
├── package.json
├── LICENSE
└── README.md
```

## 配置（settings.yaml）

```yaml
model-router:
  enabled: true
  cooldownMs: 300000        # 失败候选冷却时长（ms）
  maxSwitchesPerStep: 3     # 每步最大切换次数
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

## 面板 API

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/model-router/state` | 配置 + 模型目录 + 思考级别 + 冷却 + 事件历史 + 统计 |
| POST | `/api/model-router/save` | 整段保存配置（校验模型存在性与思考级别） |
| POST | `/api/model-router/cooldowns/clear` | 清空全部冷却 |
| POST | `/api/model-router/tier` | 设置 / 清除会话手动档位 |

## License

MIT