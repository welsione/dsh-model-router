# dsh-model-router

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-model-router：一个逻辑 ModelID 汇聚多家供应商，pro / normal / lite 三档候选链自动故障转移">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-0.1.0--rc.8-4D6BFE" alt="DSH 0.1.0-rc.8">
  <img src="https://img.shields.io/npm/v/@welsione%2Fdsh-model-router" alt="npm version">
  <img src="https://img.shields.io/npm/dm/@welsione%2Fdsh-model-router" alt="npm downloads">
  <img src="https://img.shields.io/badge/license-MIT-6E7781" alt="MIT">
  <img src="https://img.shields.io/badge/Node-%3E%3D22-2AB67B" alt="Node &gt;=22">
</p>

> 一个逻辑 **ModelID** 汇聚多家供应商的同名模型 —— 首 token 前失败自动切换候选（带冷却）、健康度择优、三档分级、每候选思考级别。设置面板**修改自动保存、即时生效**。
>
> 📦 已发布 npm：[`@welsione/dsh-model-router`](https://www.npmjs.com/package/@welsione/dsh-model-router)

```sh
dsh plugin --profile web add @welsione/dsh-model-router
```

## Overview / 简介

| 能力 | 一句话 |
|---|---|
| 自动故障转移 | 主候选首 token 前失败（限流/配额/认证/网络/模型不存在/空响应）自动切下一候选，失败候选进冷却期 |
| 健康度择优 | 每个候选按滑动窗口内成功/失败计数重排——稳定成功的提前、频繁失败的延后，可一键关闭 |
| 三档分级 | `tier1` 轻量 · `tier2` 标准 · `tier3` 强大，按 `purpose` 自动选档、档空逐级降档；支持会话级手动档位 |
| 思考级别 | 每候选可配 `reasoningEffort`，保存时实际请求预检，只允许宿主真正支持的档位 |
| 档位名称 | 每套餐独立自定义档位显示名（`routes.<id>.tierNames`），彩色胶囊点击即改名，对话窗口同步展示 |
| 管理面板 | DSH 设置页内置「模型路由」卡片，修改自动保存；对话窗口套餐选择器实时路由状态 |
| 会话安全 | 会话事件可恢复、跨 provider 自动清洗 `replayState` |

## Compatibility / 兼容性

- DSH `0.1.0-rc.x`（`0.1.0-rc.8` 实测）· Node.js ≥ 22（React 18/19）· 最后验证 2026-08-22。

## Install / Uninstall · 安装 / 卸载

已发布到 npm（`@welsione/dsh-model-router`）。`dsh plugin add` 会自动从 npm 拉取：

```sh
dsh plugin --profile web add @welsione/dsh-model-router   # 安装
dsh plugin --profile web remove @welsione/dsh-model-router  # 卸载
```

> npm 拉不动？可改走 GitHub 源：`dsh plugin --profile web add github:welsione/dsh-model-router`。

装好后设置页出现「模型路由」卡片；对话窗口模型选择器变为「套餐」选择器（三档切换）。详见 [docs/usage.md](docs/usage.md)。

## Quick start / 快速开始

打开 设置 → 模型路由，添加统一 ModelID（如 `deepseek-v4-flash`），为 tier1/2/3 各配候选即可——**修改自动保存、即时生效**。最小配置与完整示例见 [docs/usage.md](docs/usage.md#快速开始)。

## Configuration / 配置

面板可视化编辑 `enabled / cooldownMs / maxSwitchesPerStep / healthRanking / reasoningEffortsFallback / routes`（含每套餐 `tierNames`）。完整配置表、模型能力写回宿主 `llm-pi-ai` 与面板 API 见 [docs/usage.md](docs/usage.md#配置)。

## Permissions & data / 权限与数据

不对外发请求、不读写工作区文件、不上报遥测、不接触 API key；运行时状态为内存态，手动档位持久化到宿主 settings。

## Troubleshooting / 故障排查

设置页无卡片 / 候选不在目录 / 自动保存失败 / 一直切换 / 会话打不开 → 快速排查清单见 [docs/usage.md](docs/usage.md#故障排查)。

## Development / 开发

```sh
npm test                 # 单元测试（node:test，零依赖）
npm test && npm pack --dry-run   # 发布前四连
```

纯逻辑 `lib/core.mjs` + 接线 `lib/index.js` + Web UI `lib/client.js`；合规自检与证据见 [docs/self-check.md](docs/self-check.md)。

### 发布新版本（自动发布到 npm）

打 `v<version>` tag 推送后，GitHub Action（[npm-publish.yml](.github/workflows/npm-publish.yml)）会校验 tag 与 `package.json` 版本一致，然后自动 `npm publish`：

```sh
npm version patch   # 升版本号（patch/minor/major，同步 CHANGELOG）
git push && git push --tags
```

发布需要仓库配置 `NPM_TOKEN` secret（npm 账号 `welsione` 的 Automation token）。

## License & security / 许可证与安全

MIT。安全问题请通过仓库 issue 私下报告。