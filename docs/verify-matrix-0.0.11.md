# DSH 多版本验证矩阵报告 — dsh-model-router 0.0.11

- 日期：2026-09-22
- 被测产物：`welsione-dsh-model-router-0.0.11.tgz`（develop 分支，npm pack 自验证脚本触发，prepack 含 `npm test` 60 项）
- 验证工具：`scripts/verify-dsh-matrix.mjs`（本仓库），L4 层复用 [dsh-plugin-developer](../dsh-plugin-developer) 的运行级测试
- 结论：**声明支持范围内（DSH 0.1.0-rc.x ～ 0.1.5-rc.2）全部通过；0.1.7-alpha.1 存在宿主架构级不兼容（alpha 预期，待 rc 适配）**

## 矩阵结果

| DSH 版本 | 选择理由 | L4 运行级 | L5 面板 API | 结论 |
|---|---|---|---|---|
| 0.1.0-rc.8 | 支持下限（locale 服务引入） | ✅ PASS（14 checks） | ✅ 8/8 | **通过** |
| 0.1.1-rc.2 | `installSettingsSection` 自由函数时代（0.0.9 边界） | ✅ PASS（14 checks） | ✅ 8/8 | **通过**¹ |
| 0.1.2-rc.1 | settings API 改 `installSection` 方法（0.0.9 边界） | ✅ PASS（14 checks） | ✅ 8/8 | **通过** |
| 0.1.5-rc.2 | `remote.session` inject 边界（0.0.10）+ 最新可用 rc | ✅ PASS（14 checks） | ✅ 8/8 | **通过**² |
| 0.1.5-rc.3 | 最新 rc | — | — | **无法安装³** |
| 0.1.7-alpha.1 | 最新 alpha（向前兼容探测） | ❌ 1 error | ❌ | **不兼容⁴** |

¹ 0.1.1-rc.2 于独立轮次全过（同源码 tarball、同脚本逻辑）；汇总轮其 npm 安装遭遇网络超时（ETIMEDOUT），与插件无关。
² 0.1.5-rc.2 安装需 overrides 解依赖死局（见下），运行本身完全正常——本机既有安装即此版本。
³ 0.1.5-rc.3 是**坏发布**：其依赖树里的 `dsh-web-app@0.1.5-rc.3` 要求 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`，该版本在任何 registry 都不存在（官方与 npmmirror 已核实）。连带 `dsh@^0.1.5-rc.2` 的解析也被污染（caret 范围会命中 rc.3）。验证脚本已内置 overrides（钉 documentpreview@0.1.5-rc.2）绕开。
⁴ 0.1.7-alpha.1 上插件 entry 激活失败：`dsh-settings@0.1.7-alpha.1` 完全移除了 `installSection`/`installSettingsSection`（服务类更名 `SettingsForms`，section 改为宿主按 entry id 自动派生 + `settings.configure({auto:false})`）。这是宿主 settings 机制的架构级重构，插件的两代兼容路径全部失效。属 alpha 阶段预期 breaking change——待 0.1.7 进入 rc 后新增第三条兼容路径适配。

## L5 面板 API 探测项（每版本 8 项）

| # | 探测项 | 验证内容 |
|---|---|---|
| 1 | `boot.http` | 宿主 HTTP 可达（新版含 token 访问 URL 的透传） |
| 2 | `state` | `GET /api/model-router/state` → `ok:true` |
| 3 | `caps.get` | `GET /api/model-router/model-capabilities` → 新字段 `capabilities`/`providerHeaders`/`declared`/`resolvedInput` 齐全；目录解析生效输入类型正确（text） |
| 4 | `caps.headers` | POST 请求头 `x-opencode-session`（MissingSessionID 场景）→ 200；GET 回读一致；**settings.yaml 实际落盘** |
| 5 | `caps.input` | POST `input: ["text","image"]` 写回 → 回读一致；POST `input: null` → 字段从配置删除（回退目录） |
| 6 | `caps.video_rejected` | POST `input: ["video"]` → 400 明确报错（宿主 MODALITIES 仅 text/image） |
| 7 | `caps.no_side_effect` | 写回后 models/apiKeyEnv 等其余配置无损 |
| 8 | `boot.marker` | stdout 出现 `[dsh-model-router] plugin ready`（apply 真实执行） |

L4 运行级测试（dsh-plugin-developer test.mjs，14 checks）：一次性 DSH_HOME → npm pack → `dsh plugin add` → `--dump-config` bundle 层标记 → web profile 启动冒烟（存活 ≥20s + HTTP 探测 + apply 标记）→ 卸载 → 清理，全程隔离不碰本机配置。

## 用法

```sh
npm run verify:matrix                          # 默认 5 个边界版本（约 10-20 分钟，视网络）
npm run verify:matrix -- --versions 0.1.5-rc.2 # 只跑指定版本
npm run verify:matrix -- --keep                # 保留临时目录排障
```

成本：每版本需完整安装 dsh（约 280MB，npm cache 去重公共依赖）。CI 建议按需挑 1-2 个边界版本。

## 对 0.0.11 发布的意义

- 新增的 **input 写回 / 请求头写回（MissingSessionID 解法）/ null 删除 / video 拒绝** 在全部受支持宿主版本上实测可用（含 settings.yaml 落盘与热重载无副作用）。
- 兼容性声明维持「DSH 0.1.0-rc.x ～ 0.1.5-rc.2」；0.1.5-rc.3 因上游坏发布不可安装（非插件问题）；0.1.7 需待其 API 定型后适配（已记录于 TODO）。

---

## 0.0.12 附录 — 0.1.7-alpha.1 兼容适配（2026-09-23）

0.0.11 矩阵发现 0.1.7-alpha.1 不兼容（宿主 settings 架构重构）。0.0.12 完成适配并复测：

| DSH 版本 | L4 运行级 | L5 面板 API | 结论 |
|---|---|---|---|
| 0.1.7-alpha.1 | ✅ PASS（14 checks） | ✅ 8/8 | **通过** |
| 0.1.5-rc.2（回归） | ✅ PASS（14 checks） | ✅ 8/8 | **通过** |

适配要点（详见 CHANGELOG 0.0.12）：

1. **Config 命名导出 + 全字段 `.volatile()`**：0.1.7 宿主自动按 `plugin.Config` 派生配置段（ns = entry id）；volatile 字段是热编辑面——面板保存原地更新 ref 并发 `loader/volatile-update`（不重启插件），且 settings.update/mutate 只接受 volatile 路径。
2. **apply 双路径**：第二参字段带 `.get`（0.1.7 ref-store）→ 读 ref + 订阅 volatile-update + `settings.configure({auto:false})`；否则走 installSectionCompat（0.1.0～0.1.5）。
3. **entry id `dsh-model-router` → `model-router`**：0.1.7 首启会把老 settings.yaml 各段按段名迁移到同 id 的 entry——id 与 settings ns 一致才能命中，存量配置无缝升级。
4. **依赖**：`@deepseek-ai/schemastery` ^3.18.3（`.volatile()` 起始版本，配套 cosmokit ^1.8.4）。

0.1.7 行为差异备注：配置存储从 `settings.yaml` 迁至 profile patch（宿主行为，首启自动迁移，老文件改名 `settings.yaml.imported`）；web 面板 API 有浏览器认证（`?token=` 访问换签名 cookie，query token 对 `/api/*` 无效）——矩阵 L5 已加 cookie 交换。老 YAML 中若含已废弃字段（如 0.0.7 的 `routeEventPersistence`），宿主的严格迁移会跳过该段并在日志告警（数据保留在 `.imported` 文件），重新保存面板配置即可。
