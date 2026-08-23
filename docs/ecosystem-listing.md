# 生态收录与推广记录

> 目标插件：`welsione/dsh-model-router`（npm `@welsione/dsh-model-router`）
> 推广时间：2026-08-23 · 依据各仓库 CONTRIBUTING/收录规则调研（见下方 PR 链接）

## 状态总览

| 渠道 | 性质 | 提交 | 状态 |
|---|---|---|---|
| DSH 1024Store（imsai-sh） | 合作目录（Desktop 市场可见度） | [PR #188](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/188) | ✅ **已合并**，站点 API 已收录 |
| awesome-dsh-plugin | 插件精选列表 | [PR #2866](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/286) | 🔄 待维护者评审（CI 全绿） |
| 0xsline/awesome-deepseek-harness | awesome 精选列表 | [PR #473](https://github.com/0xsline/awesome-deepseek-harness/pull/473) | 🔄 待维护者评审 |
| AdamPlatin123/awesome-dsh-plugins | 插件雷达 + 登记清单 | [PR #286](https://github.com/AdamPlatin123/awesome-dsh-plugins/pull/286) | 🔄 待维护者评审 |
| anywhere-labs/deepseek-harness-desktop | 桌面客户端（友情链接） | 未提交 | ⏸️ 门槛高（地标级），等有星标后申请 |
| alchaincyf/deepseek-harness-orange-book | 书（友情链接） | 未提交 | ⏸️ 门槛高，暂缓 |

## 自动收录（无需操作，已生效）

仓库已打 `dsh-plugin` topic → 下列自动发现列表会在下次扫描时收录：
- 0xsline/awesome-deepseek-harness 的 CATALOG.md（全量索引）
- AdamPlatin123/awesome-dsh-plugins 的 PLUGINS-ALL.md（每日雷达）
- DSH Desktop 内置市场的目录数据源（dshfind / 1024Store）

## 推广前合规修复（重要）

- **npm 0.0.1 的 cordis.patch.yml 有 YAML 解析 bug**：`name: @welsione/dsh-model-router` 的 `@` 被当 YAML 锚点 → patch 解析失败，bundle 不生效。已修复（加引号）并重发 **0.0.2**。
- dsh-plugin-developer 全套验证：`check.mjs` **100/100 (A)** + `test.mjs` **PASS**（打包→安装→bundle 注册→启动冒烟→卸载全过）。

## 注意

- npm 上存在**无关的无 scope 包 `dsh-model-router@0.6.2`**（thedeveloper256），已收录 1024Store。本插件用 scoped `@welsione/*` 身份，无冲突，但对外推广一律用全名 `@welsione/dsh-model-router`。
- 生态另有同名仓库：`tianji-qingtian`（已收录标可用）、`superboy911`、`fonlan`。差异化：统一逻辑 ModelID + 多供应商候选链 + 首 token 前故障转移 + 健康度择优 + 三级 + 思考级别 + 管理面板。
