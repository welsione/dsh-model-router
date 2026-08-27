# 交接文档：DSH 会话历史不可读问题与 dsh-model-router 卸载兼容优化

> 交接日期：2026-08-27
> 前序工作：由 ZCode 会话完成的问题诊断、存量日志修复、本方案制定
> 目标读者：接手本插件后续优化工作的 Agent / 开发者
> 本文档位置：`~/CodeSpace/deepseek/dsh-model-router/HANDOFF.md`

---

## TL;DR（当前状态：一切健康，卸载兼容已治本）

1. 用户的 DSH 环境**当前完全正常**：`dsh web` 可正常启动，历史会话全部可读，`@welsione/dsh-model-router@^0.0.6` 已装回 web profile。
2. 存量会话日志的兼容性问题已**全盘修复并验证**（详见下文），原始备份完整保留。
3. 治本优化**已完成**：插件**不再向会话日志写任何自定义事件**（删掉了 `emitRouteEvent`/`session.append` 及白名单注册），卸载兼容问题从根上消失。实时徽章改读 `/api/model-router/state`。详见「四、最终方案」。

---

## 一、前因后果（事件时间线）

### 故障 1：卸载命令被无关依赖卡死

用户执行 `dsh plugin --profile web rm @welsione/dsh-model-router` 报：

```
ENOENT: no such file or directory, open '/tmp/mmx-harness/dsh-mmx-bridge-1.0.7.tgz'
```

**原因**：web profile 的 package.json 里残留 `"dsh-mmx-bridge": "file:/tmp/mmx-harness/....tgz"`。macOS 定期清理 `/tmp`，该 tarball 已消失；而 `dsh plugin rm` 底层在 profile 目录跑 pnpm，pnpm 每次都要重新解析 profile 的**全部直接依赖**，撞上这条失效 `file:` 引用就整体失败。

**已完成的修复**：
- 从 `/Users/weigaolei/.dsh/profiles/web/package.json` 删除 `dsh-mmx-bridge` 两处记录（dependencies + `dsh.profile.bundles`）
- profile 目录内 `pnpm install` 同步
- 重跑 rm 成功移除 `@welsione/dsh-model-router`（github 版）

### 故障 2：卸载后所有含路由事件的会话打不开

`dsh web` 启动后报 `SessionFormatUnsupportedError: ... contains event type "model-router/route" (seq N) unknown to this harness and not marked ignorable; refusing to interpret the log`。

**机制**（这是理解一切后续工作的核心）：
- DSH 会话历史 = 追加式 JSONL 事件日志（zstd 多帧压缩），每行一条带 `type` 字段的事件
- 插件可向会话日志写自定义事件类型（如 model-router 的路由决策记录）
- harness 读取时的安全规则（判定门）：未知事件类型要么自身带 `"ignorable": true` 信封标记（声明可安全跳过），否则**拒绝解读整份日志**——因为静默丢弃必需事件可能把会话重建成错误状态
- 旧版 model-router 写事件没带 `ignorable` → 卸载后无人认得该类型 → 其历史会话全部拒载

### 已完成的存量修复（分两轮，第一轮有反复）

**第一轮（有缺陷）**：解压日志 → 给 ~9000 条 `model-router/route` 事件补 `ignorable:true` → CLI 整体单帧重压。
事件文本层面校验全过，但**破坏了 zstd 多帧布局契约**，导致更严重的故障 ↓

### 故障 3（修复引入）：单帧重压导致 `dsh web` 无法启动

```
corrupt Zstandard session log: first frame is not exactly one header line
```

**布局契约**（读取端强制）：JSONL 工件必须是多帧结构，**第一帧必须恰好解码出一行表头 + 结尾 `\n`**；后续每次写入批次各为一个独立追加帧（无损帧数信息，只有首帧有结构性要求）。单帧文件使首帧包含全部内容 → 断言失败 → 启动时遍历工件列表直接崩。

