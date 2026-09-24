// dsh-model-router — 客户端：设置页「模型路由」管理面板
// 经 window.__ModuleLoader__.load 注册（package.json 声明 dsh.client）。
// 与宿主通信（同源 fetch）：
//   GET  /api/model-router/state
//   POST /api/model-router/save
//   POST /api/model-router/cooldowns/clear
window.__ModuleLoader__.load({
  id: '@welsione/dsh-model-router',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    function api(path, body, method) {
      var m = method || (body === undefined ? 'GET' : 'POST')
      return fetch(path, {
        method: m,
        headers: body === undefined && m === 'GET' ? undefined : { 'content-type': 'application/json' },
        body: body === undefined && m === 'GET' ? undefined : JSON.stringify(body ?? {}),
      })
        .then(function (res) { return res.json().catch(function () { return null }) })
        .then(function (payload) {
          if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || 'request failed')
          return payload
        })
    }

    var EMPTY_CONFIG = { enabled: true, cooldownMs: 300000, cooldownMaxMs: 1800000, cooldownBackoff: 2, retryOnThrottle: true, maxRetriesPerCandidate: 2, retryBackoffMs: 1000, maxSwitchesPerStep: 3, routes: {} }

    // ------------------------------------------------------------------
    // i18n：面板文案经宿主 locale 注册表（@deepseek-ai/dsh-client-locale）。
    // 命名空间 'model-router'，随插件注册 zh/en 字典；第三方语言包可对同一
    // 命名空间 register 其它语言（fr/de/…），宿主按 fallback 链查找。
    // locale 服务缺失（0.1.0-rc.8 之前的老宿主）时回退 zh 字典 = 原中文文案。
    // 语言切换：locale.subscribe 递增版本号，useT() 经 useSyncExternalStore
    // 触发重渲染（slot 文案免刷新切换）。
    // ------------------------------------------------------------------
    var MR_NS = 'model-router'
    var DICT_ZH = {
      'panel.title': '模型路由',
      'panel.subtitle': '统一模型路由 · 故障转移 · 思考级别',
      'panel.desc': '统一 ModelID 套餐：一个逻辑模型名汇聚多家供应商额度，首 token 前失败自动切换候选（带冷却）。三档 pro / normal / lite，每个候选可配思考级别。所有修改自动保存、即时生效。',
      'panel.loadFailed': '加载失败：',
      'common.retry': '重试',
      'common.save': '保存',
      'common.saving': '保存中…',
      'common.delete': '删除',
      'common.add': '+ 添加',
      'common.collapse': '折叠',
      'common.expand': '展开',
      'provider': '供应商',
      'model': '模型',
      'tier': '档位',
      'effort.label': '思考级别',
      'effort.default': '默认',
      'effort.detecting': '检测中…',
      'effort.detecting.title': '正在检测该模型的思考级别能力…',
      'effort.unsupported': '不支持思考级别',
      'effort.unverified.title': '思考级别（该模型目录未标注，兜底档位未经验证）',
      'effort.stored': '（已存）',
      'effort.manual': '（手动）',
      'save.effortHint': '。可在候选的思考级别下拉里换一个档位，或留空使用默认。',
      'save.failed': '自动保存失败：',
      'save.auto': '修改自动保存',
      'save.savedAt': '修改自动保存 · 已保存 {time}',
      'global.master': '总开关',
      'global.title': '全局设置',
      'global.summary': '冷却 {cd} · 重试 {rt} 次 · 健康择优{hk}',
      'global.on': '已启用',
      'global.off': '已停用',
      'global.disabledTip': '已停用：全部请求走原路径',
      'global.cooldown': '失败冷却',
      'global.cooldownTip': '冷却基础时长，毫秒；5 分钟 = 300000。限流类按 0.2 倍、服务端类按 0.5 倍缩短，AUTH 等硬失败用满额',
      'global.backoff': '冷却退避',
      'global.backoffTip': '连续失败冷却退避倍数（1-16），如 2 = 30 秒基础 × 2^连续失败次数；设为 1 关闭退避',
      'global.cap': '冷却封顶',
      'global.capTip': '冷却退避封顶（毫秒），默认 30 分钟 = 1800000',
      'global.maxSwitches': '最多切换',
      'global.maxSwitchesTip': '每个 step 最多切换候选次数（1-10）',
      'global.retry': ' 瞬时错误重试',
      'global.retryTip': '限流/配额/服务端/超时等瞬时错误，先重试当前候选再切换（避免一限流就立刻冷却）',
      'global.retries': '重试次数',
      'global.retriesTip': '瞬时错误最多重试次数（0-5）；重试耗尽才冷却并切换候选',
      'global.retryInterval': '重试间隔',
      'global.retryIntervalTip': '重试间隔（毫秒），线性退避：第 n 次等待 n×此值',
      'global.health': ' 健康度择优',
      'global.healthTip': '稳定成功的候选优先，频繁失败的候选后移',
      'global.contextAware': ' 上下文窗口感知',
      'global.contextAwareTip': '按请求体量（与宿主 token-meter 同标尺 chars/4 估算）跳过上下文窗口装不下的候选——大会话不再每次先打小窗口候选失败一次才切换（如 465K 会话跳过 256K 的 k3-256k 直连 1M 的 glm-5.3）。跳过不算失败、不进冷却。',
      'global.margin': '窗口余量',
      'global.marginTip': '窗口可用比例（0.5-1）：请求估算 > 候选窗口 × 此值 即跳过。留余量给输出与系统提示',
      'global.reserve': '输出预留',
      'global.reserveTip': '输出预留 token：叠加在输入估算之上参与窗口比较（候选未声明 maxTokens 时的固定预留）',
      'group.config': '配置',
      'group.runtime': '运行状态',
      'cd.title': '冷却中的候选',
      'cd.clearAll': '全部清除',
      'cd.clearFailed': '清除失败：',
      'cd.none': '当前无',
      'cd.headDesc': '{n} 个候选冷却中',
      'cd.noneTip': '候选失败后进入冷却期（按失败类型分级：限流短、服务端中、认证长，连续失败指数退避）。冷却结束或下次请求遍历时自动清理。',
      'cd.unknown': '未知错误',
      'cd.reason': '失败原因：',
      'cd.streak': '（连续失败 {n} 次，冷却按 ×退避增长）',
      'cd.duration': '；本次冷却 {dur}',
      'cd.remaining': '剩余 {time}',
      'caps.title': '供应商模型能力与请求头',
      'caps.headDesc': '{n} 个供应商 · 输入类型 / 思考级别 / 请求头',
      'caps.empty': '暂无已配置供应商',
      'caps.empty.title': '宿主 llm-pi-ai 中没有已配置的供应商。请先在宿主 Models 页面添加供应商路由，再回到这里编辑模型能力与请求头。',
      'caps.models': '{n} 个模型',
      'caps.unset': '未设置…',
      'caps.addLevel': '+ 添加档位',
      'caps.effortTitle': '思考级别 {lv}',
      'caps.wireAria': '{id} 思考级别 {lv} wire 值',
      'caps.removeLevelAria': '移除思考级别 {lv}',
      'caps.remove': '移除 {lv}',
      'caps.catalogBadge': '目录',
      'caps.catalogBadgeTip': '该 id 同时是 pi-ai 内置目录供应商：这里编辑的是 llm-pi-ai 配置覆盖项（models/modelOverrides），写回后覆盖目录默认值。',
      'caps.input.label': '输入类型',
      'caps.input.tip': '点击切换该模型声明的输入类型（llm-pi-ai models[].input），写回后热重载生效；全部取消 = 清除声明（跟随供应商默认/模型目录）。',
      'caps.input.text': '文本',
      'caps.input.image': '图片',
      'caps.input.video': '视频',
      'caps.input.videoTip': '宿主 llm-pi-ai 暂不支持声明视频输入（目录仅 text/image），待宿主支持后开放。',
      'caps.input.resolved': '目录生效：{list}',
      'caps.input.resolvedTip': '宿主模型目录解析出的当前生效输入类型（显式声明优先于目录值）。',
      'caps.headers.label': '请求头',
      'caps.headers.tip': '附加到该供应商每个请求的 HTTP 头（llm-pi-ai providers.<id>.headers，热重载生效）。OpenCode Go（Console Go）报 MissingSessionID 时：添加 x-opencode-session = 任意固定非空值（如 dsh）即可。',
      'caps.headers.namePh': '头名称，如 x-opencode-session',
      'caps.headers.valuePh': '值',
      'caps.headers.add': '+ 添加请求头',
      'caps.headers.removeAria': '移除请求头 {name}',
      'caps.headers.nameAria': '{pid} 请求头名称',
      'caps.headers.valueAria': '{pid} 请求头 {name} 的值',
      'caps.written': '已写回宿主模型能力 {key}（热重载生效）',
      'caps.writtenHeaders': '已写回供应商请求头 {pid}（热重载生效）',
      'caps.writeFailed': '写回失败：',
      'caps.err.builtin': '。供应商未配置在宿主 llm-pi-ai 中，请先在宿主 Models 页面配置。',
      'caps.err.noLevel': '。至少勾选一个 off 之外的思考级别（如 low/medium/high），或全部取消勾选以清除声明。',
      'caps.err.wire': '。请检查思考级别档位的 wire 值填写。',
      'caps.err.input': '。输入类型仅支持 文本/图片（宿主暂不支持视频）。',
      'caps.err.dupHeader': '。请求头名称重复：{name}。',
      'caps.err.header': '。请求头名称需符合 HTTP 规范、值需为单行文本；user-agent 由宿主 attribution 管理不可配置。',
      'prov.add': '+ 添加供应商',
      'prov.addCancel': '收起表单',
      'prov.addTip': '新增供应商：写入宿主 llm-pi-ai 配置并热重载生效',
      'prov.submit': '创建供应商',
      'prov.field.id': '供应商 ID',
      'prov.field.displayName': '显示名（可选）',
      'prov.field.displayNamePh': '我的网关',
      'prov.field.api': '协议',
      'prov.field.baseURL': 'Base URL',
      'prov.field.auth': '认证方式',
      'prov.auth.key': 'API Key（存入凭据库）',
      'prov.auth.env': '环境变量名',
      'prov.auth.none': '无（由网关侧鉴权）',
      'prov.field.apiKey': 'API Key',
      'prov.field.apiKeyEnv': '环境变量名（apiKeyEnv）',
      'prov.field.models': '模型列表（每行一个）',
      'prov.field.modelsPh': 'glm-5.3/1000000/128000\ndeepseek-v4.2/1000000/256000',
      'prov.field.modelsHint': '格式：模型ID[/上下文窗口/最大输出]',
      'prov.added': '已添加供应商 {pid}（热重载生效）',
      'prov.addFailed': '添加供应商失败：',
      'prov.delete': '删除此供应商',
      'prov.delConfirm': '确定删除供应商 {pid}？其配置与凭据将被移除。',
      'prov.deleted': '已删除供应商 {pid}',
      'prov.deleteFailed': '删除供应商失败：',
      'prov.err.idRequired': '供应商 ID 必填',
      'caps.writableTip': '写回宿主 llm-pi-ai 配置，热重载生效',
      'caps.readonlyTip': '宿主配置不可写',
      'caps.readonly': '只读',
      'routes.title': '统一模型路由',
      'routes.empty': '暂无套餐',
      'routes.emptyTip': '在对话窗口的套餐选择器中添加，或在此手动添加同名统一模型 ID',
      'routes.summary': '{n} 个套餐',
      'route.newId': '新统一模型 ID',
      'route.newIdPh': '新统一模型 ID，如 deepseek-v4-flash',
      'route.delete': '删除此路由',
      'route.reqTitle': '请求 {n} 次，切换 {m} 次（切换率 {rate}）',
      'route.reqShort': '{n} 请求',
      'route.swShort': ' · 切 {n}',
      'chain.candidates': '{n} 个候选',
      'chain.add': '+ 添加候选',
      'chain.empty': '空',
      'chain.empty.tip': '空：命中该链时回退到上一档',
      'chain.add.noModel': '当前模型目录为空（无任何可列出模型），无法添加候选',
      'chain.pickModel': '（选择模型）',
      'cand.moveUp': '上移候选',
      'cand.up': '上移',
      'cand.moveDown': '下移候选',
      'cand.down': '下移',
      'cand.delete': '删除候选',
      'health.title': '健康度（近 {n} 次）：成功 {ok} / 失败 {fail}',
      'fmt.minSec': '{m} 分 {s} 秒',
      'fmt.sec': '{s} 秒',
      'hist.title': '最近事件',
      'hist.headDesc': '{n} 条路由事件',
      'hist.none': '暂无事件',
      'hist.time': '时间',
      'hist.type': '类型',
      'hist.task': '任务',
      'hist.detail': '详情',
      'hist.type.started': '尝试',
      'hist.type.failover': '切换',
      'hist.type.served': '服务',
      'hist.type.allFailed': '全失败',
      'hist.type.passthrough': '放行',
      'hist.type.manualTier': '手动档',
      'hist.type.cleared': '清冷却',
      'hist.type.skipped': '跳过(窗口)',
      'hist.failover': '{from} 失败 {code} → 下一候选',
      'hist.served': '由 {by} 服务',
      'hist.allFailed': '所有候选失败：{code}',
      'hist.passthrough': '候选全部冷却，放行原路径',
      'hist.started': '尝试 {cand}',
      'hist.skipped': '窗口装不下，跳过 {cand}',
      'hist.manual': '手动切档 → {tier}',
      'hist.cleared': '已清除全部冷却',
      'tier.editTip': '点击编辑档位名称（默认 {dflt}，清空恢复默认）',
      'tier.nameAria': '档位 {slot} 显示名',
      'pkg.placeholder': '套餐…',
      'pkg.none': '未配置套餐',
      'pkg.noneHint': '未配置套餐。请到设置 → 模型路由 添加统一模型 ID。',
      'pkg.loading': '加载中…',
      'pkg.loadFailed': '套餐加载失败：',
      'pkg.selectFailed': '选择失败（套餐对应的载体模型不可用）',
      'pkg.tierEmpty': '该档未配置候选模型，无法手动选择',
      'pkg.tierEmptyTip': '该档未配置候选',
      'pkg.tierSwitchFailed': '档位切换失败（该档首候选模型不可用）',
      'pkg.tierSwitchFailedReason': '档位切换失败：',
      'pkg.triggerTip': '选择模型套餐（统一 ModelID，含三档与故障转移）',
      'pkg.tierTitle': '档位：{tier}',
      'pkg.tiersLabel': '{id} · 档位',
      'pkg.unconfigured': '（未配置）',
      'pkg.useTier': '使用 {slot}：{chain}',
      'overlay.unavailable': '路由状态不可用',
      'overlay.routeFailed': '路由失败',
      'overlay.allFailedTip': '所有候选都失败（请检查冷却或切换套餐）',
      'overlay.titleEffort': '{full} · 思考 {effort}',
      'overlay.effortTitle': '思考级别：{effort}',
    }
    var DICT_EN = {
      'panel.title': 'Model Router',
      'panel.subtitle': 'Unified model routing · Failover · Reasoning effort',
      'panel.desc': 'Unified ModelID packages: pool several providers under one logical model name and switch candidates automatically on pre-first-token failures (with cool-down). Three tiers — pro / normal / lite — each candidate with its own reasoning effort. All changes auto-save and apply immediately.',
      'panel.loadFailed': 'Load failed: ',
      'common.retry': 'Retry',
      'common.save': 'Save',
      'common.saving': 'Saving…',
      'common.delete': 'Delete',
      'common.add': '+ Add',
      'common.collapse': 'Collapse',
      'common.expand': 'Expand',
      'provider': 'Provider',
      'model': 'Model',
      'tier': 'Tier',
      'effort.label': 'Reasoning effort',
      'effort.default': 'Default',
      'effort.detecting': 'Detecting…',
      'effort.detecting.title': 'Detecting the reasoning-effort capability of this model…',
      'effort.unsupported': 'No reasoning effort',
      'effort.unverified.title': 'Reasoning effort (not annotated in the model catalog; fallback levels are unverified)',
      'effort.stored': ' (saved)',
      'effort.manual': ' (manual)',
      'save.effortHint': ' Pick another level in the candidate’s reasoning-effort dropdown, or leave it empty for the default.',
      'save.failed': 'Auto-save failed: ',
      'save.auto': 'Changes auto-save',
      'save.savedAt': 'Changes auto-save · Saved {time}',
      'global.master': 'Master switch',
      'global.title': 'Global settings',
      'global.summary': 'cooldown {cd} · retry {rt} · ranking {hk}',
      'global.on': 'Enabled',
      'global.off': 'Disabled',
      'global.disabledTip': 'Disabled: all requests take the original path',
      'global.cooldown': 'Failure cool-down',
      'global.cooldownTip': 'Base cool-down duration in ms; 5 min = 300000. Throttle failures use 0.2×, server failures 0.5×, and hard failures like AUTH the full amount.',
      'global.backoff': 'Cool-down backoff',
      'global.backoffTip': 'Backoff multiplier for consecutive failures (1-16), e.g. 2 = 30 s base × 2^consecutive failures; set 1 to disable.',
      'global.cap': 'Cool-down cap',
      'global.capTip': 'Cool-down backoff cap in ms; default 30 min = 1800000',
      'global.maxSwitches': 'Max switches',
      'global.maxSwitchesTip': 'Maximum candidate switches per step (1-10)',
      'global.retry': ' Retry transient errors',
      'global.retryTip': 'For transient errors (throttle/quota/server/timeout), retry the current candidate before switching (avoids cooling down on the first throttle).',
      'global.retries': 'Retries',
      'global.retriesTip': 'Maximum retries for transient errors (0-5); cool down and switch only after retries are exhausted.',
      'global.retryInterval': 'Retry interval',
      'global.retryIntervalTip': 'Retry interval in ms, linear backoff: the n-th retry waits n× this value.',
      'global.health': ' Health-based ranking',
      'global.healthTip': 'Candidates with steady successes rank first; frequently failing candidates move back.',
      'global.contextAware': ' Context-window aware',
      'global.contextAwareTip': 'Skip candidates whose context window cannot fit the request (estimated on the same chars/4 scale as the host token meter) — large sessions no longer fail once against a small-window candidate before switching (e.g. a 465K session skips the 256K k3-256k and goes straight to the 1M glm-5.3). Skipping is not a failure and does not trigger cool-down.',
      'global.margin': 'Window margin',
      'global.marginTip': 'Usable window ratio (0.5-1): skip when the request estimate > candidate window × this value. Leaves headroom for output and the system prompt.',
      'global.reserve': 'Output reserve',
      'global.reserveTip': 'Reserved output tokens: added on top of the input estimate for window comparison (the fixed reserve when a candidate declares no maxTokens).',
      'group.config': 'Configuration',
      'group.runtime': 'Runtime status',
      'cd.title': 'Cooling-down candidates',
      'cd.clearAll': 'Clear all',
      'cd.clearFailed': 'Clear failed: ',
      'cd.none': 'None',
      'cd.headDesc': '{n} candidates cooling down',
      'cd.noneTip': 'A failed candidate enters a cool-down, graded by failure type (throttle short, server medium, auth long) with exponential backoff on consecutive failures. It clears automatically when the cool-down ends or on the next request pass.',
      'cd.unknown': 'Unknown error',
      'cd.reason': 'Failure reason: ',
      'cd.streak': ' (failed {n} in a row; cool-down grows by the backoff factor)',
      'cd.duration': '; this cool-down {dur}',
      'cd.remaining': '{time} left',
      'caps.title': 'Provider capabilities & request headers',
      'caps.headDesc': '{n} providers · input types / efforts / headers',
      'caps.empty': 'No configured providers',
      'caps.empty.title': 'No providers configured in the host llm-pi-ai. Add a provider route on the host Models page first, then edit model capabilities and request headers here.',
      'caps.models': '{n} models',
      'caps.unset': 'Not set…',
      'caps.addLevel': '+ Add level',
      'caps.effortTitle': 'Reasoning effort {lv}',
      'caps.wireAria': '{id} reasoning effort {lv} wire value',
      'caps.removeLevelAria': 'Remove reasoning effort {lv}',
      'caps.remove': 'Remove {lv}',
      'caps.catalogBadge': 'catalog',
      'caps.catalogBadgeTip': 'This id is also a built-in pi-ai catalog provider: what you edit here are llm-pi-ai config overrides (models/modelOverrides); saved values override the catalog defaults.',
      'caps.input.label': 'Input types',
      'caps.input.tip': 'Toggle the input modalities declared for this model (llm-pi-ai models[].input); takes effect on hot reload. Uncheck all = clear the declaration (follow the provider default / model catalog).',
      'caps.input.text': 'Text',
      'caps.input.image': 'Image',
      'caps.input.video': 'Video',
      'caps.input.videoTip': 'The host llm-pi-ai does not support declaring video input yet (catalog is text/image only); it will be enabled once the host supports it.',
      'caps.input.resolved': 'Catalog: {list}',
      'caps.input.resolvedTip': 'Effective input types resolved from the host model catalog (explicit declarations take precedence over catalog values).',
      'caps.headers.label': 'Request headers',
      'caps.headers.tip': 'HTTP headers attached to every request of this provider (llm-pi-ai providers.<id>.headers; takes effect on hot reload). When OpenCode Go (Console Go) reports MissingSessionID: add x-opencode-session = any fixed non-empty value (e.g. dsh).',
      'caps.headers.namePh': 'Header name, e.g. x-opencode-session',
      'caps.headers.valuePh': 'Value',
      'caps.headers.add': '+ Add header',
      'caps.headers.removeAria': 'Remove header {name}',
      'caps.headers.nameAria': '{pid} header name',
      'caps.headers.valueAria': '{pid} header {name} value',
      'caps.written': 'Written back to host model capabilities {key} (takes effect on hot reload)',
      'caps.writtenHeaders': 'Written back provider request headers {pid} (takes effect on hot reload)',
      'caps.writeFailed': 'Write-back failed: ',
      'caps.err.builtin': '. The provider is not configured in the host llm-pi-ai; configure it on the host Models page first.',
      'caps.err.noLevel': '. Check at least one reasoning effort other than off (e.g. low/medium/high), or uncheck all to clear the declaration.',
      'caps.err.wire': '. Check the wire values of the reasoning-effort levels.',
      'caps.err.input': '. Input types support Text/Image only (video is not supported by the host yet).',
      'caps.err.dupHeader': '. Duplicate header name: {name}.',
      'caps.err.header': '. Header names must be valid HTTP field names and values single-line; user-agent is owned by host attribution and cannot be configured.',
      'prov.add': '+ Add provider',
      'prov.addCancel': 'Hide form',
      'prov.addTip': 'Add a provider: written to the host llm-pi-ai config; hot-reloaded',
      'prov.submit': 'Create provider',
      'prov.field.id': 'Provider ID',
      'prov.field.displayName': 'Display name (optional)',
      'prov.field.displayNamePh': 'My gateway',
      'prov.field.api': 'Protocol',
      'prov.field.baseURL': 'Base URL',
      'prov.field.auth': 'Auth',
      'prov.auth.key': 'API key (stored in credentials)',
      'prov.auth.env': 'Env variable name',
      'prov.auth.none': 'None (gateway-side auth)',
      'prov.field.apiKey': 'API key',
      'prov.field.apiKeyEnv': 'Env variable name (apiKeyEnv)',
      'prov.field.models': 'Models (one per line)',
      'prov.field.modelsPh': 'glm-5.3/1000000/128000\ndeepseek-v4.2/1000000/256000',
      'prov.field.modelsHint': 'Format: model[/contextWindow/maxTokens]',
      'prov.added': 'Provider {pid} added (hot-reloaded)',
      'prov.addFailed': 'Failed to add provider: ',
      'prov.delete': 'Delete this provider',
      'prov.delConfirm': 'Delete provider {pid}? Its config and credential will be removed.',
      'prov.deleted': 'Provider {pid} deleted',
      'prov.deleteFailed': 'Failed to delete provider: ',
      'prov.err.idRequired': 'Provider ID is required',
      'caps.writableTip': 'Written back to the host llm-pi-ai config; takes effect on hot reload',
      'caps.readonlyTip': 'Host config is not writable',
      'caps.readonly': 'Read-only',
      'routes.title': 'Unified model routes',
      'routes.empty': 'No packages',
      'routes.emptyTip': 'Add from the package selector in the chat window, or add a unified model ID with the same name here.',
      'routes.summary': '{n} plans',
      'route.newId': 'New unified model ID',
      'route.newIdPh': 'New unified model ID, e.g. deepseek-v4-flash',
      'route.delete': 'Delete this route',
      'route.reqTitle': '{n} requests, {m} switches ({rate} switch rate)',
      'route.reqShort': '{n} req',
      'route.swShort': ' · {n} sw',
      'chain.candidates': '{n} candidates',
      'chain.add': '+ Add candidate',
      'chain.empty': 'Empty',
      'chain.empty.tip': 'Empty: falls back to the previous tier when this chain is hit',
      'chain.add.noModel': 'The model catalog is empty (no listable models); cannot add a candidate',
      'chain.pickModel': '(pick a model)',
      'cand.moveUp': 'Move candidate up',
      'cand.up': 'Move up',
      'cand.moveDown': 'Move candidate down',
      'cand.down': 'Move down',
      'cand.delete': 'Delete candidate',
      'health.title': 'Health (last {n}): {ok} ok / {fail} failed',
      'fmt.minSec': '{m}m {s}s',
      'fmt.sec': '{s}s',
      'hist.title': 'Recent events',
      'hist.headDesc': '{n} route events',
      'hist.none': 'No events',
      'hist.time': 'Time',
      'hist.type': 'Type',
      'hist.task': 'Task',
      'hist.detail': 'Detail',
      'hist.type.started': 'Try',
      'hist.type.failover': 'Failover',
      'hist.type.served': 'Served',
      'hist.type.allFailed': 'All failed',
      'hist.type.passthrough': 'Passthrough',
      'hist.type.manualTier': 'Manual tier',
      'hist.type.cleared': 'Cleared',
      'hist.type.skipped': 'Skipped (window)',
      'hist.failover': '{from} failed {code} → next candidate',
      'hist.served': 'Served by {by}',
      'hist.allFailed': 'All candidates failed: {code}',
      'hist.passthrough': 'All candidates cooling down; passed through the original path',
      'hist.started': 'Tried {cand}',
      'hist.skipped': 'Window too small, skipped {cand}',
      'hist.manual': 'Manual tier switch → {tier}',
      'hist.cleared': 'All cool-downs cleared',
      'tier.editTip': 'Click to edit the tier name (default {dflt}; clear to restore the default)',
      'tier.nameAria': 'Tier {slot} display name',
      'pkg.placeholder': 'Package…',
      'pkg.none': 'No package',
      'pkg.noneHint': 'No package configured. Add a unified model ID in Settings → Model Router.',
      'pkg.loading': 'Loading…',
      'pkg.loadFailed': 'Failed to load packages: ',
      'pkg.selectFailed': 'Selection failed (the package’s carrier model is unavailable)',
      'pkg.tierEmpty': 'This tier has no candidates; cannot select it manually',
      'pkg.tierEmptyTip': 'No candidates in this tier',
      'pkg.tierSwitchFailed': 'Tier switch failed (the tier’s first candidate is unavailable)',
      'pkg.tierSwitchFailedReason': 'Tier switch failed: ',
      'pkg.triggerTip': 'Choose a model package (unified ModelID with three tiers and failover)',
      'pkg.tierTitle': 'Tier: {tier}',
      'pkg.tiersLabel': '{id} · Tiers',
      'pkg.unconfigured': ' (not configured)',
      'pkg.useTier': 'Use {slot}: {chain}',
      'overlay.unavailable': 'Routing status unavailable',
      'overlay.routeFailed': 'Routing failed',
      'overlay.allFailedTip': 'All candidates failed (check cool-downs or switch package)',
      'overlay.titleEffort': '{full} · effort {effort}',
      'overlay.effortTitle': 'Reasoning effort: {effort}',
    }
    function fillParams(template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, function (m, name) { return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m })
    }
    // locale 服务未注入时的回退 t：直接查 zh 字典（= 原中文文案，行为不变）
    var tRef = { current: function (key, params) { var v = DICT_ZH[key]; return v === undefined ? key : fillParams(v, params) } }
    var localeRevision = 0
    var localeListeners = new Set()
    function subscribeLocale(fn) { localeListeners.add(fn); return function () { localeListeners.delete(fn) } }
    function getLocaleRevision() { return localeRevision }
    // 组件内取 t：订阅 locale 版本号，语言切换时重渲染
    function useT() {
      React.useSyncExternalStore(subscribeLocale, getLocaleRevision)
      return tRef.current
    }

    function Panel() {
      var t = useT()
      var s1 = React.useState(true);  var loading = s1[0]; var setLoading = s1[1]
      var s2 = React.useState(null);  var loadError = s2[0]; var setLoadError = s2[1]
      var s3 = React.useState(null);  var data = s3[0]; var setData = s3[1]
      var s4 = React.useState(null);  var cfg = s4[0]; var setCfg = s4[1]
      var s5 = React.useState(null);  var notice = s5[0]; var setNotice = s5[1]
      var s5b = React.useState(false); var noticeErr = s5b[0]; var setNoticeErr = s5b[1]
      var s9 = React.useState(null);  var lastSavedAt = s9[0]; var setLastSavedAt = s9[1]
      var s6 = React.useState(false); var saving = s6[0]; var setSaving = s6[1]
      var s7 = React.useState('');    var newId = s7[0]; var setNewId = s7[1]
      var s8 = React.useState(0);     var tick = s8[0]; var setTick = s8[1]
      // 模型能力（写回宿主 llm-pi-ai）：capabilities = { provider: [models] }，writable 标识是否可写
      var s11 = React.useState(null); var capabilities = s11[0]; var setCapabilities = s11[1]
      var s12 = React.useState(false); var capsWritable = s12[0]; var setCapsWritable = s12[1]
      // 每行编辑草稿：key = `provider/model` → {contextWindow, maxTokens, reasoningEfforts, input}
      var s14 = React.useState({}); var capsDraft = s14[0]; var setCapsDraft = s14[1]
      var s15 = React.useState(null); var capsSavingKey = s15[0]; var setCapsSavingKey = s15[1]
      // 供应商请求头（llm-pi-ai providers.<id>.headers）：providerHeaders 为服务端值，
      // headersDraft 为行编辑草稿（[{name, value}]），headersSavingPid 保存中标记
      var s19 = React.useState({}); var providerHeaders = s19[0]; var setProviderHeaders = s19[1]
      var s20 = React.useState({}); var headersDraft = s20[0]; var setHeadersDraft = s20[1]
      var s21 = React.useState(null); var headersSavingPid = s21[0]; var setHeadersSavingPid = s21[1]
      // resolvedInput = { `provider/model`: ['text','image'] | null }：宿主目录解析的生效输入类型
      var s22 = React.useState({}); var resolvedInput = s22[0]; var setResolvedInput = s22[1]
      // declaredPids：hand-declared 供应商 id 列表（其余为配置过路由的目录供应商，显示徽章）
      var s23 = React.useState([]); var declaredPids = s23[0]; var setDeclaredPids = s23[1]
      // 未保存候选的惰性档位查询：extraEfforts = { key: [{id,name,verified}] }，fetchingKeys 去重
      var s16 = React.useState({}); var extraEfforts = s16[0]; var setExtraEfforts = s16[1]
      var s17 = React.useState({}); var fetchingEfforts = s17[0]; var setFetchingEfforts = s17[1]
      // 思考级别选择器弹层：openPick = { key: bool }
      var s18 = React.useState({}); var openPick = s18[0]; var setOpenPick = s18[1]
      // 卡片折叠（必须在 early return 之前的 hooks 块里，否则 hook 数量随渲染路径
      // 变化 → React #310 崩溃）：默认全部收起，仅「统一模型路由」展开（核心使用区）。
      // openMap: { key: bool }；卡片头整行可点（button + aria-expanded）。
      var s24 = React.useState(function () { return { routes: true } })
      var openMap = s24[0]; var setOpenMap = s24[1]
      // 供应商管理：添加弹层开关 + 表单草稿 + 提交中标记
      var s25 = React.useState(false); var addProvOpen = s25[0]; var setAddProvOpen = s25[1]
      var s26 = React.useState(null); var provDraft = s26[0]; var setProvDraft = s26[1]
      var s27 = React.useState(false); var provSaving = s27[0]; var setProvSaving = s27[1]
      var openAddProvider = function () {
        setProvDraft({ id: '', displayName: '', authMode: 'key', apiKey: '', apiKeyEnv: '', api: 'openai-completions', baseURL: '', modelLines: '' })
        setAddProvOpen(true)
      }
      // 删除供应商（服务端带路由引用检查）
      var deleteProvider = function (pid) {
        if (!window.confirm(t('prov.delConfirm', { pid: pid }))) return
        api('/api/model-router/providers', { id: pid }, 'DELETE').then(function (res) {
          setNotice(t('prov.deleted', { pid: pid })); setNoticeErr(false)
          setCapabilities(res.capabilities || {})
          setProviderHeaders(res.providerHeaders || {})
        }).catch(function (e) {
          setNoticeErr(true); setNotice(t('prov.deleteFailed') + String((e && e.message) || e))
        })
      }
      // 提交新增供应商
      var submitProvider = function () {
        var d = provDraft || {}
        var id = String(d.id || '').trim()
        if (!id) { setNoticeErr(true); setNotice(t('prov.err.idRequired')); return }
        var models = String(d.modelLines || '').split('\n')
          .map(function (line) { return line.trim() })
          .filter(function (line) { return line !== '' })
          .map(function (line) {
            // 每行：模型ID（可带 /上下文/输出 可选段），如 glm-5.3 或 glm-5.3/1000000/128000
            var parts = line.split('/')
            var m = { id: parts[0].trim() }
            if (parts[1] && Number.isInteger(Number(parts[1])) && Number(parts[1]) > 0) m.contextWindow = Number(parts[1])
            if (parts[2] && Number.isInteger(Number(parts[2])) && Number(parts[2]) > 0) m.maxTokens = Number(parts[2])
            return m
          })
          .filter(function (m) { return m.id !== '' })
        var payload = { id: id, models: models, api: d.api || undefined }
        if (d.displayName && d.displayName.trim() !== '') payload.displayName = d.displayName.trim()
        if (d.baseURL && d.baseURL.trim() !== '') payload.baseURL = d.baseURL.trim()
        if (d.authMode === 'key' && d.apiKey && d.apiKey.trim() !== '') payload.apiKey = d.apiKey.trim()
        if (d.authMode === 'env' && d.apiKeyEnv && d.apiKeyEnv.trim() !== '') payload.apiKeyEnv = d.apiKeyEnv.trim()
        setProvSaving(true); setNotice(null); setNoticeErr(false)
        api('/api/model-router/providers', payload).then(function (res) {
          setNotice(t('prov.added', { pid: id }))
          setNoticeErr(false)
          setCapabilities(res.capabilities || {})
          setProviderHeaders(res.providerHeaders || {})
          setAddProvOpen(false); setProvDraft(null)
          load()
        }).catch(function (e) {
          setNoticeErr(true); setNotice(t('prov.addFailed') + String((e && e.message) || e))
        }).finally(function () { setProvSaving(false) })
      }

      var loadCapabilities = React.useCallback(function () {
        api('/api/model-router/model-capabilities').then(function (res) {
          setCapabilities(res.capabilities || {})
          setProviderHeaders(res.providerHeaders || {})
          setResolvedInput(res.resolvedInput || {})
          setDeclaredPids(Array.isArray(res.declared) ? res.declared : [])
          setCapsWritable(!!res.writable)
        }).catch(function () {
          setCapabilities({})
          setProviderHeaders({})
          setResolvedInput({})
          setDeclaredPids([])
          setCapsWritable(false)
        })
      }, [])
      React.useEffect(function () { loadCapabilities() }, [loadCapabilities])

      var load = React.useCallback(function () {
        setLoading(true); setLoadError(null)
        api('/api/model-router/state').then(function (res) {
          setData(res)
          setCfg({ enabled: res.config.enabled, cooldownMs: res.config.cooldownMs,
                   cooldownMaxMs: res.config.cooldownMaxMs,
                   cooldownBackoff: res.config.cooldownBackoff,
                   retryOnThrottle: res.config.retryOnThrottle,
                   maxRetriesPerCandidate: res.config.maxRetriesPerCandidate,
                   retryBackoffMs: res.config.retryBackoffMs,
                   reasoningEffortsFallback: res.config.reasoningEffortsFallback || [],
                   maxSwitchesPerStep: res.config.maxSwitchesPerStep,
                   healthRanking: res.config.healthRanking,
                   healthWindowSize: res.config.healthWindowSize,
                   contextAware: res.config.contextAware !== false,
                   contextMargin: res.config.contextMargin ?? 0.9,
                   contextReserveTokens: res.config.contextReserveTokens ?? 8192,
                   tierNames: res.config.tierNames || {},
                   routes: JSON.parse(JSON.stringify(res.config.routes)) })
          setLoading(false)
        }).catch(function (e) {
          setLoadError(String((e && e.message) || e)); setLoading(false)
        })
      }, [])
      React.useEffect(function () { load() }, [load])
      React.useEffect(function () {
        var t = setInterval(function () { setTick(Date.now()) }, 1000)
        return function () { clearInterval(t) }
      }, [])

      // 思考级别选择器弹层：点击外部 / Escape 关闭（web-design-guidelines: 弹层需可关闭）
      React.useEffect(function () {
        if (!Object.keys(openPick || {}).some(function (k) { return openPick[k] })) return
        var onDown = function (e) {
          // 点击不在 pickwrap 内（未命中 .dsh-mr-caps-pickwrap 或其内部）则全部关闭
          if (e.target && !e.target.closest('.dsh-mr-caps-pickwrap')) {
            setOpenPick({})
          }
        }
        var onKey = function (e) {
          if (e.key === 'Escape') setOpenPick({})
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [openPick])

      // ------------------------------------------------------------------
      // 自动保存：任何配置修改去抖 600ms 后写入 settings，无需手动保存。
      // canonicalCfg 把两端（本地草稿 / 服务端归一结果）序列化成同一规范形，
      // 用基线比对避免保存回写造成的循环；规范化规则与服务端 validateSection
      // 一致（丢弃空档位名称、空 reasoningEffort 等）。
      // ------------------------------------------------------------------
      var canonicalCfg = function (c) {
        if (!c) return ''
        var routes = {}
        Object.keys(c.routes || {}).sort().forEach(function (id) {
          var r = c.routes[id] || {}
          var norm = {}
          ;['tier1', 'tier2', 'tier3'].forEach(function (slot) {
            norm[slot] = (r[slot] || []).map(function (cd) {
              var o = { provider: cd.provider, model: cd.model }
              if (cd.reasoningEffort) o.reasoningEffort = cd.reasoningEffort
              if (typeof cd.contextWindow === 'number' && cd.contextWindow > 0) o.contextWindow = cd.contextWindow
              return o
            })
          })
          if (r.tierNames && typeof r.tierNames === 'object' && Object.keys(r.tierNames).length > 0) {
            norm.tierNames = Object.keys(r.tierNames).sort().reduce(function (acc, k) { acc[k] = r.tierNames[k]; return acc }, {})
          }
          routes[id] = norm
        })
        return JSON.stringify({
          enabled: !!c.enabled,
          cooldownMs: Number(c.cooldownMs) || 0,
          cooldownMaxMs: Number(c.cooldownMaxMs) || 0,
          cooldownBackoff: Number(c.cooldownBackoff) || 2,
          retryOnThrottle: c.retryOnThrottle !== false,
          maxRetriesPerCandidate: Number(c.maxRetriesPerCandidate) || 0,
          retryBackoffMs: Number(c.retryBackoffMs) || 1000,
          reasoningEffortsFallback: Array.isArray(c.reasoningEffortsFallback) ? c.reasoningEffortsFallback : [],
          maxSwitchesPerStep: Number(c.maxSwitchesPerStep) || 1,
          healthRanking: !!c.healthRanking,
          healthWindowSize: Number(c.healthWindowSize) || 8,
          contextAware: c.contextAware !== false,
          contextMargin: Number(c.contextMargin) || 0.9,
          contextReserveTokens: Number(c.contextReserveTokens) || 0,
          routes: routes,
        })
      }
      var cfgRef = React.useRef(null)
      cfgRef.current = cfg
      var dataRef = React.useRef(null)        // state API 最新快照（manualTiers 原样回传用）
      dataRef.current = data
      var baselineRef = React.useRef(null)   // 最近一次已持久化配置的规范形
      var saveTimerRef = React.useRef(null)
      var savingRef = React.useRef(false)
      var pendingRef = React.useRef(false)   // 保存期间又改动了 → 完成后补一次

      var doAutoSave = function () {
        var c = cfgRef.current
        if (!c || savingRef.current) return
        var canon = canonicalCfg(c)
        if (canon === baselineRef.current) return
        savingRef.current = true
        setSaving(true)
        // manualTiers 由 /api/model-router/tier 的 mutate 路径维护，面板不编辑它；
        // 提交时从 state 快照原样回传，避免服务端整段 replace 丢失会话手动档位
        //（否则改一次面板配置就把「夯」档清回默认「NPC」档）。canonicalCfg
        // 比对不含 manualTiers，不会因此触发保存循环。
        var body = Object.assign({}, c, {
          manualTiers: (dataRef.current && dataRef.current.config && dataRef.current.config.manualTiers) || {},
        })
        api('/api/model-router/save', body).then(function (res) {
          baselineRef.current = canonicalCfg({
            enabled: res.config.enabled, cooldownMs: res.config.cooldownMs,
            cooldownMaxMs: res.config.cooldownMaxMs,
            cooldownBackoff: res.config.cooldownBackoff,
            retryOnThrottle: res.config.retryOnThrottle,
            maxRetriesPerCandidate: res.config.maxRetriesPerCandidate,
            retryBackoffMs: res.config.retryBackoffMs,
            reasoningEffortsFallback: res.config.reasoningEffortsFallback || [],
            maxSwitchesPerStep: res.config.maxSwitchesPerStep,
            healthRanking: res.config.healthRanking, healthWindowSize: res.config.healthWindowSize,
            contextAware: res.config.contextAware !== false,
            contextMargin: res.config.contextMargin ?? 0.9,
            contextReserveTokens: res.config.contextReserveTokens ?? 8192,
            routes: res.config.routes })
          setLastSavedAt(Date.now())
          setNoticeErr(false)
          // 保存期间又修改 → 排队补一次
          if (canonicalCfg(cfgRef.current) !== baselineRef.current) pendingRef.current = true
        }).catch(function (e) {
          var msg = String((e && e.message) || e)
          if (/思考级别|reasoningEffort|reasoning/i.test(msg) && !/换一个档位|换一个/.test(msg)) {
            msg += t('save.effortHint')
          }
          setNoticeErr(true)
          setNotice(t('save.failed') + msg)
        }).finally(function () {
          savingRef.current = false
          setSaving(false)
          if (pendingRef.current) { pendingRef.current = false; scheduleAutoSave() }
        })
      }

      var scheduleAutoSave = function () {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(doAutoSave, 600)
      }

      React.useEffect(function () {
        if (cfg === null) return
        var canon = canonicalCfg(cfg)
        // 首次加载：以当前配置为基线，不触发保存
        if (baselineRef.current === null) { baselineRef.current = canon; return }
        if (canon === baselineRef.current) return   // 无实质修改（含保存回写）
        if (savingRef.current) { pendingRef.current = true; return }
        scheduleAutoSave()
      }, [cfg])

      var clearCooldowns = function () {
        // 传空 body 以强制 POST（后端 /cooldowns/clear 只接受 POST，GET 会 405）
        api('/api/model-router/cooldowns/clear', {}).then(function () { return load() })
          .catch(function (e) { setNoticeErr(true); setNotice(t('cd.clearFailed') + String((e && e.message) || e)) })
      }

      // 模型能力：保存某 provider/model 的能力草稿（写回宿主 llm-pi-ai，热重载生效）
      var saveCapability = function (provider, model) {
        var key = provider + '/' + model
        // 兜底：若草稿未初始化（未编辑过），基于当前值构建；空补丁则忽略
        var patch = capsDraft[key] || capsInitDraft(provider, model)
        var list = (capabilities || {})[provider] || []
        var orig = list.find(function (x) { return x.id === model }) || {}
        var clean = {}
        if (patch.contextWindow !== undefined && patch.contextWindow !== '') clean.contextWindow = Number(patch.contextWindow)
        if (patch.maxTokens !== undefined && patch.maxTokens !== '') clean.maxTokens = Number(patch.maxTokens)
        // reasoningEfforts：勾了档位 → 写档位集；全部取消勾选 →
        //   原本声明过 → 写 null（服务端删除该字段，跟随目录）；
        //   原本未声明 → 不写字段。绝不写 {}（宿主 assertServiceable 会拒绝空档位集）。
        var reKeys = Object.keys(patch.reasoningEfforts || {})
        var origReKeys = orig.reasoningEfforts && typeof orig.reasoningEfforts === 'object' ? Object.keys(orig.reasoningEfforts) : []
        if (reKeys.length > 0) clean.reasoningEfforts = patch.reasoningEfforts
        else if (origReKeys.length > 0) clean.reasoningEfforts = null
        // input：勾了类型 → 写声明；全部取消 → 原本声明过 → null；否则不写
        var origInput = Array.isArray(orig.input) ? orig.input : []
        if (Array.isArray(patch.input) && patch.input.length > 0) clean.input = patch.input.slice()
        else if (origInput.length > 0) clean.input = null
        if (Object.keys(clean).length === 0) return
        setCapsSavingKey(key); setNotice(null); setNoticeErr(false)
        api('/api/model-router/model-capabilities', { provider: provider, model: model, patch: clean })
          .then(function (res) {
            setNotice(t('caps.written', { key: key }))
            setNoticeErr(false)
            setCapabilities(res.capabilities || {})
            if (res.providerHeaders) setProviderHeaders(res.providerHeaders)
            // 失效该候选的惰性档位缓存，路由思考级别下拉下次重新查询真实能力
            setExtraEfforts(function (x) { var n = Object.assign({}, x); delete n[key]; return n })
            setFetchingEfforts(function (f) { var n = Object.assign({}, f); delete n[key]; return n })
            // 保存后刷新主面板（efforts/目录可能变化）
            load()
          })
          .catch(function (e) {
            var msg = String((e && e.message) || e)
            if (/未配置在宿主/.test(msg)) {
              msg += t('caps.err.builtin')
            } else if (/no level beyond|offers no level/.test(msg)) {
              msg += t('caps.err.noLevel')
            } else if (/reasoningEfforts/.test(msg)) {
              msg += t('caps.err.wire')
            } else if (/输入类型|input/i.test(msg)) {
              msg += t('caps.err.input')
            }
            setNoticeErr(true)
            setNotice(t('caps.writeFailed') + msg)
          })
          .finally(function () { setCapsSavingKey(null) })
      }

      // 供应商请求头：保存某 provider 的请求头草稿（写回 llm-pi-ai providers.<id>.headers）
      // 典型用途：opencode-go 缺 x-opencode-session 报 MissingSessionID，在此配置即可。
      var saveHeaders = function (pid) {
        var rows = headersDraft[pid] || headersInitDraft(pid)
        var dict = {}
        var lowerSeen = {}
        var dup = null
        rows.forEach(function (row) {
          var name = String((row && row.name) || '').trim()
          if (name === '') return // 空名称行跳过
          var lower = name.toLowerCase()
          if (lowerSeen[lower] !== undefined) { dup = dup || name }
          lowerSeen[lower] = true
          dict[name] = String((row && row.value) || '')
        })
        if (dup) {
          setNoticeErr(true); setNotice(t('caps.writeFailed') + t('caps.err.dupHeader', { name: dup }))
          return
        }
        setHeadersSavingPid(pid); setNotice(null); setNoticeErr(false)
        api('/api/model-router/model-capabilities', { provider: pid, patch: { headers: dict } })
          .then(function (res) {
            setNotice(t('caps.writtenHeaders', { pid: pid }))
            setNoticeErr(false)
            setProviderHeaders(res.providerHeaders || {})
            // 重置该 provider 的草稿（下次渲染按服务端值重新初始化）
            setHeadersDraft(function (d) { var n = Object.assign({}, d); delete n[pid]; return n })
          })
          .catch(function (e) {
            var msg = String((e && e.message) || e)
            if (/请求头/.test(msg)) {
              msg += t('caps.err.header')
            }
            setNoticeErr(true)
            setNotice(t('caps.writeFailed') + msg)
          })
          .finally(function () { setHeadersSavingPid(null) })
      }

      // 思考级别档位（与宿主 llm-pi-ai 的 THINKING_LEVELS 一致，升序）
      var THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

      // 输入类型（与宿主 llm-pi-ai MODALITIES 对齐）；video 待宿主目录支持后开放
      var INPUT_TYPES = [
        { id: 'text', labelKey: 'caps.input.text' },
        { id: 'image', labelKey: 'caps.input.image' },
        { id: 'video', labelKey: 'caps.input.video', disabled: true },
      ]

      // 初始化某模型的编辑草稿（从 capabilities 当前值生成；
      // input 未声明时以宿主目录解析的生效值兜底，让 chips 反映真实状态）
      var capsInitDraft = function (provider, model) {
        var list = (capabilities || {})[provider] || []
        var m = list.find(function (x) { return x.id === model }) || {}
        var re = m.reasoningEfforts && typeof m.reasoningEfforts === 'object' ? m.reasoningEfforts : {}
        var ri = (resolvedInput || {})[provider + '/' + model]
        var input = Array.isArray(m.input) ? m.input.slice() : (Array.isArray(ri) ? ri.slice() : [])
        return {
          contextWindow: m.contextWindow !== undefined ? m.contextWindow : '',
          maxTokens: m.maxTokens !== undefined ? m.maxTokens : '',
          reasoningEfforts: JSON.parse(JSON.stringify(re)),
          input: input,
        }
      }

      // 切换模型输入类型草稿（不写服务端；点「保存」才写回）
      var toggleInputDraft = function (provider, model, mod) {
        var key = provider + '/' + model
        setCapsDraft(function (dd) {
          var base = dd[key] || capsInitDraft(provider, model)
          var cur = Array.isArray(base.input) ? base.input : []
          var input = cur.indexOf(mod) >= 0 ? cur.filter(function (x) { return x !== mod }) : cur.concat([mod])
          return Object.assign({}, dd, { [key]: Object.assign({}, base, { input: input }) })
        })
      }

      // 读取草稿（惰性初始化），未初始化时用当前值兜底（同步返回，不依赖 setState）
      var capsGetDraft = function (provider, model) {
        var key = provider + '/' + model
        if (!(key in capsDraft)) {
          setCapsDraft(function (d) { return Object.assign({}, d, { [key]: capsInitDraft(provider, model) }) })
          return capsInitDraft(provider, model)
        }
        return capsDraft[key]
      }

      // ---- 供应商请求头草稿（行编辑：[{name, value}]，保存时折叠为 dict）----
      var headersInitDraft = function (pid) {
        var dict = (providerHeaders || {})[pid] || {}
        return Object.keys(dict).map(function (name) { return { name: name, value: String(dict[name]) } })
      }
      var headersGetDraft = function (pid) {
        if (!(pid in headersDraft)) {
          setHeadersDraft(function (d) { return Object.assign({}, d, { [pid]: headersInitDraft(pid) }) })
          return headersInitDraft(pid)
        }
        return headersDraft[pid]
      }
      var setHeaderRow = function (pid, i, patchRow) {
        setHeadersDraft(function (d) {
          var rows = (d[pid] || headersInitDraft(pid)).slice()
          rows[i] = Object.assign({}, rows[i], patchRow)
          return Object.assign({}, d, { [pid]: rows })
        })
      }
      var addHeaderRow = function (pid) {
        setHeadersDraft(function (d) {
          var rows = (d[pid] || headersInitDraft(pid)).concat([{ name: '', value: '' }])
          return Object.assign({}, d, { [pid]: rows })
        })
      }
      var removeHeaderRow = function (pid, i) {
        setHeadersDraft(function (d) {
          var rows = (d[pid] || headersInitDraft(pid)).filter(function (_, j) { return j !== i })
          return Object.assign({}, d, { [pid]: rows })
        })
      }

      // 新增供应商表单（供应商管理）
      var renderProvForm = function () {
        var d = provDraft || {}
        var set = function (patch) { setProvDraft(Object.assign({}, d, patch)) }
        return [
          React.createElement('div', { className: 'dsh-mr-provgrid', key: 'row1' },
            React.createElement('label', { className: 'dsh-mr-caps-field' },
              React.createElement('span', null, t('prov.field.id')),
              React.createElement('input', { className: 'dsh-mr-caps-hname', value: d.id || '',
                placeholder: 'my-gateway', name: 'provId', autocomplete: 'off', spellCheck: false,
                onChange: function (e) { set({ id: e.target.value }) } })),
            React.createElement('label', { className: 'dsh-mr-caps-field' },
              React.createElement('span', null, t('prov.field.displayName')),
              React.createElement('input', { className: 'dsh-mr-caps-hname', value: d.displayName || '',
                placeholder: t('prov.field.displayNamePh'), name: 'provName', autocomplete: 'off',
                onChange: function (e) { set({ displayName: e.target.value }) } })),
            React.createElement('label', { className: 'dsh-mr-caps-field' },
              React.createElement('span', null, t('prov.field.api')),
              React.createElement('select', { className: 'dsh-mr-caps-hname', value: d.api || 'openai-completions',
                onChange: function (e) { set({ api: e.target.value }) } },
                ['openai-completions', 'openai-responses', 'anthropic-messages'].map(function (a) {
                  return React.createElement('option', { key: a, value: a }, a)
                })))),
          React.createElement('div', { className: 'dsh-mr-provgrid', key: 'row2' },
            React.createElement('label', { className: 'dsh-mr-caps-field' },
              React.createElement('span', null, t('prov.field.baseURL')),
              React.createElement('input', { className: 'dsh-mr-caps-hname', value: d.baseURL || '',
                placeholder: 'https://api.example.com/v1', name: 'provURL', autocomplete: 'off', spellCheck: false,
                onChange: function (e) { set({ baseURL: e.target.value }) } })),
            React.createElement('label', { className: 'dsh-mr-caps-field' },
              React.createElement('span', null, t('prov.field.auth')),
              React.createElement('select', { className: 'dsh-mr-caps-hname', value: d.authMode || 'key',
                onChange: function (e) { set({ authMode: e.target.value }) } },
                React.createElement('option', { value: 'key' }, t('prov.auth.key')),
                React.createElement('option', { value: 'env' }, t('prov.auth.env')),
                React.createElement('option', { value: 'none' }, t('prov.auth.none')))),
            d.authMode === 'key'
              ? React.createElement('label', { className: 'dsh-mr-caps-field' },
                  React.createElement('span', null, t('prov.field.apiKey')),
                  React.createElement('input', { className: 'dsh-mr-caps-hname', type: 'password', value: d.apiKey || '',
                    placeholder: 'sk-…', name: 'provKey', autocomplete: 'off',
                    onChange: function (e) { set({ apiKey: e.target.value }) } }))
              : (d.authMode === 'env'
                ? React.createElement('label', { className: 'dsh-mr-caps-field' },
                    React.createElement('span', null, t('prov.field.apiKeyEnv')),
                    React.createElement('input', { className: 'dsh-mr-caps-hname', value: d.apiKeyEnv || '',
                      placeholder: 'MY_GATEWAY_API_KEY', name: 'provEnv', autocomplete: 'off', spellCheck: false,
                      onChange: function (e) { set({ apiKeyEnv: e.target.value }) } }))
                : null)),
          React.createElement('label', { className: 'dsh-mr-caps-field' },
            React.createElement('span', null, t('prov.field.models')),
            React.createElement('textarea', { className: 'dsh-mr-provmodels', rows: 3, value: d.modelLines || '',
              placeholder: t('prov.field.modelsPh'), name: 'provModels', spellCheck: false,
              onChange: function (e) { set({ modelLines: e.target.value }) } })),
          React.createElement('div', { className: 'dsh-mr-caps-hactions' },
            React.createElement('span', { className: 'dsh-mr-hint' }, t('prov.field.modelsHint')),
            React.createElement('button', { type: 'button', className: 'dsh-mr-add',
              disabled: provSaving, onClick: submitProvider },
              provSaving ? t('common.saving') : t('prov.submit'))),
        ]
      }

      // 渲染模型能力编辑区：按 provider 分组，每个模型一行可编辑
      var renderCapsBody = function () {
        var provs = Object.keys(capabilities || {}).sort()
        if (provs.length === 0) {
          return React.createElement('div', { className: 'dsh-mr-empty',
            title: t('caps.empty.title') },
            t('caps.empty'))
        }
        return React.createElement('div', { className: 'dsh-mr-caps' },
          provs.map(function (pid) {
            var list = capabilities[pid] || []
            var hRows = headersGetDraft(pid)
            var isDeclared = declaredPids.indexOf(pid) >= 0
            var provKey = 'prov:' + pid
            var provOpen = isOpen(provKey)
            return React.createElement('div', { className: 'dsh-mr-caps-prov' + (provOpen ? '' : ' is-collapsed'), key: pid },
              React.createElement('button', { type: 'button', className: 'dsh-mr-caps-provhead dsh-mr-caps-provhead-btn',
                'aria-expanded': provOpen,
                onClick: function () { toggleCard(provKey) } },
                React.createElement('code', { className: 'dsh-mr-id' }, pid),
                isDeclared ? null : React.createElement('span', { className: 'dsh-mr-caps-badge', title: t('caps.catalogBadgeTip') }, t('caps.catalogBadge')),
                React.createElement('span', { className: 'dsh-mr-hint' }, t('caps.models', { n: list.length })),
                React.createElement('button', { type: 'button', className: 'dsh-mr-mini dsh-mr-danger',
                  disabled: !capsWritable || provSaving, title: t('prov.delete'),
                  onClick: function (e) { e.stopPropagation(); deleteProvider(pid) } }, t('common.delete')),
                chevron(provOpen)),
              // ---- 供应商请求头（llm-pi-ai providers.<id>.headers）----
              // OpenCode Go 等供应商要求的会话头（x-opencode-session）在此配置。
              React.createElement('div', { className: 'dsh-mr-caps-headers' },
                React.createElement('div', { className: 'dsh-mr-caps-re-label' },
                  t('caps.headers.label'),
                  React.createElement('span', { className: 'dsh-mr-hint', title: t('caps.headers.tip') }, ' ⓘ')),
                hRows.map(function (row, i) {
                  var name = String((row && row.name) || '')
                  return React.createElement('div', { className: 'dsh-mr-caps-hrow', key: i },
                    React.createElement('input', { type: 'text', className: 'dsh-mr-caps-hname', value: name,
                      placeholder: t('caps.headers.namePh'), name: 'headerName', autocomplete: 'off', spellCheck: false, translate: 'no',
                      'aria-label': t('caps.headers.nameAria', { pid: pid }), disabled: !capsWritable,
                      onChange: function (e) { setHeaderRow(pid, i, { name: e.target.value }) } }),
                    React.createElement('input', { type: 'text', className: 'dsh-mr-caps-hvalue', value: String((row && row.value) || ''),
                      placeholder: t('caps.headers.valuePh'), name: 'headerValue', autocomplete: 'off', spellCheck: false,
                      'aria-label': t('caps.headers.valueAria', { pid: pid, name: name || (i + 1) }), disabled: !capsWritable,
                      onChange: function (e) { setHeaderRow(pid, i, { value: e.target.value }) } }),
                    React.createElement('button', { type: 'button', className: 'dsh-mr-chip-x', disabled: !capsWritable,
                      'aria-label': t('caps.headers.removeAria', { name: name || (i + 1) }), title: t('caps.headers.removeAria', { name: name || (i + 1) }),
                      onClick: function () { removeHeaderRow(pid, i) } }, '×'))
                }),
                React.createElement('div', { className: 'dsh-mr-caps-hactions' },
                  React.createElement('button', { type: 'button', className: 'dsh-mr-mini', disabled: !capsWritable,
                    onClick: function () { addHeaderRow(pid) } }, t('caps.headers.add')),
                  React.createElement('button', { type: 'button', className: 'dsh-mr-add', disabled: headersSavingPid === pid || !capsWritable,
                    onClick: function () { saveHeaders(pid) } },
                    headersSavingPid === pid ? t('common.saving') : t('common.save')))),
              list.map(function (m) {
                var key = pid + '/' + m.id
                var d = capsGetDraft(pid, m.id) || capsInitDraft(pid, m.id)
                var saving = capsSavingKey === key
                var resolvedList = Array.isArray((resolvedInput || {})[key]) ? (resolvedInput || {})[key].join(' + ') : ''
                var draftInput = Array.isArray(d.input) ? d.input : []
                return React.createElement('div', { className: 'dsh-mr-caps-row', key: key },
                  React.createElement('div', { className: 'dsh-mr-caps-head' },
                    React.createElement('code', null, m.id),
                    React.createElement('span', { className: 'dsh-mr-hint' }, m.name && m.name !== m.id ? m.name : '')),
                  React.createElement('div', { className: 'dsh-mr-caps-row1' },
                    React.createElement('label', { className: 'dsh-mr-caps-field' },
                      React.createElement('span', null, 'contextWindow'),
                      React.createElement('input', { type: 'number', min: '1', className: 'dsh-mr-num', value: d.contextWindow,
                        placeholder: t('caps.unset'), name: 'contextWindow', autocomplete: 'off', inputMode: 'numeric',
                        'aria-label': pid + '/' + m.id + ' contextWindow',
                        onChange: function (e) {
                          var v = e.target.value
                          setCapsDraft(function (dd) { return Object.assign({}, dd, { [key]: Object.assign({}, dd[key] || capsInitDraft(pid, m.id), { contextWindow: v }) }) })
                        } })),
                    React.createElement('label', { className: 'dsh-mr-caps-field' },
                      React.createElement('span', null, 'maxTokens'),
                      React.createElement('input', { type: 'number', min: '1', className: 'dsh-mr-num', value: d.maxTokens,
                        placeholder: t('caps.unset'), name: 'maxTokens', autocomplete: 'off', inputMode: 'numeric',
                        'aria-label': pid + '/' + m.id + ' maxTokens',
                        onChange: function (e) {
                          var v = e.target.value
                          setCapsDraft(function (dd) { return Object.assign({}, dd, { [key]: Object.assign({}, dd[key] || capsInitDraft(pid, m.id), { maxTokens: v }) }) })
                        } }))),
                  // ---- 输入类型（models[].input；text/image 可切换，video 待宿主支持）----
                  React.createElement('div', { className: 'dsh-mr-caps-re' },
                    React.createElement('span', { className: 'dsh-mr-caps-re-label' },
                      t('caps.input.label'),
                      resolvedList ? React.createElement('span', { className: 'dsh-mr-hint', title: t('caps.input.resolvedTip') },
                        ' · ' + t('caps.input.resolved', { list: resolvedList })) : null),
                    React.createElement('div', { className: 'dsh-mr-caps-chips' },
                      INPUT_TYPES.map(function (mod) {
                        var label = t(mod.labelKey)
                        if (mod.disabled) {
                          return React.createElement('span', { className: 'dsh-mr-chip is-locked', key: mod.id, title: t('caps.input.videoTip'), 'aria-disabled': 'true' },
                            React.createElement('span', { className: 'dsh-mr-chip-name' }, label))
                        }
                        var enabled = draftInput.indexOf(mod.id) >= 0
                        return React.createElement('button', {
                          type: 'button', key: mod.id, 'aria-pressed': enabled, disabled: !capsWritable,
                          title: t('caps.input.tip'),
                          className: 'dsh-mr-chip dsh-mr-chip-toggle' + (enabled ? ' is-on' : ''),
                          onClick: function () { toggleInputDraft(pid, m.id, mod.id) },
                        },
                          React.createElement('span', { className: 'dsh-mr-chip-name' }, label),
                          enabled ? React.createElement('span', { className: 'dsh-mr-chip-check' }, '✓') : null)
                      }))),
                  React.createElement('div', { className: 'dsh-mr-caps-re' },
                    React.createElement('span', { className: 'dsh-mr-caps-re-label' }, t('effort.label')),
                    React.createElement('div', { className: 'dsh-mr-caps-pickwrap' },
                      React.createElement('button', {
                        type: 'button', className: 'dsh-mr-caps-pick' + (openPick[key] ? ' is-open' : ''),
                        'aria-haspopup': 'listbox', 'aria-expanded': !!openPick[key],
                        onClick: function () { setOpenPick(function (p) { return Object.assign({}, p, { [key]: !p[key] }) }) },
                      },
                        React.createElement('span', null, t('caps.addLevel')),
                        React.createElement('span', { className: 'dsh-mr-caps-pickcaret' }, openPick[key] ? '▴' : '▾')),
                      openPick[key]
                        ? React.createElement('div', { className: 'dsh-mr-caps-picklist', role: 'listbox' },
                            THINKING_LEVELS.map(function (lv) {
                              var enabled = Object.prototype.hasOwnProperty.call(d.reasoningEfforts, lv)
                              return React.createElement('button', {
                                type: 'button', role: 'option', key: lv, 'aria-selected': enabled,
                                className: 'dsh-mr-caps-pickitem' + (enabled ? ' is-on' : ''),
                                onClick: function () {
                                  setCapsDraft(function (dd) {
                                    var base = dd[key] || capsInitDraft(pid, m.id)
                                    var re = Object.assign({}, base.reasoningEfforts || {})
                                    if (enabled) delete re[lv]
                                    else re[lv] = lv === 'off' ? null : (typeof re[lv] === 'string' ? re[lv] : lv)
                                    return Object.assign({}, dd, { [key]: Object.assign({}, base, { reasoningEfforts: re }) })
                                  })
                                },
                              },
                                React.createElement('span', { className: 'dsh-mr-caps-pickitem-name' }, lv),
                                enabled ? React.createElement('span', { className: 'dsh-mr-caps-pickitem-check' }, '✓') : null)
                            }))
                        : null)
                    ,
                    React.createElement('div', { className: 'dsh-mr-caps-chips' },
                      THINKING_LEVELS.map(function (lv) {
                        // 键存在即已启用（off 值为 null 也算启用：支持但不发送 wire）
                        var enabled = Object.prototype.hasOwnProperty.call(d.reasoningEfforts, lv)
                        if (!enabled) return null
                        var wireVal = d.reasoningEfforts[lv] || ''
                        // wire 与档位名不同才显示可编辑输入（保持胶囊简洁 {low ×}）
                        var showWire = lv !== 'off' && wireVal !== '' && wireVal !== lv
                        return React.createElement('span', { className: 'dsh-mr-chip', key: lv, title: t('caps.effortTitle', { lv: lv }) },
                          React.createElement('span', { className: 'dsh-mr-chip-name' }, lv),
                          showWire
                            ? React.createElement('input', {
                                type: 'text', className: 'dsh-mr-chip-wire', value: wireVal,
                                name: 'wire', autocomplete: 'off', spellCheck: false, translate: 'no',
                                'aria-label': t('caps.wireAria', { id: pid + '/' + m.id, lv: lv }),
                                onClick: function (e) { e.stopPropagation() },
                                onChange: function (e) {
                                  var v = e.target.value
                                  setCapsDraft(function (dd) {
                                    var base = dd[key] || capsInitDraft(pid, m.id)
                                    var re = Object.assign({}, base.reasoningEfforts || {})
                                    re[lv] = v
                                    return Object.assign({}, dd, { [key]: Object.assign({}, base, { reasoningEfforts: re }) })
                                  })
                                } })
                            : null,
                          React.createElement('button', {
                            type: 'button', className: 'dsh-mr-chip-x', 'aria-label': t('caps.removeLevelAria', { lv: lv }), title: t('caps.remove', { lv: lv }),
                            onClick: function () {
                              setCapsDraft(function (dd) {
                                var base = dd[key] || capsInitDraft(pid, m.id)
                                var re = Object.assign({}, base.reasoningEfforts || {})
                                delete re[lv]
                                return Object.assign({}, dd, { [key]: Object.assign({}, base, { reasoningEfforts: re }) })
                              })
                            } }, '×'))
                      }))),
                  React.createElement('div', { className: 'dsh-mr-caps-actions' },
                    React.createElement('button', { type: 'button', className: 'dsh-mr-add', disabled: saving || !capsWritable,
                      onClick: function () { saveCapability(pid, m.id) } },
                      saving ? t('common.saving') : t('common.save'))))
              }))
          }))
      }

      if (loading && !data) return React.createElement('div', { className: 'dsh-mr' },
        React.createElement('h2', null, t('panel.title')),
        React.createElement('div', { className: 'dsh-mr-skel' }))

      if (loadError && !data) return React.createElement('div', { className: 'dsh-mr' },
        React.createElement('h2', null, t('panel.title')),
        React.createElement('div', { className: 'dsh-mr-error' }, t('panel.loadFailed') + loadError + ' ',
          React.createElement('button', { type: 'button', onClick: load }, t('common.retry'))))


      var catalog = (data && data.catalog) || {}
      var efforts = (data && data.efforts) || {}
      var health = (data && data.health) || {}
      var providerIds = Object.keys(catalog).sort()
      var routes = (cfg && cfg.routes) || {}

      var setRoute = function (id, patch) {
        setCfg(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          next.routes[id] = Object.assign({}, next.routes[id], patch)
          return next
        })
      }
      var setChain = function (id, slot, chain) {
        var patch = {}; patch[slot] = chain
        setRoute(id, patch)
      }
      var addRoute = function () {
        var id = newId.trim()
        if (!id || !cfg || cfg.routes[id]) return
        setCfg(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          next.routes[id] = { tier1: [], tier2: [], tier3: [] }
          return next
        })
        setNewId('')
      }
      var removeRoute = function (id) {
        setCfg(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          delete next.routes[id]
          return next
        })
      }

      // 档位名称编辑顺序（tier1/tier2/tier3）
      var TIER_ORDER2 = ['tier3', 'tier2', 'tier1']
      // 档位显示名默认值（未自定义时）
      var tierDefaultName = function (slot) {
        return { tier3: 'pro', tier2: 'normal', tier1: 'lite' }[slot] || slot
      }
      // 提交档位显示名（空则删除自定义，恢复默认）
      var commitTierName = function (rid, slot, v) {
        setCfg(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          var r = next.routes[rid] || {}
          var tn = Object.assign({}, (r.tierNames || {}))
          if (v === '') delete tn[slot]
          else tn[slot] = v
          r.tierNames = tn
          next.routes[rid] = r
          return next
        })
      }

      // 候选行编辑器
      var chainEditor = function (id, slot, label, hint) {
        var chain = (routes[id] && routes[id][slot]) || []
        var rt = (routes && routes[id]) || {}
        var tierValue = (rt.tierNames && rt.tierNames[slot]) || ''
        var modelOptions = function (provider, current) {
          var list = (catalog[provider] || []).slice()
          if (current && list.indexOf(current) < 0) list.unshift(current)
          // 模型为空的候选（历史遗留/目录变化）：插入占位项让「未选择」可见可改
          if (!current && list.length > 0) list.unshift('')
          return list
        }
        var effortOptions = function (c) {
          var key = c.provider + '/' + c.model
          // 已保存候选：优先用 state 返回的 efforts（目录档位）
          if (efforts[key]) return { list: efforts[key].slice(), state: 'ready' }
          // 惰性查询过的：用 extraEfforts
          if (extraEfforts[key]) return { list: extraEfforts[key].slice(), state: 'ready' }
          // 未命中且未在查询：发起单候选查询（面板新加未保存候选的真实能力）
          if (!fetchingEfforts[key]) {
            setFetchingEfforts(function (f) { return Object.assign({}, f, { [key]: true }) })
            api('/api/model-router/efforts?provider=' + encodeURIComponent(c.provider) + '&model=' + encodeURIComponent(c.model))
              .then(function (res) {
                setExtraEfforts(function (x) { return Object.assign({}, x, { [key]: (res.efforts || []).slice() }) })
              })
              .catch(function () {
                setExtraEfforts(function (x) { return Object.assign({}, x, { [key]: [] }) })
              })
              .finally(function () {
                setFetchingEfforts(function (f) { var n = Object.assign({}, f); delete n[key]; return n })
              })
          }
          // 查询中：中性状态（不误报「不支持思考级别」）
          return { list: [], state: 'detecting' }
        }
        var update = function (i, patch) {
          var next = chain.map(function (c, j) { return j === i ? Object.assign({}, c, patch) : c })
          setChain(id, slot, next)
        }
        var move = function (i, d) {
          var j = i + d
          if (j < 0 || j >= chain.length) return
          var next = chain.slice()
          var t = next[i]; next[i] = next[j]; next[j] = t
          setChain(id, slot, next)
        }
        return React.createElement('div', { className: 'dsh-mr-chain', key: id + '.' + slot },
          React.createElement('div', { className: 'dsh-mr-chain-head' },
            React.createElement(TierNamePill, { rid: id, slot: slot, dflt: tierDefaultName(slot), value: tierValue,
              onCommit: function (v) { commitTierName(id, slot, v) } }),
            React.createElement('span', { className: 'dsh-mr-chain-count' }, chain.length > 0 ? t('chain.candidates', { n: chain.length }) : t('chain.empty'))),
          chain.length === 0
            ? React.createElement('div', { className: 'dsh-mr-empty', title: t('chain.empty.tip') }, t('chain.empty'))
            : chain.map(function (c, i) {
                var opts = effortOptions(c)
                var eList = opts.list
                // 已保存的思考级别不在当前可选列表时，补一个临时项避免下拉显示空白
                if (c.reasoningEffort && !eList.some(function (e) { return e.id === c.reasoningEffort })) {
                  eList = eList.concat([{ id: c.reasoningEffort, name: c.reasoningEffort + t('effort.stored'), verified: false }])
                }
                var effortState = opts.state
                var hk = c.provider + '/' + c.model
                var h = health[hk]
                var hChip = h && (h.ok + h.fail > 0)
                  ? React.createElement('span', { className: 'dsh-mr-hstat' + ((h.fail > 0) ? ' dsh-mr-hstat-warn' : ''),
                      title: t('health.title', { n: (cfg && cfg.healthWindowSize) || 8, ok: h.ok, fail: h.fail }) },
                      '✓' + h.ok + (h.fail > 0 ? ' ✗' + h.fail : ''))
                  : null
                var effortDisabled = effortState === 'ready' ? eList.length === 0 : true
                var effortLabel = effortState === 'detecting' ? t('effort.detecting')
                  : (eList.length === 0 ? t('effort.unsupported') : t('effort.default'))
                var effortTitle = effortState === 'detecting' ? t('effort.detecting.title')
                  : (eList.length === 0 ? t('effort.unsupported') : (eList.some(function (e) { return !e.verified }) ? t('effort.unverified.title') : t('effort.label')))
                return React.createElement('div', { className: 'dsh-mr-cand', key: i },
                  React.createElement('span', { className: 'dsh-mr-ord' }, (i + 1) + '.'),
                  React.createElement('select', {
                    className: 'dsh-mr-sel', 'aria-label': t('provider'), value: c.provider,
                    onChange: function (e) {
                      var p = e.target.value
                      var models = catalog[p] || []
                      update(i, { provider: p, model: models[0] || c.model })
                    },
                  }, providerIds.map(function (p) {
                    return React.createElement('option', { key: p, value: p }, p)
                  })),
                  React.createElement('select', {
                    className: 'dsh-mr-sel dsh-mr-sel-model', 'aria-label': t('model'),
                    value: c.model, onChange: function (e) { update(i, { model: e.target.value }) },
                  }, modelOptions(c.provider, c.model).map(function (m) {
                    return React.createElement('option', { key: m || '__empty__', value: m }, m || t('chain.pickModel'))
                  })),
                  React.createElement('select', {
                    className: 'dsh-mr-sel dsh-mr-sel-effort', 'aria-label': t('effort.label'),
                    title: effortTitle,
                    value: c.reasoningEffort || '',
                    disabled: effortDisabled,
                    onChange: function (e) {
                      var v = e.target.value
                      var patch = v === '' ? {} : { reasoningEffort: v }
                      if (v === '') delete patch.reasoningEffort
                      update(i, patch)
                    },
                  }, [
                    React.createElement('option', { key: 'default', value: '' }, effortLabel),
                  ].concat(eList.map(function (ef) {
                    return React.createElement('option', { key: ef.id, value: ef.id },
                      ef.name || ef.id + (ef.verified === false ? t('effort.manual') : ''))
                  }))),
                  hChip,
                  React.createElement('span', { className: 'dsh-mr-btns' },
                    React.createElement('button', { type: 'button', className: 'dsh-mr-mini', 'aria-label': t('cand.moveUp'), title: t('cand.up'), disabled: i === 0, onClick: function () { move(i, -1) } }, '↑'),
                    React.createElement('button', { type: 'button', className: 'dsh-mr-mini', 'aria-label': t('cand.moveDown'), title: t('cand.down'), disabled: i === chain.length - 1, onClick: function () { move(i, 1) } }, '↓'),
                    React.createElement('button', { type: 'button', className: 'dsh-mr-mini dsh-mr-danger', 'aria-label': t('cand.delete'), title: t('common.delete'), onClick: function () {
                      setChain(id, slot, chain.filter(function (_, j) { return j !== i }))
                    } }, '×')))
              }),
          React.createElement('button', {
            type: 'button', className: 'dsh-mr-add',
            onClick: function () {
              // 默认取第一个「有可列出模型」的供应商（字母序第一可能是无模型
              // 的适配器，如 deepseek-official），避免创建无效候选
              var p0 = providerIds.find(function (pid) { return (catalog[pid] || []).length > 0 }) || providerIds[0] || ''
              var m0 = (catalog[p0] || [])[0] || ''
              if (!p0 || !m0) {
                setNoticeErr(true)
                setNotice(t('chain.add.noModel'))
                return
              }
              setChain(id, slot, chain.concat([{ provider: p0, model: m0 }]))
            },
          }, t('chain.add')))
      }

      var cooldownList = (data && data.cooldowns) || []
      var historyList = (data && data.history) || []
      var statsMap = (data && data.stats) || {}
      var now = tick || Date.now()

      var fmtRemaining = function (ms) {
        var s = Math.ceil(ms / 1000)
        if (s >= 60) return t('fmt.minSec', { m: Math.floor(s / 60), s: s % 60 })
        return t('fmt.sec', { s: s })
      }
      // 毫秒 → 人类简写（60000→1m，30000→30s），折叠摘要用
      var fmtShortMs = function (ms) {
        var s = Math.round((ms || 0) / 1000)
        return s >= 60 ? Math.round(s / 60) + 'm' : s + 's'
      }
      var fmtTime = function (ts) {
        try {
          return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ts))
        } catch {
          var d = new Date(ts)
          var p = function (n) { return (n < 10 ? '0' : '') + n }
          return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
        }
      }
      var typeLabel = function (type) {
        return {
          started: t('hist.type.started'), failover: t('hist.type.failover'), served: t('hist.type.served'),
          'all-failed': t('hist.type.allFailed'), passthrough: t('hist.type.passthrough'),
          'manual-tier': t('hist.type.manualTier'), 'cooldowns-cleared': t('hist.type.cleared'),
          'skipped-context': t('hist.type.skipped'),
        }[type] || type
      }

      // 卡片渲染辅助（纯函数，无 hook——折叠状态 s24 在 Panel 顶部 hooks 块，
      // 否则会出现在 early return 之后，重渲染时 hook 数量变化 → React #310）
      var isOpen = function (key) { return !!openMap[key] }
      var toggleCard = function (key) {
        setOpenMap(function (m) {
          var n = Object.assign({}, m)
          n[key] = !m[key]
          return n
        })
      }
      var chevron = function (open) {
        return React.createElement(open ? primitives.IconChevronUpOutline14 : primitives.IconChevronDownOutline14, { className: 'dsh-mr-mini-chevron' })
      }
      // 卡片：titleNode（标题）+ extraHead（头部右侧内容，位于标题与 chevron 之间）
      // + body（折叠内容）。head 为整行可点 button；chevron 推到最右。
      // body 包在单容器 div 里：卡片 flex gap 只在 head/body 两子元素间生效，
      // 折叠时只剩 head，卡片高度自然收紧（无需 padding 技巧）。
      // 注意：head 是 <button>，extraHead 里不要再放 <button>（HTML 禁止嵌套交互
      // 元素）——需要交互时用 span + role/tabIndex（如全局总开关），或放 body。
      // 折叠卡片：head 为整行可点 button
      var card = function (key, titleNode, extraHead, body) {
        var open = isOpen(key)
        return React.createElement('div', { className: 'dsh-mr-card' },
          React.createElement('button', {
            type: 'button', className: 'dsh-mr-card-head dsh-mr-card-head-btn',
            'aria-expanded': open,
            onClick: function () { toggleCard(key) },
          },
            React.createElement('b', null, titleNode),
            extraHead || null,
            chevron(open)),
          open ? React.createElement('div', { className: 'dsh-mr-card-body' }, body) : null)
      }
      // 静态卡片（常驻展开）：head 为普通行（不可点），body 包 card-body 容器
      // ——与折叠卡片同构（head/body 各自负责 padding），视觉一致
      var staticCard = function (titleNode, extraHead, body) {
        return React.createElement('div', { className: 'dsh-mr-card' },
          React.createElement('div', { className: 'dsh-mr-card-head dsh-mr-card-head-static' },
            React.createElement('b', null, titleNode),
            extraHead || null),
          React.createElement('div', { className: 'dsh-mr-card-body' }, body))
      }

      // 保存状态常驻面板头（折叠的卡片看不到 body 内的状态提示）
      var saveStatus = React.createElement('span', { className: 'dsh-mr-savestatus', role: 'status', 'aria-live': 'polite' },
        saving ? t('common.saving') : (lastSavedAt ? t('save.savedAt', { time: fmtTime(lastSavedAt) }) : t('save.auto')))
      // 全局卡片折叠摘要（展开时隐藏——body 内已有完整项）
      var globalSummary = isOpen('global') ? null : React.createElement('span', { className: 'dsh-mr-hint' },
        t('global.summary', {
          cd: fmtShortMs(cfg ? cfg.cooldownMs : 0),
          rt: cfg ? cfg.maxRetriesPerCandidate : 0,
          hk: (cfg && cfg.healthRanking) ? t('global.on') : t('global.off'),
        }))

      // 总开关：面板标题行（控制整个插件的启停，属最顶层操作）
      var masterSwitch = React.createElement('span', { className: 'dsh-mr-switch' + ((cfg && cfg.enabled) ? ' is-on' : ''),
        role: 'switch', tabIndex: 0, 'aria-checked': !!(cfg && cfg.enabled), 'aria-label': t('global.master'), title: t('global.master'),
        onClick: function () { setCfg(function (p) { return Object.assign({}, p, { enabled: !p.enabled }) }) },
        onKeyDown: function (e) {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCfg(function (p) { return Object.assign({}, p, { enabled: !p.enabled }) }) }
        } })
      return React.createElement('div', { className: 'dsh-mr' },
        React.createElement('div', { className: 'dsh-mr-headrow' },
          masterSwitch,
          React.createElement('div', { className: 'dsh-mr-headrow-main' },
            React.createElement('h2', null, t('panel.title')),
            React.createElement('p', { className: 'dsh-mr-sub', title: t('panel.desc') },
              t('panel.subtitle'))),
          saveStatus),

        notice !== null
          ? React.createElement('div', { className: noticeErr ? 'dsh-mr-error' : 'dsh-mr-ok', role: noticeErr ? 'alert' : 'status', 'aria-live': 'polite' }, notice)
          : null,

        // ---- 配置组：路由 / 全局 / 供应商能力 ----
        React.createElement('div', { className: 'dsh-mr-group' }, t('group.config')),

        // 统一模型路由（核心区 · 默认展开）
        card('routes', t('routes.title'),
          React.createElement('span', { className: 'dsh-mr-hint' },
            t('routes.summary', {
              n: Object.keys(routes).length,
            })),
          [
            Object.keys(routes).length === 0
              ? React.createElement('div', { className: 'dsh-mr-empty', title: t('routes.emptyTip') },
                  t('routes.empty'))
              : Object.keys(routes).sort().map(function (id) {
                  var st = statsMap[id]
                  var failRate = st && st.requests > 0
                    ? Math.round((st.failovers / st.requests) * 100) + '%'
                    : null
                  return React.createElement('div', { className: 'dsh-mr-route', key: id },
                    React.createElement('div', { className: 'dsh-mr-route-head' },
                      React.createElement('code', { className: 'dsh-mr-id' }, id),
                      st ? React.createElement('span', { className: 'dsh-mr-hint',
                        title: t('route.reqTitle', { n: st.requests, m: st.failovers, rate: failRate || '0%' }) },
                        t('route.reqShort', { n: st.requests }) + (st.failovers > 0 ? t('route.swShort', { n: st.failovers }) : '')) : null,
                      React.createElement('button', { type: 'button', className: 'dsh-mr-mini dsh-mr-danger', title: t('route.delete'),
                        onClick: function () { removeRoute(id) } }, t('common.delete'))),
                    chainEditor(id, 'tier3'),
                    chainEditor(id, 'tier2'),
                    chainEditor(id, 'tier1'))
                }),
            React.createElement('div', { className: 'dsh-mr-newroute' },
              React.createElement('input', { className: 'dsh-mr-text', 'aria-label': t('route.newId'), placeholder: t('route.newIdPh'),
                name: 'newRouteId', autocomplete: 'off', spellCheck: false, translate: 'no',
                value: newId, onChange: function (e) { setNewId(e.target.value) },
                onKeyDown: function (e) { if (e.key === 'Enter') addRoute() } }),
              React.createElement('button', { type: 'button', className: 'dsh-mr-add', disabled: !newId.trim(), onClick: addRoute }, t('common.add'))),
          ]),

        card('global', t('global.title'),
          globalSummary,
          [
            React.createElement('div', { className: 'dsh-mr-grid', key: 'g1' },
              React.createElement('label', { title: t('global.cooldownTip') }, t('global.cooldown'),
                React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 0, step: 1000,
                  name: 'cooldownMs', autocomplete: 'off', inputMode: 'numeric',
                  value: cfg ? cfg.cooldownMs : 0,
                  onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { cooldownMs: Math.max(0, Number(e.target.value) || 0) }) }) } })),
              React.createElement('label', { title: t('global.backoffTip') }, t('global.backoff'),
                React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 1, max: 16,
                  name: 'cooldownBackoff', autocomplete: 'off', inputMode: 'numeric',
                  value: cfg ? cfg.cooldownBackoff : 2,
                  onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { cooldownBackoff: Math.min(16, Math.max(1, Number(e.target.value) || 1)) }) }) } })),
              React.createElement('label', { title: t('global.capTip') }, t('global.cap'),
                React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 0, step: 60000,
                  name: 'cooldownMaxMs', autocomplete: 'off', inputMode: 'numeric',
                  value: cfg ? cfg.cooldownMaxMs : 0,
                  onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { cooldownMaxMs: Math.max(0, Number(e.target.value) || 0) }) }) } })),
              React.createElement('label', { title: t('global.maxSwitchesTip') }, t('global.maxSwitches'),
                React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 1, max: 10,
                  name: 'maxSwitchesPerStep', autocomplete: 'off', inputMode: 'numeric',
                  value: cfg ? cfg.maxSwitchesPerStep : 3,
                  onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { maxSwitchesPerStep: Math.min(10, Math.max(1, Number(e.target.value) || 1)) }) }) } }))),
            React.createElement('label', { className: 'dsh-mr-check', key: 'retry', title: t('global.retryTip') },
              React.createElement('input', { type: 'checkbox', checked: cfg ? cfg.retryOnThrottle !== false : true,
                onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { retryOnThrottle: e.target.checked }) }) } }),
              t('global.retry')),
            React.createElement('div', { className: 'dsh-mr-grid', key: 'g2' },
              React.createElement('label', { title: t('global.retriesTip') }, t('global.retries'),
                React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 0, max: 5,
                  name: 'maxRetriesPerCandidate', autocomplete: 'off', inputMode: 'numeric',
                  value: cfg ? cfg.maxRetriesPerCandidate : 2,
                  onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { maxRetriesPerCandidate: Math.min(5, Math.max(0, Number(e.target.value) || 0)) }) }) } })),
              React.createElement('label', { title: t('global.retryIntervalTip') }, t('global.retryInterval'),
                React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 0, step: 500,
                  name: 'retryBackoffMs', autocomplete: 'off', inputMode: 'numeric',
                  value: cfg ? cfg.retryBackoffMs : 1000,
                  onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { retryBackoffMs: Math.max(0, Number(e.target.value) || 0) }) }) } }))),
            React.createElement('label', { className: 'dsh-mr-check', key: 'health', title: t('global.healthTip') },
              React.createElement('input', { type: 'checkbox', checked: !!(cfg && cfg.healthRanking),
                onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { healthRanking: e.target.checked }) }) } }),
              t('global.health')),
            React.createElement('label', { className: 'dsh-mr-check', key: 'ca', title: t('global.contextAwareTip') },
              React.createElement('input', { type: 'checkbox', checked: cfg ? cfg.contextAware !== false : true,
                onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { contextAware: e.target.checked }) }) } }),
              t('global.contextAware')),
            (cfg && cfg.contextAware !== false) ? React.createElement('div', { className: 'dsh-mr-grid', key: 'g3' },
              React.createElement('label', { title: t('global.marginTip') }, t('global.margin'),
                React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 0.5, max: 1, step: 0.05,
                  name: 'contextMargin', autocomplete: 'off', inputMode: 'decimal',
                  value: cfg ? cfg.contextMargin : 0.9,
                  onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { contextMargin: Math.min(1, Math.max(0.5, Number(e.target.value) || 0.9)) }) }) } })),
              React.createElement('label', { title: t('global.reserveTip') }, t('global.reserve'),
                React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 0, step: 1024,
                  name: 'contextReserveTokens', autocomplete: 'off', inputMode: 'numeric',
                  value: cfg ? cfg.contextReserveTokens : 8192,
                  onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { contextReserveTokens: Math.max(0, Number(e.target.value) || 0) }) }) } }))) : null,
          ]),

        card('caps', t('caps.title'),
          [
            React.createElement('span', { className: 'dsh-mr-hint', key: 'd' },
              t('caps.headDesc', { n: Object.keys(capabilities || {}).length })),
            React.createElement('button', { type: 'button', key: 'add', className: 'dsh-mr-mini',
              disabled: !capsWritable || provSaving, title: t('prov.addTip'),
              onClick: function () { setAddProvOpen(!addProvOpen) } },
              addProvOpen ? t('prov.addCancel') : t('prov.add')),
            React.createElement('span', { className: 'dsh-mr-hint', key: 'w', title: capsWritable ? t('caps.writableTip') : t('caps.readonlyTip') },
              capsWritable ? '' : t('caps.readonly')),
          ],
          [
            addProvOpen
              ? React.createElement('div', { className: 'dsh-mr-provform', key: 'form' }, renderProvForm())
              : null,
            renderCapsBody(),
          ]),

        // ---- 运行状态组：冷却 / 事件 ----
        React.createElement('div', { className: 'dsh-mr-group' }, t('group.runtime')),

        // 冷却中候选（默认折叠 · 头部描述；清空按钮在展开区内）
        card('cooldowns', t('cd.title'),
          cooldownList.length > 0
            ? React.createElement('span', { className: 'dsh-mr-hint dsh-mr-hint-warn' }, t('cd.headDesc', { n: cooldownList.length }))
            : React.createElement('span', { className: 'dsh-mr-hint', title: t('cd.noneTip') }, t('cd.none')),
          [
            cooldownList.length > 0
              ? React.createElement('div', { className: 'dsh-mr-actions', key: 'clear' },
                  React.createElement('button', { type: 'button', className: 'dsh-mr-mini', onClick: clearCooldowns }, t('cd.clearAll')))
              : null,
            cooldownList.map(function (c) {
              var reason = c.code ? (c.code + (c.status ? ' HTTP ' + c.status : '')) : t('cd.unknown')
              var detailTitle = t('cd.reason') + reason +
                (c.streak > 0 ? t('cd.streak', { n: c.streak + 1 }) : '') +
                (c.durationMs ? t('cd.duration', { dur: fmtRemaining(c.durationMs) }) : '')
              return React.createElement('div', { className: 'dsh-mr-cd', key: c.key, title: detailTitle },
                React.createElement('code', null, c.key),
                React.createElement('span', { className: 'dsh-mr-hint' }, reason),
                React.createElement('span', { className: 'dsh-mr-hint' }, t('cd.remaining', { time: fmtRemaining(Math.max(0, c.until - now)) })))
            }),
          ]),

        // ---- 事件历史（默认折叠 · 头部计数 · 展开后只展示最近 10 条）----
        card('history', t('hist.title'),
          historyList.length > 0
            ? React.createElement('span', { className: 'dsh-mr-hint' }, t('hist.headDesc', { n: historyList.length }))
            : React.createElement('span', { className: 'dsh-mr-hint' }, t('hist.none')),
          historyList.length > 0
          ? React.createElement('table', { className: 'dsh-mr-table' },
              React.createElement('thead', null, React.createElement('tr', null,
                React.createElement('th', null, t('hist.time')), React.createElement('th', null, t('hist.type')),
                React.createElement('th', null, t('model')), React.createElement('th', null, t('tier')),
                React.createElement('th', null, t('hist.task')),
                React.createElement('th', null, t('hist.detail')))),
              React.createElement('tbody', null, historyList.slice(0, 10).map(function (h, i) {
                var detail = h.type === 'failover'
                  ? t('hist.failover', { from: h.from, code: h.code + (h.status ? '(HTTP ' + h.status + ')' : '') })
                  : h.type === 'served' ? t('hist.served', { by: h.by })
                  : h.type === 'all-failed' ? t('hist.allFailed', { code: h.code })
                  : h.type === 'passthrough' ? t('hist.passthrough')
                  : h.type === 'started' ? t('hist.started', { cand: h.try || '' })
                  : h.type === 'skipped-context' ? t('hist.skipped', { cand: h.try || '' })
                  : h.type === 'manual-tier' ? t('hist.manual', { tier: h.tier || '' })
                  : t('hist.cleared')
                return React.createElement('tr', { key: i },
                  React.createElement('td', { className: 'dsh-mr-mono' }, fmtTime(h.ts)),
                  React.createElement('td', null, typeLabel(h.type)),
                  React.createElement('td', { className: 'dsh-mr-mono' }, h.model || '—'),
                  React.createElement('td', null, h.tier ? React.createElement('code', { className: 'dsh-mr-tier-tag' }, h.tier) : '—'),
                  React.createElement('td', null, h.purpose || '—'),
                  React.createElement('td', { className: 'dsh-mr-detail' }, detail))
              })))
          : null))

      // tick 引用（每秒刷新冷却剩余时间）
      void now
    }

    // ------------------------------------------------------------------
    // 对话窗口「套餐」选择器（替换原模型选择器，挂在 conversation.input.model）
    // ------------------------------------------------------------------
    // 通过 slot 注入拿到 {available, directory, load, select}：
    //   directory.getSnapshot().current = {provider, model, reasoningEffort?} 当前会话模型
    //   select({provider, model}) = 调 sessions.selectModel 设会话模型
    // 套餐列表来自宿主 /api/model-router/state 的 config.routes 键。
    // 选中套餐 → select({provider: 该套餐 tier2 首候选 provider, model: 套餐ID})，
    // 路由器按 options.model=套餐ID 接管真实路由。
    var TIER_META = { tier1: 'lite', tier2: 'normal', tier3: 'pro' }
    var TIER_ORDER = ['tier3', 'tier2', 'tier1']
    // 档位彩色胶囊配色（用户参考：PRO 紫 / NORMAL 蓝 / LITE 绿）——低饱和底 + 同色系文字
    var TIER_COLOR = {
      tier3: { cls: 'is-pro',    bg: '#F5F0FF', border: '#D8C7FF', text: '#9457E0' },
      tier2: { cls: 'is-normal', bg: '#E6F7FF', border: '#BAE7FF', text: '#1890FF' },
      tier1: { cls: 'is-lite',   bg: '#E6F9F0', border: '#A5EBC9', text: '#2AB67B' },
    }

    // 档位名称胶囊：常态显示彩色胶囊，点击进入就地编辑；Enter/失焦提交，Esc 取消
    function TierNamePill({ rid, slot, dflt, value, onCommit }) {
      var t = useT()
      var s1 = React.useState(false); var editing = s1[0]; var setEditing = s1[1]
      var s2 = React.useState('');    var draft = s2[0]; var setDraft = s2[1]
      var ref = React.useRef(null)
      React.useEffect(function () {
        if (editing && ref.current) { ref.current.focus(); ref.current.select() }
      }, [editing])
      if (!editing) {
        var c = TIER_COLOR[slot] || TIER_COLOR.tier2
        return React.createElement('button', {
          type: 'button', className: 'dsh-mr-tiername-pill',
          style: { background: c.bg, borderColor: c.border, color: c.text },
          title: t('tier.editTip', { dflt: dflt }),
          onClick: function () { setDraft(value); setEditing(true) } },
          value || dflt)
      }
      return React.createElement('input', {
        ref: ref, type: 'text', className: 'dsh-mr-tiername-input',
        name: 'routeTierName-' + rid + '-' + slot, autocomplete: 'off', spellCheck: false, translate: 'no',
        placeholder: dflt, 'aria-label': t('tier.nameAria', { slot: slot }),
        value: draft,
        onChange: function (e) { setDraft(e.target.value) },
        onKeyDown: function (e) {
          if (e.key === 'Enter') { onCommit(draft.trim()); setEditing(false) }
          else if (e.key === 'Escape') { setEditing(false); e.stopPropagation() }
        },
        onBlur: function () { onCommit(draft.trim()); setEditing(false) } })
    }

    function PackageSelect({ available, directory, load, select, sessionId }) {
      var t = useT()
      var s1 = React.useState(false); var open = s1[0]; var setOpen = s1[1]
      var s2 = React.useState(null);  var pkgs = s2[0]; var setPkgs = s2[1]
      var s3 = React.useState(null);  var pkgErr = s3[0]; var setPkgErr = s3[1]
      var s4 = React.useState(false); var busy = s4[0]; var setBusy = s4[1]
      var s9 = React.useState(null);  var manual = s9[0]; var setManual = s9[1]
      var rootRef = React.useRef(null)
      var id = React.useId()

      // directory 为 null = 会话作用域未就绪（directoryFor 抛错的兜底注入面）：
      // 订阅空 store，等真正 entry 重新注入后由宿主重渲染接管。
      var emptyStore = { subscribe: function () { return function () {} }, getSnapshot: function () { return { current: null } } }
      var store = directory || emptyStore
      var state = React.useSyncExternalStore(function (fn) { return store.subscribe(fn) }, function () { return store.getSnapshot() })

      // 档位显示名：当前套餐（displayKey）的 tierNames 优先，缺省用默认 lite/normal/pro
      var tierName = function (slot) {
        if (displayKey && displayKey.tierNames && displayKey.tierNames[slot]) return displayKey.tierNames[slot]
        return TIER_META[slot] || slot
      }

      var refreshPkgs = React.useCallback(function () {
        if (!available) return
        api('/api/model-router/state').then(function (res) {
          var routes = res.config.routes || {}
          var list = Object.keys(routes).sort().map(function (key) {
            var r = routes[key]
            var summary = TIER_ORDER.map(function (slot) {
              var chain = (r[slot] || []).map(function (c) { return c.model })
              return chain.length > 0 ? TIER_META[slot] + ':' + chain.join('/') : null
            }).filter(Boolean)
            var carrier = (r.tier2 && r.tier2[0]) || (r.tier1 && r.tier1[0]) || (r.tier3 && r.tier3[0])
            // models = 三档所有候选模型名（用于把当前真实模型反查回所属套餐）
            var models = TIER_ORDER.reduce(function (acc, slot) {
              var chain = r[slot] || []
              for (var i = 0; i < chain.length; i++) acc.push(chain[i].model)
              return acc
            }, [])
            return { key: key, summary: summary, carrier: carrier || null, models: models, tierNames: r.tierNames || {}, slots: {
              tier1: r.tier1 || [], tier2: r.tier2 || [], tier3: r.tier3 || [],
            } }
          })
          setPkgs(list)
          setManual((res.manualTiers && res.manualTiers[sessionId]) || null)
          setPkgErr(null)
        }).catch(function (e) {
          setPkgErr(String((e && e.message) || e))
        })
      }, [available, sessionId])

      React.useEffect(function () { refreshPkgs() }, [refreshPkgs])

      // 同步当前会话模型：directory.load() 调 sessions.models 把 store.current 设为真实模型
      //（刷新后/默认模型下 current 是 null，会导致套餐匹配失败显示「未配置套餐」）。
      React.useEffect(function () {
        if (!available || !load) return
        load()
      }, [available, load])

      // 打开时刷新（冷却/路由可能变化）
      React.useEffect(function () {
        if (!open) return
        refreshPkgs()
        var closeOutside = function (event) {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return function () { document.removeEventListener('mousedown', closeOutside) }
      }, [open, refreshPkgs])

      var current = state.current
      // 当前套餐：先按「套餐 key == 会话模型名」，再按「候选模型反查套餐」
      //（选套餐时会话模型被设为真实载体模型，如 volcengine/deepseek-v4-flash）
      var activeKey = undefined
      if (current && current.model && pkgs) {
        activeKey = pkgs.find(function (p) { return p.key === current.model }) || pkgs.find(function (p) { return p.models.indexOf(current.model) !== -1 })
      }
      // 新会话/默认模型下 current 为 null 时无 activeKey，会导致显示「未配置套餐」、
      // 菜单也没有档位按钮。回退到第一个套餐作为「显示/交互」的默认套餐
      //（档位仍取默认 normal/tier2），让新会话一眼看到当前生效档位，可直接切档/选套餐。
      var displayKey = activeKey
      if (!displayKey && !current && pkgs && pkgs.length > 0) {
        displayKey = pkgs[0]
      }
      // 生效档位：手动档优先；未手动选择时默认 normal（tier2，主对话的默认路由档）。
      // 触发按钮始终显示「套餐 · 档位」，让新会话一眼看到当前生效档位。
      var effectiveTier = manual || 'tier2'
      // 当前生效档位的首候选思考级别（位置 1 展示用）；无 reasoningEffort 则不显示
      var effectiveEffort = null
      if (displayKey && displayKey.slots && displayKey.slots[effectiveTier]) {
        var effCand = displayKey.slots[effectiveTier][0]
        if (effCand && effCand.reasoningEffort) effectiveEffort = effCand.reasoningEffort
      }
      // 套餐加载时的占位文字
      var triggerName
      if (pkgs === null) {
        triggerName = t('pkg.placeholder')
      } else if (displayKey) {
        triggerName = displayKey.key
      } else if (current) {
        triggerName = current.model
      } else {
        triggerName = t('pkg.none')
      }
      // 档位彩色标签（参考：PRO 紫 / NORMAL 蓝 / LITE 绿）
      var tierColor = TIER_COLOR[effectiveTier] || null
      var tierLabel = tierName(effectiveTier)

      var choose = function (pkg) {
        if (!pkg || !pkg.carrier) return
        if (displayKey && displayKey.key === pkg.key) { setOpen(false); return }
        setBusy(true)
        // 用真实载体模型 selectModel（套餐 key 如 Economy 非真实模型名，会被校验拒绝）
        select({ provider: pkg.carrier.provider, model: pkg.carrier.model })
          .then(function (ok) {
            if (!ok) setPkgErr(t('pkg.selectFailed'))
          })
          .catch(function (e) { setPkgErr(String((e && e.message) || e)) })
          .finally(function () { setBusy(false); setOpen(false) })
      }

      // 手动选档：记录 host 端档位 + 把会话模型切到该档首候选
      var chooseTier = function (slot) {
        if (!displayKey || !sessionId) return
        var cands = (displayKey.slots && displayKey.slots[slot]) || []
        var first = cands[0]
        if (!first) { setPkgErr(t('pkg.tierEmpty')); return }
        setBusy(true)
        api('/api/model-router/tier', { sessionId: sessionId, tier: slot })
          .then(function () { return select({ provider: first.provider, model: first.model }) })
          .then(function (ok) {
            if (!ok) { setPkgErr(t('pkg.tierSwitchFailed')); return }
            setManual(slot)
            setOpen(false)
          })
          .catch(function (e) { setPkgErr(t('pkg.tierSwitchFailedReason') + String((e && e.message) || e)) })
          .finally(function () { setBusy(false) })
      }

      // 注：「自动」选项已按需求移除——手动档选定后一直生效，
      // 想换档直接点其他档位按钮即可（host 端 /api/model-router/tier
      // 仍支持 tier=auto，只是 UI 不再提供入口）。

      return React.createElement('div', { ref: rootRef, className: 'dsh-mrp', onKeyDown: function (e) {
        if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false) }
      } },
        React.createElement('button', {
          ref: null, type: 'button', className: 'dsh-mrp-trigger',
          title: t('pkg.triggerTip'),
          'aria-haspopup': 'menu', 'aria-expanded': open,
          disabled: !available || busy,
          onClick: function () { setOpen(!open) },
        },
          React.createElement('span', { className: 'dsh-mrp-label' },
            React.createElement('span', null, triggerName),
            tierColor
              ? React.createElement('span', {
                  className: 'dsh-mrp-tier-badge',
                  style: { background: tierColor.bg, borderColor: tierColor.border, color: tierColor.text },
                  title: t('pkg.tierTitle', { tier: tierLabel }),
                }, tierLabel)
              : null),
          React.createElement(primitives.IconChevronDownOutline14, { className: 'dsh-mrp-caret' + (open ? ' dsh-mrp-caret-open' : '') })),
        open && React.createElement('div', { className: 'dsh-mrp-menu', role: 'menu' },
          pkgErr !== null
            ? React.createElement('div', { className: 'dsh-mrp-msg' }, t('pkg.loadFailed') + pkgErr)
            : pkgs === null
              ? React.createElement('div', { className: 'dsh-mrp-msg' }, t('pkg.loading'))
              : pkgs.length === 0
                ? React.createElement('div', { className: 'dsh-mrp-msg' }, t('pkg.noneHint'))
                : React.createElement('div', null,
                    // 档位区：作用于当前套餐
                    displayKey
                      ? React.createElement('div', { className: 'dsh-mrp-tiers' },
                          React.createElement('div', { className: 'dsh-mrp-tiers-label' }, t('pkg.tiersLabel', { id: displayKey.key })),
                          TIER_ORDER.map(function (slot) {
                            var cands = (displayKey.slots && displayKey.slots[slot]) || []
                            var on = effectiveTier === slot
                            // 档位按钮只显示档位名（pro/normal/lite），候选明细放悬停 title
                            var label = tierName(slot) + (cands[0] ? '' : t('pkg.unconfigured'))
                            return React.createElement('button', {
                              key: slot, type: 'button', role: 'menuitem',
                              className: 'dsh-mrp-tier' + (on ? ' is-on' : ''),
                              disabled: !cands[0] || busy,
                              title: cands[0] ? t('pkg.useTier', { slot: slot, chain: cands.map(function (c) { return c.provider + '/' + c.model }).join(' → ') }) : t('pkg.tierEmptyTip'),
                              onClick: function () { chooseTier(slot) },
                            },
                              React.createElement('span', { className: 'dsh-mrp-tier-name' }, label),
                              on ? React.createElement('span', { className: 'dsh-mrp-check' }, '✓') : null)
                          })
                       ) : null,
                    React.createElement('div', { className: 'dsh-mrp-divider' }),
                    pkgs.map(function (p) {
                      var on = !!(displayKey && displayKey.key === p.key)
                      return React.createElement('button', {
                        key: p.key, type: 'button', role: 'menuitem',
                        className: 'dsh-mrp-item' + (on ? ' is-on' : ''),
                        onClick: function () { choose(p) },
                      },
                        React.createElement('span', { className: 'dsh-mrp-item-main' },
                          React.createElement('span', { className: 'dsh-mrp-item-name' }, p.key)),
                        on ? React.createElement('span', { className: 'dsh-mrp-check' }, '✓') : null)
                    }))))
    }

    // 运行时路由状态：轮询 model-router state，显示「档位 · 供应商/模型」。
    // 渲染在输入框工具行（conversation.input.left，Full access 与套餐选择器之间）。
    // 数据源只有 /api/model-router/state 的 history（record() 内存记录，带 sessionId）。
    // 不再订阅会话事件流——路由事件不落会话日志（避免卸载后历史会话拒载 + 日志噪音），
    // 徽章按 sessionId 过滤 history、按 ts 取最新，2s 轮询对一个「显示当前模型」的
    // 徽章已足够实时。单一数据源也消除了过去「事件流 vs 轮询」两源互踩导致的闪烁。
    function OverlayStatus(props) {
      var t = useT()
      var s1 = React.useState(null); var latest = s1[0]; var setLatest = s1[1]
      var s3 = React.useState(false); var err = s3[0]; var setErr = s3[1]
      // 配置源（设置页路由配置）：cfgModelInfo = { provider, model, effort, tier }（当前会话命中项）
      var s4 = React.useState(null); var cfgInfo = s4[0]; var setCfgInfo = s4[1]
      // 当前会话模型（来自 modelDirectories）
      var s5 = React.useState(null); var curModel = s5[0]; var setCurModel = s5[1]

      React.useEffect(function () {
        var alive = true
        var timer = null
        var sid = props.sessionId
        // 主路径：轮询 state history
        var tick = function () {
          if (!alive) return
          api('/api/model-router/state').then(function (res) {
            if (!alive) return
            // 配置源：从 routes 反查当前会话命中的候选（供应商/模型/思考级别都来自设置页配置）
            try {
              var routes = res.config && res.config.routes
              var manualTiers = res.manualTiers || {}
              // 当前会话真实模型：目录 current（与 PackageSelect 一致）；拿不到时用事件里的全名
              var cur = curModel
              if (!cur && props.directory) {
                var st = props.directory.getSnapshot && props.directory.getSnapshot()
                if (st && st.current && st.current.model) cur = st.current.model
              }
              if (routes) {
                var manual = manualTiers[sid] || null
                var hit = null
                // 当前生效档位（与 PackageSelect 档位徽章一致）：手动档优先，否则默认 tier2
                var effSlot = (manual && (manual === 'tier1' || manual === 'tier2' || manual === 'tier3')) ? manual : 'tier2'
                for (var k in routes) {
                  var r = routes[k] || {}
                  for (var ti = 0; ti < TIER_ORDER.length; ti++) {
                    var slot = TIER_ORDER[ti]
                    var chain = r[slot] || []
                    for (var ci = 0; ci < chain.length; ci++) {
                      var cand = chain[ci]
                      // 命中条件：当前模型名匹配，或（无模型信息时）该档位是手动/默认档
                      var modelHit = cur ? cand.model === cur : slot === effSlot
                      if (modelHit) {
                        // 记录「当前档位（effSlot）首候选」+ 完整候选链，供 OverlayStatus
                        // 一致性兜底：若最新路由事件用的候选不在当前档位链里（历史残留，
                        // 如 cur 还停留在夯档的 glm-5.3 而手动档已切到 NPC），显示当前
                        // 档位首候选而非残留的历史模型。
                        var slotChain = (r[effSlot] || []).slice()
                        var first = slotChain[0] || null
                        hit = {
                          provider: cand.provider, model: cand.model, effort: cand.reasoningEffort || null,
                          tier: slot, pkg: k, manual: !!manual, effSlot: effSlot, slotChain: slotChain,
                          effFirst: first ? { provider: first.provider, model: first.model, effort: first.reasoningEffort || null } : null,
                        }
                        break
                      }
                    }
                    if (hit) break
                  }
                  if (hit) break
                }
                setCfgInfo(hit)
              }
            } catch (e) { /* 配置解析失败不影响运行时状态 */ }
            var h = res.history || []
            // 只取「本会话」的路由记录（多会话并行时避免显示别的会话的模型）。
            var mine = []
            for (var i = 0; i < h.length; i++) {
              var r = h[i]
              var rsid = r.sessionId !== undefined ? r.sessionId : (r.type === 'manual-tier' ? r.model : null)
              if (rsid !== sid) continue
              // 只认状态事件；manual-tier 不携带 try/by，作为最新状态会清空显示
              if (r.type === 'started' || r.type === 'served' || r.type === 'all-failed') mine.push(r)
            }
            // 取最新一条状态记录。注意服务端 history 是 .reverse() 后的
            // 「最新在前」顺序（供面板历史列表直接渲染），这里不能再按下标
            // 取 mine[mine.length-1]——那是最旧一条！（曾导致长会话缓冲区里
            // 残留的昨日 tier2 事件被当成最新状态，与事件流路径的真最新
            // tier3 事件来回覆盖，徽章在两个模型间跳动。）按 ts 显式取最大，
            // 与服务端数组顺序彻底解耦。
            var entry = null
            for (var j = 0; j < mine.length; j++) {
              var cand = mine[j]
              if (!entry || (cand.ts || 0) > (entry.ts || 0)) entry = cand
            }
            if (entry) {
              setLatest(entry)
            }
            setErr(null)
          }).catch(function (e) { if (alive) setErr(String((e && e.message) || e)) })
          timer = setTimeout(tick, 2000)
        }
        tick()
        return function () {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [props.sessionId])

      // 读取当前会话模型（modelDirectories 的 current），用于从配置反查套餐/档位/思考级别
      React.useEffect(function () {
        if (!props.directory) return
        var sync = function () {
          try {
            var st = props.directory.getSnapshot && props.directory.getSnapshot()
            if (st && st.current && st.current.model) setCurModel(st.current.model)
          } catch (e) {}
        }
        sync()
        var un = null
        try { un = props.directory.subscribe(sync) } catch (e) {}
        return function () { if (un) { try { un() } catch (e) {} } }
      }, [props.directory])

      if (err) {
        return React.createElement('div', { className: 'dsh-mr-overlay dsh-mr-overlay-err' }, t('overlay.unavailable'))
      }
      // 思考级别：与模型名同源——优先从路由事件（latest.effort）取，
      // 保证「模型 + 思考级别」始终是同一个候选的真实配置；无请求历史时
      // 才用配置反查（cfgInfo.effort）。之前 eff 从 cfgInfo 取而 full 从
      // 事件取，两个数据源不同步会出现配置里不存在的组合（如 NPC 档显示
      // 夯档的 glm-5.3 + max——glm-5.3 在 tier3 无 effort，max 其实是
      // 当前档位首候选 deepseek-v4-flash 的配置）。
      var eff = (latest && latest.effort) || (cfgInfo && cfgInfo.effort) || null
      if (!latest) {
        // 无请求历史（新会话 / 停止任务后 latest 为空）：展示「当前档位」候选。
        // 必须用当前档位（manual 或默认 tier2）的首候选（effFirst），与
        // PackageSelect 档位徽章一致——不能用 cfgInfo.provider/model（那是
        // cur 命中的候选，可能是历史残留的夯档模型，如 cur=k3 而档位已 NPC）。
        if (!cfgInfo) return null
        var fallback0 = (cfgInfo.effFirst || { provider: cfgInfo.provider, model: cfgInfo.model, effort: cfgInfo.effort || null })
        var f0 = fallback0.provider + '/' + fallback0.model
        return React.createElement('div', { className: 'dsh-mr-overlay', title: fallback0.effort ? t('overlay.titleEffort', { full: f0, effort: fallback0.effort }) : f0 },
          React.createElement('span', { className: 'dsh-mr-overlay-who' }, f0),
          fallback0.effort ? React.createElement('span', { className: 'dsh-mr-overlay-effort', title: t('overlay.effortTitle', { effort: fallback0.effort }) }, fallback0.effort) : null)
      }
      // 全部失败（候选耗尽/全冷却）：显示「路由失败」提示而非完全消失。
      if (latest.type === 'all-failed') {
        return React.createElement('div', { className: 'dsh-mr-overlay dsh-mr-overlay-err', title: t('overlay.allFailedTip') },
          t('overlay.routeFailed'))
      }
      // 显示完整「供应商/模型」（如 volcengine-main/deepseek-v4-flash）。
      // 高亮恒定：不随单个请求 started/served 亮灭——agent 工具循环里每步请求
      // 都是一对 started→served，亮灭跟随会让徽章高频闪烁。有路由状态即恒亮。
      //
      // 一致性：模型名与思考级别必须同源（都来自同一个候选）。优先用最新
      // 路由事件（实际用了谁 + 它的 effort）；但若该候选不属于「当前档位链」
      //（手动档位已切走、事件是历史残留），则显示当前档位首候选 + 其 effort，
      // 与 PackageSelect 的档位徽章（如 NPC）保持一致——避免出现
      // 「档位 NPC + 夯档模型 glm-5.3」这种配置里不存在的组合。
      var full = latest.try || latest.by || ''
      var inSlot = false
      if (full && cfgInfo && cfgInfo.slotChain) {
        inSlot = cfgInfo.slotChain.some(function (sc) { return sc && (sc.provider + '/' + sc.model) === full })
      }
      if (!inSlot && cfgInfo && cfgInfo.effFirst) {
        // 当前档位首候选（与 PackageSelect 档位徽章同源），模型+思考级别同源
        full = cfgInfo.effFirst.provider + '/' + cfgInfo.effFirst.model
        eff = cfgInfo.effFirst.effort || null
      }
      if (!full) return null
      return React.createElement('div', { className: 'dsh-mr-overlay dsh-mr-overlay-active', title: eff ? t('overlay.titleEffort', { full: full, effort: eff }) : full },
        React.createElement('span', { className: 'dsh-mr-overlay-who' }, full),
        eff ? React.createElement('span', { className: 'dsh-mr-overlay-effort', title: t('overlay.effortTitle', { effort: eff }) }, eff) : null)
    }

    function apply(ctx) {
      var styleEl = document.createElement('style')
      styleEl.id = 'dsh-mr-style'
      styleEl.textContent = [
        '.dsh-mr { display: flex; flex-direction: column; gap: 14px; max-width: 720px; width: 100%; color: var(--dsw-alias-label-primary); touch-action: manipulation; -webkit-tap-highlight-color: transparent; }',
        '.dsh-mr h2 { margin: 0; font-size: 16px; font-weight: 600; text-wrap: balance; }',
        '.dsh-mr-sub { margin: 2px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; text-wrap: pretty; }',
        '.dsh-mr-card { display: flex; flex-direction: column; gap: 0; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }',
        '.dsh-mr-card-body { display: flex; flex-direction: column; gap: 10px; padding: 6px 14px 14px; }',
        '.dsh-mr-card-head { display: flex; align-items: center; gap: 8px; }',
        // 可折叠卡片头：整行可点（button 复位默认样式），chevron 推到右侧
        'button.dsh-mr-card-head-btn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 14px; border: none; background: none; color: inherit; text-align: left; cursor: pointer; font: inherit; }',
        '.dsh-mr-card-head-static { padding: 14px; }',
        // 新增供应商表单
        '.dsh-mr-provform { display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 8px; }',
        '.dsh-mr-provgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }',
        '.dsh-mr-provmodels { width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; outline: none; resize: vertical; box-sizing: border-box; }',
        '.dsh-mr-provmodels:focus { border-color: var(--dsw-alias-brand-primary); }',
        'button.dsh-mr-card-head-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }',
        'button.dsh-mr-card-head-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }',
        'button.dsh-mr-card-head-btn .dsh-mr-mini-chevron { margin-left: auto; color: var(--dsw-alias-label-tertiary); flex: none; }',
        // 头部计数徽章（冷却候选/事件历史条数）
        '.dsh-mr-group { margin: 4px 0 -8px; font-size: 11px; font-weight: 600; letter-spacing: .06em; color: var(--dsw-alias-label-tertiary); }',
        '.dsh-mr-hint-warn { color: #A05A00; }',
        // 有内容的计数徽章用暖色提醒（如冷却中/历史条数）
        '.dsh-mr-count-badge.is-active { color: #A05A00; background: #FFF1E0; }',
        // 面板头：标题/副标题居左，保存状态居右常驻
        '.dsh-mr-headrow { display: flex; align-items: center; gap: 12px; }',
        '.dsh-mr-headrow-main { flex: 1; min-width: 0; }',
        '.dsh-mr-headrow .dsh-mr-savestatus { flex: none; padding-bottom: 2px; }',
        '.dsh-mr-card-head b { font-size: 13px; }',
        '.dsh-mr-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }',
        '.dsh-mr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }',
        '.dsh-mr-subsec { display: flex; align-items: baseline; gap: 6px; }',
        '.dsh-mr-subsec-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
        '.dsh-mr-tiername-pill { display: inline-flex; align-items: center; padding: 2px 12px; border-radius: 999px; border: 1px solid; font-size: 11px; font-weight: 700; letter-spacing: .3px; line-height: 18px; cursor: pointer; text-transform: uppercase; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; transition: filter .15s ease; }',
        '.dsh-mr-tiername-pill:hover { filter: brightness(.97); }',
        '.dsh-mr-tiername-pill:focus-visible, .dsh-mr-tiername-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        '.dsh-mr-tiername-input { width: 96px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: inherit; font-size: 12px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; outline: none; }',
        '.dsh-mr-tiername-input:focus { border-color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-grid label[title^="档位"] .dsh-mr-text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mr-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
        '.dsh-mr-check input { accent-color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-num, .dsh-mr-text { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: inherit; font-size: 13px; outline: none; }',
        '.dsh-mr-num:focus, .dsh-mr-text:focus { border-color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-num:focus-visible, .dsh-mr-text:focus-visible, .dsh-mr-sel:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        '.dsh-mr-text { flex: 1; }',
        '.dsh-mr-actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; }',
        '.dsh-mr-savestatus { font-size: 12px; color: var(--dsw-alias-text-secondary, #6e7781); display: inline-flex; align-items: center; gap: 6px; }',
        '.dsh-mr-switch { position: relative; flex: none; width: 36px; height: 20px; border-radius: 999px; border: none; background: var(--dsw-alias-border-l2); cursor: pointer; transition: background .15s ease; padding: 0; display: inline-block; font: inherit; }',
        'span.dsh-mr-switch:hover { background: color-mix(in srgb, var(--dsw-alias-border-l2) 80%, var(--dsw-alias-label-tertiary)); }',
        '.dsh-mr-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
        '.dsh-mr-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-overlay); transition: transform .15s ease; box-shadow: 0 1px 2px rgba(0,0,0,.3); }',
        '.dsh-mr-switch.is-on { background: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-switch.is-on::after { transform: translateX(16px); }',
        '.dsh-mr-cd { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-variant-numeric: tabular-nums; }',
        '.dsh-mr-caps { display: flex; flex-direction: column; gap: 12px; }',
        '.dsh-mr-caps-prov { display: flex; flex-direction: column; gap: 8px; }',
        '.dsh-mr-caps-provhead { display: flex; align-items: center; gap: 8px; }',
        // 供应商折叠：收起时隐藏 provhead 之后的全部兄弟（请求头编辑器 + 模型编辑区）
        '.dsh-mr-caps-prov.is-collapsed > :not(.dsh-mr-caps-provhead) { display: none; }',
        'button.dsh-mr-caps-provhead-btn { width: 100%; border: none; background: none; color: inherit; text-align: left; cursor: pointer; font: inherit; padding: 2px 0; }',
        'button.dsh-mr-caps-provhead-btn:hover > .dsh-mr-id { text-decoration: underline; }',
        '.dsh-mr-caps-row { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
        '.dsh-mr-caps-head { display: flex; align-items: baseline; gap: 8px; }',
        '.dsh-mr-caps-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }',
        '.dsh-mr-caps-row1 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }',
        '.dsh-mr-caps-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-caps-re { display: flex; flex-direction: column; gap: 6px; }',
        '.dsh-mr-caps-re-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-caps-pickwrap { position: relative; display: inline-flex; align-self: flex-start; }',
        '.dsh-mr-caps-pick { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }',
        '.dsh-mr-caps-pick:hover, .dsh-mr-caps-pick.is-open { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }',
        '.dsh-mr-caps-pick:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        '.dsh-mr-caps-pickcaret { font-size: 9px; color: var(--dsw-alias-label-tertiary); }',
        '.dsh-mr-caps-picklist { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; min-width: 160px; padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-specific-menu); box-shadow: var(--dsw-shadow-lv3); display: flex; flex-direction: column; gap: 1px; }',
        '.dsh-mr-caps-pickitem { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 5px 8px; border: none; border-radius: 6px; background: none; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; text-align: left; }',
        '.dsh-mr-caps-pickitem:hover { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mr-caps-pickitem:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }',
        '.dsh-mr-caps-pickitem.is-on .dsh-mr-caps-pickitem-name { color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-caps-pickitem-check { color: var(--dsw-alias-brand-primary); font-size: 12px; }',
        '.dsh-mr-caps-pickitem-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }',
        '.dsh-mr-caps-chips { display: flex; flex-wrap: nowrap; align-items: center; gap: 6px; overflow-x: auto; min-width: 0; padding-bottom: 2px; }',
        '.dsh-mr-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 11px; flex: none; }',
        '.dsh-mr-chip-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; }',
        '.dsh-mr-chip-wire { width: 48px; padding: 1px 4px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; outline: none; }',
        '.dsh-mr-chip-wire:hover, .dsh-mr-chip-wire:focus { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }',
        '.dsh-mr-chip-wire:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        '.dsh-mr-chip-x { border: none; background: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1; padding: 1px 3px; cursor: pointer; border-radius: 50%; }',
        '.dsh-mr-chip-x:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mr-chip-x:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        // ---- 模型能力：输入类型 toggle 胶囊 / 目录供应商徽章 / 请求头编辑器 ----
        '.dsh-mr-chip-toggle { cursor: pointer; color: var(--dsw-alias-label-tertiary); padding: 2px 9px; }',
        '.dsh-mr-chip-toggle:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }',
        '.dsh-mr-chip-toggle.is-on { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }',
        '.dsh-mr-chip-toggle:disabled { opacity: .45; cursor: default; }',
        '.dsh-mr-chip.is-locked { opacity: .4; }',
        '.dsh-mr-chip-check { font-size: 10px; line-height: 1; }',
        '.dsh-mr-caps-badge { flex: none; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 999px; color: var(--dsw-alias-label-tertiary); border: 1px solid var(--dsw-alias-border-l1); }',
        '.dsh-mr-caps-headers { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 8px; }',
        '.dsh-mr-caps-hrow { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto; gap: 6px; align-items: center; }',
        '.dsh-mr-caps-hname, .dsh-mr-caps-hvalue { min-width: 0; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; outline: none; }',
        '.dsh-mr-caps-hname:focus, .dsh-mr-caps-hvalue:focus { border-color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-caps-hname::placeholder, .dsh-mr-caps-hvalue::placeholder { color: var(--dsw-alias-label-caption); }',
        '.dsh-mr-caps-hactions { display: flex; align-items: center; gap: 8px; }',
        '.dsh-mr-caps-actions { display: flex; justify-content: flex-end; }',
        '.dsh-mr-route { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }',
        '.dsh-mr-route-head { display: flex; align-items: center; gap: 10px; }',
        '.dsh-mr-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; font-weight: 700; color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-chain { display: flex; flex-direction: column; gap: 6px; }',
        '.dsh-mr-chain-head { display: flex; align-items: center; gap: 8px; }',
        '.dsh-mr-chain-label { font-size: 12px; font-weight: 600; }',
        '.dsh-mr-chain-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-chain-count { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-caption); flex: none; }',
        '.dsh-mr-cand { display: grid; grid-template-columns: 22px minmax(90px, 1fr) minmax(110px, 1.4fr) 120px auto auto; align-items: center; gap: 6px; padding: 2px 4px; min-width: 0; }',
        '.dsh-mr-hstat { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; font-weight: 600; color: var(--dsw-alias-state-success-primary, #34c759); white-space: nowrap; flex: none; font-variant-numeric: tabular-nums; }',
        '.dsh-mr-hstat-warn { color: var(--dsw-alias-state-error-primary); }',
        '.dsh-mr-cand:hover { background: var(--dsw-alias-interactive-bg-hover); border-radius: 8px; }',
        '.dsh-mr-ord { font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary); width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); flex: none; }',
        '.dsh-mr-sel { width: 100%; min-width: 0; max-width: none; padding: 5px 6px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font-size: 12px; outline: none; text-overflow: ellipsis; }',
        '.dsh-mr-sel-model { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mr-sel-effort { color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-sel-effort:disabled { opacity: .55; cursor: not-allowed; }',
        '.dsh-mr-tier-tag { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }',
        '.dsh-mr-slash { color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-btns { display: flex; gap: 4px; flex: none; justify-content: flex-end; }',
        '.dsh-mr-mini { padding: 3px 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; line-height: 1.2; }',
        '.dsh-mr-mini:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-mini-toggle { display: inline-flex; align-items: center; gap: 4px; }',
        '.dsh-mr-mini-chevron { display: inline-flex; flex: none; }',
        '.dsh-mr-mini:disabled { opacity: .4; cursor: default; }',
        '.dsh-mr-danger:hover { color: var(--dsw-alias-state-error-primary) !important; border-color: var(--dsw-alias-state-error-primary) !important; }',
        '.dsh-mr-add { align-self: flex-start; padding: 4px 12px; border-radius: 8px; border: 1px dashed var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }',
        '.dsh-mr-add:hover:not(:disabled) { color: var(--dsh-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-add:disabled { opacity: .5; cursor: default; }',
        '.dsh-mr-newroute { display: flex; gap: 8px; }',
        '.dsh-mr-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
        '.dsh-mr-table th { text-align: left; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-table td { padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }',
        '.dsh-mr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mr-detail { color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 10px 0; }',
        '.dsh-mr-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary, #34c759); padding: 8px 12px; border: 1px solid currentColor; border-radius: 8px; }',
        '.dsh-mr-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); padding: 8px 12px; border: 1px solid currentColor; border-radius: 8px; }',
        '.dsh-mr-skel { height: 120px; border-radius: 12px; background: linear-gradient(90deg, var(--dsw-alias-bg-layer-1) 25%, var(--dsw-alias-bg-layer-2) 50%, var(--dsw-alias-bg-layer-1) 75%); background-size: 200% 100%; animation: dsh-mr-shimmer 1.2s infinite; }',
        '@keyframes dsh-mr-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }',
        '@media (prefers-reduced-motion: reduce) { .dsh-mr-skel, .dsh-mr-switch, .dsh-mr-caret, .dsh-mr-caret-open { animation: none !important; transition: none !important; } }',
        // ---- 对话窗口套餐选择器 ----
        '.dsh-mrp { position: relative; display: inline-flex; min-width: 0; }',
        '.dsh-mrp-trigger { min-width: 0; max-width: 220px; height: 28px; color: var(--dsw-alias-label-secondary); cursor: pointer; background: none; border: none; border-radius: 24px; outline: none; align-items: center; gap: 4px; padding: 0 4px 0 8px; font-size: 13px; font-weight: 500; line-height: 20px; display: flex; }',
        '.dsh-mrp-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mrp-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; border-radius: 24px; }',
        '.dsh-mrp-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }',
        '.dsh-mrp-label { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; display: flex; align-items: center; gap: 6px; }',
        '.dsh-mrp-tier-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; border: 1px solid; font-size: 11px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; line-height: 16px; }',
        '.dsh-mrp-effort { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }',
        '.dsh-mrp-caret { color: var(--dsw-alias-label-caption); flex: none; display: inline-flex; transition: transform .12s ease; }',
        '.dsh-mrp-caret-open { transform: rotate(180deg); }',
        '.dsh-mrp-menu { z-index: 20; min-width: 0; width: max-content; max-width: min(340px, 100vw - 32px); max-height: min(360px, 100vh - 96px); overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--dsw-alias-border-inverted); background: var(--dsw-specific-menu); box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); border-radius: 12px; flex-direction: column; padding: 4px; display: flex; position: absolute; bottom: calc(100% + 8px); right: 0; }',
        '.dsh-mrp-msg { color: var(--dsw-alias-label-tertiary); padding: 10px; font-size: 13px; line-height: 20px; }',
        '.dsh-mrp-item { width: 100%; min-height: 44px; color: inherit; text-align: left; cursor: pointer; background: none; border: none; border-radius: 10px; outline: none; align-items: center; gap: 8px; padding: 6px 8px; display: flex; }',
        '.dsh-mrp-item:hover:not(:disabled), .dsh-mrp-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mrp-item.is-on { background: none; }',
        '.dsh-mrp-item-main { flex-direction: column; flex: 1; min-width: 0; display: flex; }',
        '.dsh-mrp-item-name { color: inherit; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; line-height: 20px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mrp-item-summary { color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 18px; overflow: hidden; }',
        '.dsh-mrp-check { color: var(--dsw-alias-label-primary); flex: 0 0 18px; place-items: center; display: grid; }',
        '.dsh-mrp-tiers { flex-direction: column; display: flex; gap: 2px; padding: 2px 0 4px; }',
        '.dsh-mrp-tiers-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 18px; padding: 2px 8px 4px; }',
        '.dsh-mrp-tier { width: 100%; min-height: 34px; color: var(--dsw-alias-label-secondary); text-align: left; cursor: pointer; background: none; border: none; border-radius: 8px; outline: none; align-items: center; gap: 8px; padding: 4px 8px; display: flex; font-size: 13px; }',
        '.dsh-mrp-tier:hover:not(:disabled), .dsh-mrp-tier:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mrp-tier.is-on { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mrp-tier:disabled { opacity: .45; cursor: default; }',
        '.dsh-mrp-tier-name { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; flex: 1; }',
        '.dsh-mrp-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 2px 0 4px; flex: none; }',
        // ---- 运行时路由状态（输入框工具行）----
        '.dsh-mr-overlay { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: 999px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2); white-space: nowrap; }',
        '.dsh-mr-overlay-active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mr-overlay-tier { font-weight: 600; }',
        '.dsh-mr-overlay-sep { color: var(--dsw-alias-label-caption); }',
        '.dsh-mr-overlay-who { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mr-overlay-effort { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 999px; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }',
        '.dsh-mr-overlay-phase { color: var(--dsw-alias-label-caption); }',
        '.dsh-mr-overlay-err { color: var(--dsw-alias-state-error-primary); }',
      ].join('\n')
      document.head.appendChild(styleEl)

      // locale 服务（@deepseek-ai/dsh-client-locale，宿主 0.1.0-rc.8+ 提供）：
      // 注册本插件命名空间字典、绑定 t、订阅语言切换。独立 inject 组 ——
      // 极老宿主没有 locale 服务时该组不触发，面板以 zh 字典回退，不受影响。
      ctx.inject(['locale'], function (lscope) {
        var locale = lscope.locale
        if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return
        ctx.effect(function () { return locale.register(MR_NS, { zh: DICT_ZH, en: DICT_EN }) }, 'dsh-model-router: locale dictionaries')
        tRef.current = locale.bind(MR_NS)
        localeRevision += 1
        ctx.effect(function () {
          return locale.subscribe(function () {
            localeRevision += 1
            localeListeners.forEach(function (fn) { try { fn() } catch (e) { /* 单个订阅者崩溃不拖垮其它 */ } })
          })
        }, 'dsh-model-router: locale reactivity')
      })

      // sessions 必须声明在 inject 列表：Cordis 对未声明服务的属性访问直接抛
      // "cannot get property sessions without inject"（曾导致回调死亡、面板/选择器全消失）。
      // remote.session 必须声明（0.1.5+ 的 modelDirectories.directoryFor 内部走 sessions.scope/binding →
      // remote.session；会话作用域的 entry inject 在插件 fiber 上执行，未声明会被 cordis 权限检查拒绝——
      // 表现为 entry 被静默摘除，对话窗口的套餐选择器/路由徽章全部消失）。
      ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'], function (scope) {
        var models = scope.modelDirectories
        var sessions = scope.sessions
        scope.slots.inject('settings.section', function () {
          return scope.slots.register(
            { name: 'settings.section', id: 'model-router', order: 13,
              label: function () { return tRef.current('panel.title') }, locale: MR_NS },
            function () { return React.createElement(Panel) }
          )
        })
        // 对话窗口「套餐」选择器 —— 遮蔽原生模型选择器。
        // 说明：ui-model-selection 保持启用（否则 modelDirectories/models 服务不存在）。
        // single slot 按 priority 升序取 [0]（lowest renders），priority:-1 遮蔽其默认 0。
        // 渲染方只传 {locked}；available/directory/load/select 必须由注册方 inject 提供
        //（复刻原 ui-model-selection 的 inject face，否则 PackageSelect 收到空 props 而崩溃）。
        scope.slots.inject('conversation.input.model', function () {
          return scope.slots.register({
            name: 'conversation.input.model',
            id: 'dsh-model-router-package',
            order: 10,
            priority: -1,
            inject: function (sessionId) {
              var directory = models.directoryFor(sessionId)
              var available = sessions.subagentAddress(sessionId) === undefined
              return {
                sessionId: sessionId,
                available: available,
                directory: directory.store,
                load: function () {
                  if (available) directory.load().catch(function () {})
                },
                select: function (selection) {
                  return available ? directory.select(selection).then(function () { return true }, function () { return false }) : Promise.resolve(false)
                },
              }
            },
          }, function (props) { return React.createElement(PackageSelect, props) })
        })
        // 运行时路由状态：渲染在输入框工具行（conversation.input.left，
        // Full access 与套餐选择器之间），显示档位 + 实际供应商/模型。
        scope.slots.inject('conversation.input.left', function () {
          return scope.slots.register({
            name: 'conversation.input.left',
            id: 'dsh-model-router-live',
            order: 5,
            inject: function (sessionId) {
              var models = scope.modelDirectories
              var directory = models ? models.directoryFor(sessionId) : undefined
              return { sessionId: sessionId, directory: directory }
            },
          }, function (props) { return React.createElement(OverlayStatus, props) })
        })
      })

      return function () {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      }
    }

    exports.apply = apply
    return module.exports
  },
})
