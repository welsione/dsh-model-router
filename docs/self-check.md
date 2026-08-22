# 自检与开发（Self-check & Development）

> dsh-model-router 的合规证据与开发说明。功能细节见 [usage.md](usage.md)。

## 开发

```sh
npm test                 # 单元测试（node:test，零依赖：tests/core.test.mjs）
node test-model-reasoning.mjs   # 思考档位实测脚本（需配置供应商密钥）
# 发布前四连
npm test && npm pack --dry-run
```

- 纯逻辑在 `lib/core.mjs`（可单测、无 dsh 依赖）；`lib/index.js` 只做接线（llm/stream 拦截、面板 API、settings 集成）；`lib/client.js` 是 Web 前端（设置面板 + 套餐选择器 + 实时状态 + 自动保存）。
- 自动保存实现：任何配置修改去抖 600ms 后经 `POST /api/model-router/save` 写入；用「本地草稿 vs 服务端基线」的规范形比对避免保存回写形成循环，保存期间的新修改完成后自动补存。

## 自动检查（dsh-plugin-developer check.mjs）

```sh
node <dsh-plugin-developer>/scripts/check.mjs .            # 静态合规 + 五维评分
node <dsh-plugin-developer>/scripts/check.mjs . --scan     # MKT 安全扫描 receipt
node <dsh-plugin-developer>/scripts/check.mjs . --excellent --test-report rep.json   # 优秀门禁（运行级安装证据）
```

最近一次结果（2026-08-22）：

| 项 | 结果 |
|---|---|
| check.mjs | PASS · 0 error / 0 warn / 44 info |
| 五维评分 | 93/100 (A)：install 70 / maintenance 100 / documentation 100 / security 100 / compliance 100 |
| 单元测试 | npm test 30/30 pass |

## 运行级测试（test.mjs，一次性 DSH_HOME）

```sh
node <dsh-plugin-developer>/scripts/test.mjs . --expect-marker "dsh-model-router.*plugin ready"
```

流程：npm pack 出 tarball → 隔离 profile 安装 → `--dump-config` 层标记 → profile 陷阱检查（BOM/影子/入口）→ 启动冒烟（apply 真实执行、HTTP 可达、标记匹配）→ 卸载与清理。

最近一次结果（2026-08-22）：PASS · 0 error / 0 warn / 15 info（安装、层生效、启动标记、uninstall、teardown 全绿）。

## 发布前清单

- `dsh.bundle` 声明 + patch 用包名引用 + 入口文件存在 + `files` 只发产物 ✅
- README 9 小节（Overview/Compatibility/Install-Uninstall/Quick start/Configuration/Permissions & data/Troubleshooting/Development/License & security）✅
- `@deepseek-ai/*` peerDependencies 带预发布 `||` 分支 ✅
- LICENSE + repository + 双语 README + CHANGELOG ✅
- 发布到 npm：`npm publish --registry=https://registry.npmjs.org/`（需 2FA OTP）