**第二轮（最终，已完成）**：以备份原件为源重建 39 个受影响工件为正确的两帧结构：帧1=表头行单独一帧，帧2=其余全部事件行。每个工件经四重校验后才落盘：
1. 全量解码 == 补丁后明文（逐字节）
2. 仅首帧单独解码严格等于表头行（忠实复现 `assertZstdHeaderFrame`）
3. 非目标行零字节改动；目标行仅新增 `ignorable:true`
4. 用 harness 真实 `KNOWN_SESSION_EVENT_TYPES` 对比前后「未知且不可忽略」类型计数，除目标类型归零外零变化

随后做全盘终验通过：39 个重建件与构建产物哈希一致；49 个未触碰文件确认原封未动；全部目标事件带标记；无临时文件残留。

---

## 二、系统现状清单

| 项目 | 状态 |
|---|---|
| dsh 全局版本 | 0.1.0-rc.8（`/usr/local/lib/node_modules/@deepseek-ai/dsh`） |
| web profile | `/Users/weigaolei/.dsh/profiles/web`，插件：dshmarket、dsh-skill-manager、dsh-mcp-manager、dsh-context、dsh-ccswitch-usage + **@welsione/dsh-model-router@^0.0.6（npm 版，故障后被人重新装回）** |
| 受影响会话 | 9 个项目 39 个会话日志，共约 9000 条 `model-router/route` 事件，已全部补标记 |
| 备份 | `/Users/weigaolei/.dsh/backups/dsh-model-router-fix-20260827/`：88 个会话日志原件（按原目录树）+ `scripts/` 下三个修复脚本 |
| 插件源码仓库 | `~/CodeSpace/deepseek/dsh-model-router`（main 分支，clean） |
| 已知异常文件 | `/Users/weigaolei/.dsh/settings.yaml.bak-mr-1787297281`（来源不明，未动过，可能是某次安装过程自动备份） |

---

## 三、关键技术事实（改动前必读）

以下引用均基于全局安装路径 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/`：

### 会话事件格式契约

- **判定门**：`@deepseek-ai/dsh-session-persistence/lib/index.js:1119`
  ```js
  if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue;
  ```
  走到 throw 即 `SessionFormatUnsupportedError`。注意：判定发生在 NORMALIZED 事件上（legacy 形状先经 adopt/snapshot 升级），因此**不要**用静态清单对原始行做等价校验——那会产生大量误报（如 `session`、`reasoning-chunks` 是 legacy 形状名，不在清单但实际可解析）。
- **内置词汇表**：`@deepseek-ai/dsh-session/lib/types/known-event-types.js:18` 的 `KNOWN_SESSION_EVENT_TYPES`（生成的 Set，运行时可变；注释明确说 out-of-repo 插件事件的注册面 deferred until such a consumer exists）
- **信封契约**：顶层字段 `type / seq / time / data / ignorable?`；seed 校验接受 `ignorable === true` 或缺省（`@deepseek-ai/dsh-session/lib/index.js:1209`），normalize 有对应 case 分支（:1203）

### JSONL 工件的物理布局（⚠️ 改日志必守）

后端实现：`@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
- `assertZstdHeaderFrame`（:742）：首帧明文必须**恰好一行且以 `\n` 结尾**
- `readFirstZstdLine`（:1307）：启动时对所有工件逐个做首帧扫描+断言 → 一个坏文件 = 整个 boot 失败
- 写入端 `materialize`（:1175-1182）：`compressZstdFrame(header)` + 每批一个 `compressZstdFrame(body)` 追加
- 校验时**不要**用魔数字节扫描找帧边界（压缩数据可能碰巧含魔数）——用构建时记录的真实帧长切分
- zstd 文本往返注意：`zstd -dc` 会透明拼接多帧，看不到帧边界；CLI 整体重压默认产出单帧 = 坑

### session.append API 限制（决定优化方向的关键事实）

`@deepseek-ai/dsh-session/lib/index.js:1444` 的 `append(type, data, opts)`：opts 只提取 `sourceEventSeqs` 和 `surfaceOp`，信封内部构造并 `deepFreeze`，**无法透传 `ignorable`**。所以第三方插件今天还无法让持久化事件天生自足（这正是上游优化的切入点）。

