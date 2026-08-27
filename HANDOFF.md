# 交接文档：DSH 会话历史不可读问题与 dsh-model-router 卸载兼容优化

> 交接日期：2026-08-27
> 前序工作：由 ZCode 会话完成的问题诊断、存量日志修复、本方案制定
> 目标读者：接手本插件后续优化工作的 Agent / 开发者
> 本文档位置：`~/CodeSpace/deepseek/dsh-model-router/HANDOFF.md`

---

## TL;DR（当前状态：一切健康，留有优化任务）

1. 用户的 DSH 环境**当前完全正常**：`dsh web` 可正常启动，历史会话全部可读，`@welsione/dsh-model-router@^0.0.6` 已装回 web profile。
2. 存量会话日志的兼容性问题已**全盘修复并验证**（详见下文），原始备份完整保留。
3. 遗留任务是**治本优化**：让 model-router 写入的 `model-router/route` 会话事件在「插件被卸载后」依然不阻塞历史读取。推荐路径见「优化方案」一节，优先级从高到低为 L1 加固 → L2 上游 PR → L3 架构调整。

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

## 四、优化方案（待办，按优先级）

### L1 · 插件端加固 —— 建议无论如何都做（约半小时） ✅ 已完成

**目标**：消除现有白名单注册方案的静默失效风险。
**现状风险**：注册只在「单一 import 实例」上生效；若 pnpm 提升/harness 升级/多份拷贝导致 realpath 不一致，注册打到另一份 Set 上，persistence 认不得 → 老故障无声复发。
**做法**（已落地于 `lib/core.mjs` `registerRouteEventType` + `lib/index.js` apply 开头）：
- 除静态导入外，再经由 `@deepseek-ai/dsh-session-persistence` 的模块解析（`createRequire` 从 `dsh-session-persistence/package.json` 定位它实际加载的 `dsh-session` 入口）把那份 `KNOWN_SESSION_EVENT_TYPES` 也注册一遍；`===` 去重后单实例场景与现行为完全一致，多 realpath 场景逐份注册。
- 用 `createRequire` 同步 `require()` 加载（Node≥22 支持 require ESM，与静态 import 共享模块缓存，已实测同实例），避免动态 import 表达式触发安全扫描 MKT-EXEC-009。
- 日志分级：成功 ≥1 份 → debug 注明生效实例路径；部分失败 → warn；全部失败 → error（不再是静默 warn）。

**验收**：`tests/core.test.mjs` 新增 3 例（多 Set 实例都注册到 / 非 Set 目标跳过不中断 / add 抛错被捕获），46/46 通过；隔离运行级测试 boot.marker PASS（apply 真实执行）。

### L2 · 上游 PR：session.append 支持 ignorable —— 性价比最高的治本解 ⏳ 待提

**目标**：事件写出来就自带免疫，无需任何白名单注册，任何机器任何卸载时机都安全。
**上游改动极小**（基础设施已在）：在 `append()` 的 opts 提取处增加透传：

```js
...{ ...(surfaceOpts?.ignorable === true ? { ignorable: true } : {}) }
```

建议同时更新 SessionEvent 文档字符串与类型定义。
**插件侧配套**：上游发版后，把白名单注册逻辑整体替换为：

```js
session.append('model-router/route', { ts: Date.now(), ...entry }, { ignorable: true })
```

**行动项**：
1. 在 @deepseek-ai/dsh 仓库提 issue/PR（动机可直接引用其 known-event-types.js 注释里的 "registration surface ... until such a consumer exists"——本项目即 consumer）
2. 附上本文档第三节的 API 分析作为论据（作者调研已确认 seed 校验和 normalize 都已接受 ignorable）
3. 上游发版后发插件 0.1.0 切换写法，保留旧注册兼容老 harness 或按 harness 版本探测分支

### L3 · 架构取舍（可选）：路由事件不再落会话日志 ✅ 已实现（默认保持现行为）

**洞察**：路由决策事件的消费方只有两类——订阅会话事件流的实时 UI，和另一套独立的 `record()` 全局存储。它在**会话恢复时没有任何重建价值**，纯实时广播。代价却是：污染会话日志（bazi 项目单会话曾积到 300+ 条噪音）、以及整个卸载兼容难题。
**做法**（已落地）：新增配置字段 `routeEventPersistence: 'session' | 'live'`（schema `z.union([z.const('session'), z.const('live')]).default('session')`，**默认 'session' 保持现行为不变**）。`'live'` 时 `emitRouteEvent` 跳过 `session.append`，只走 `record()` 全局历史。设置面板加了「路由事件写入会话日志」开关（勾选=session，取消=live），服务端 `validateSection` 在 body 未携带时保留现有持久化值（同 manualTiers/reasoningEffortsFallback 模式）。
**收益**：用户切到 `'live'` 后新事件不再落盘 → 后续卸载不再有兼容问题；也符合「可调值必须配置化」原则。
**判断点**：默认仍落盘，因为实时徽章（事件流）与单场会话路由轨迹回放依赖它；切 `'live'` 后实时徽章退化为 2s 轮询、无法回放轨迹。L2 上游发版后，落盘事件自带 ignorable，本开关的「卸载兼容」动机即消失。

### 完成后的发布流程（供任一层次改动参考）

```sh
cd ~/CodeSpace/deepseek/dsh-model-router
# 测试
node tests/*.mjs  # 具体测试入口见仓库 tests/
# 预检 & 打包自测
npm pack --dry-run && npm pack && dsh plugin --profile web add <tarball>
# npm 发布 + git tag（版本号按 CHANGELOG 语义递增）
npm publish
```

> 注意：如果按 dsh-plugin-developer skill 的标准，本仓库目前只改 lib、README 结构未按市场 9 小节组织，收录类工作不在本次范围。

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