### 插件现状代码

`~/CodeSpace/deepseek/dsh-model-router`（本地源码 == npm 发布的 0.0.6）：
- `lib/index.js:102`：`apply()` 开头运行时把 `'model-router/route'` 注册进共享的 `KNOWN_SESSION_EVENT_TYPES` Set（依赖与 persistence 解析到同一模块实例/realpath）→ 这就是「装着能读、卸了崩」的结构性原因
- `lib/index.js:232`（`emitRouteEvent`）：`session.append('model-router/route', { ts, ...entry })`，无 ignorable 可传
- 注释里作者已完整分析过此问题（含对 append 局限的调研），说明这些事实与本节一致

---

## 四、最终方案：删除会话事件落盘（已落地，2026-08-27 后续）

> **结论**：经过完整的机制分析（见下「为什么是删除」），治本做法不是 L1/L2/L3 中的任何一个，而是**把「写会话日志」整个删掉**。L1（多实例注册加固）和 L3（routeEventPersistence 开关）曾作为中间态实现并提交（commit `f3e95d6`），随后被本次「直接删除」取代并回滚。L2（上游 PR）因无法走通而放弃。

### 为什么是删除

`model-router/route` 事件的**唯一消费者**是前端 `OverlayStatus` 徽章（会话窗口右上角「当前用哪个模型/哪一档」）。它要的是「这个会话**当前**在用哪个模型」——一个**实时、易失、跟着当下进程走**的状态。把这个状态写进**持久的、追加式的、用于会话重建的**事件日志，是用错了存储层：

- 该事件对**会话重建零价值**（纯实时广播），却让所有含它的会话背上了「卸载即拒载」的风险。
- 它曾被积成日志噪音（单会话 300+ 条）。
- 上游 `session.append()` 不透传 `ignorable`（`dsh-session/lib/index.js:1444` 的 opts 白名单只挑 `sourceEventSeqs`/`surfaceOp`），而 `Session` 上唯一的写入口就是 `append`——**不碰上游，就无法让事件天生自足**。绕过 append 直写 `session.log` 会绕过 `surfaceManager.validateNext`/`session/event` 发布/seq 连续性校验，是自残而非方案。

插件本来就有一条**正确**的存储路径：`record()` → 内存 `history[]` → `GET /api/model-router/state`（带 `sessionId`）。徽章改读这个端点（按 sessionId 过滤、按 ts 取最新）即可，实时性用 2s 轮询足够。

### 已删除的内容

服务端 `lib/index.js`：
- `emitRouteEvent()` 函数 + 全部 9 处调用点（started/served/all-failed/failover/passthrough/skipped-context/manual-tier 各处的会话事件写入）。`record()` 内存历史**完整保留**（面板全局历史 + 徽章数据源不受影响）。
- L1 注册块：`KNOWN_SESSION_EVENT_TYPES.add('model-router/route')` + 多实例注册（`createRequire`/`registerRouteEventType`），连同 `import { KNOWN_SESSION_EVENT_TYPES }`、`import { createRequire }`。
- L3 schema 字段 `routeEventPersistence` + `validateSection` 里的保留逻辑。
- `inject` 里移除 `sessions`（服务端不再用 `ctx.sessions`）。

客户端 `lib/client.js`：
- `OverlayStatus` 删掉「订阅会话事件流」路径（`deriveFromSession`/`session.subscribe`/`sessions.binding`），轮询 `/api/model-router/state` 升级为唯一数据源（原有按 sessionId 过滤 + 按 ts 取最新逻辑不变）。
- 面板「路由事件写入会话日志」开关 + 3 处 `routeEventPersistence` 白名单字段。
- `conversation.input.left` 的 inject 不再传多余的 `sessions` prop（`sessions` 仍被 PackageSelect 的 `subagentAddress` 用着，故 inject 声明保留）。

`lib/core.mjs` / `tests/core.test.mjs`：
- 删除 `ROUTE_EVENT_TYPE` / `registerRouteEventType` 及对应 3 个测试用例。

### 收益

- **卸载兼容问题从根上消失**：插件不再向会话日志写任何自定义事件，`KNOWN_SESSION_EVENT_TYPES` 白名单注册这一整个失败面不复存在。
- **日志零污染**。
- **顺带消除了两类徽章闪烁 bug 的根因**：过去「事件流（Map 插入序/分页回填）vs 轮询」两个数据源互踩导致徽章在两模型间跳动；现在单一数据源，问题不复存在。
- 代价：失去「回放某场历史会话的路由轨迹」（本就无实际用途的过期信息）。

### 验证

- 单测 `tests/core.test.mjs` 44/44 通过。
- 合规 `check.mjs` PASS，93/100 (A)，0 error / 1 warn（已知 `patch_name_resolves` 误报）。
- 隔离运行级测试 `test.mjs` PASS：打包/安装/层生效/启动冒烟/`boot.marker`（apply 真实执行，**无 sessions inject 仍正常**）/卸载清理 全过——卸载兼容的活证明。

### 存量注意

本次删除只影响**新**事件不再落盘。**存量会话日志**里的旧 `model-router/route` 事件不受影响——它们已在此前被批量补了 `ignorable:true` 标记（见第一节「已完成的存量修复」），读取端判定门放行。若用户换机恢复了未修复的旧日志快照，仍需按第五节跑 v2 修复脚本。

### L2 备忘（若未来上游支持 ignorable）

即便上游哪天给 `append()` 加了 ignorable 透传，也**不建议**恢复会话事件落盘——实时状态不属于持久日志。本节分析保留作决策依据。

---

## 五、运维兜底与还原方式（给未来可能的排障）

- **一键检查脚本**（已在备份目录归档）：
  - `scripts/dsh-mr-fix-v2.cjs`：正确版批量修复器（表头帧拆分 + 补标记 + 四重校验）。它以 BACKUP_ROOT 为源、SESSIONS_ROOT 为目标，路径写在文件头常量里
  - `scripts/dsh-mr-verify.cjs`：全盘终验（重建件哈希比对 / 未触碰件一致性 / 标记完整性 / 表头合法性）
  - `scripts/dsh-mr-fix.cjs`：第一轮的单帧版本，**有布局缺陷，仅作历史参考，禁止再跑**
- **彻底还原到修复前状态**（一般不需要）：
  ```sh
  rsync -a --delete "/Users/weigaolei/.dsh/backups/dsh-model-router-fix-20260827/" \
    "/Users/weigaolei/.dsh/sessions/" --exclude='.staging*' --exclude='scripts/'
  ```
- **其他机器的场景**：如果用户在其他设备同步/恢复了同一批会话日志（或从未打包的快照），那些机器上的日志仍是未修复状态，重启会出现同款 SessionFormatUnsupportedError；处理办法就是再跑一遍 v2 脚本（需要先在其机器上做同样结构的备份）。
- **验证 dsh web 健康**的快速方法：`opt/homebrew/bin/zstd --list <artifact>` 应显示 Frames ≥ 2 且第一个 Compressed Size 很小（~百字节级）；单帧 = 有问题。
- Node ≥ 23 自带 `require('zlib').zstdDecompressSync`（实验性但可用），可用于复现 readFirstZstdLine 的逐帧语义。

---

## 六、给接手 Agent 的注意事项

1. **改会话日志相关代码前，先读本档第三节两个契约小节**；动手对象是文件头常量化的 v2 脚本而非裸 shell 管道。
2. 插件仓库 `tests/` 目录已有测试基建，L1/L3 改动请补对应用例；`test-model-reasoning.mjs` 是独立脚本不是测试集入口。
3. 用户的 Desktop/Web 端可能正开着，`dsh web` 是前台进程——排障时提醒用户避免并发操作 sessions 目录。
4. 所有既成结论都以本文档 + 源码行为准；不要凭记忆重新推导格式契约。
5. 若上游接受了 L2，回来更新本档第四节状态，避免下一个 Agent 重复提案。
