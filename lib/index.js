// dsh-model-router — DSH 统一模型路由插件（Host 半）
//
// 能力：
//   1. 统一 ModelID：多个供应商的同名模型（如 deepseek-v4-flash 在火山和 OpenCodeGo）
//      配置成一个逻辑 ID，按候选链路由。
//   2. 自动故障转移：主候选首 token 前失败（限流/配额/认证/网络/模型不存在/空响应）
//      自动切下一候选；失败候选进入冷却期。
//   3. 三档分级（对标 Claude Haiku/Sonnet/Opus）：
//      - tier1 轻量（压缩/标题）· tier2 标准（主对话）· tier3 强大（重任务）
//      - purpose=compaction/session-title → tier1；主对话 → tier2；options.tier=3 → tier3
//      - 选中档为空 → 逐级降档
//   4. 思考级别：每个候选可配 reasoningEffort（off/minimal/low/medium/high/xhigh/max，
//      对标 Claude /effort），面板可配置，保存时校验模型支持。
//
// 面板 API（webServer，同源 fetch）：
//   GET  /api/model-router/state           -> 配置+目录+efforts+冷却+事件历史+统计
//   POST /api/model-router/save            -> 整段保存配置（settings.replace）
//   POST /api/model-router/cooldowns/clear -> 清空冷却
//
// 配置（settings.yaml 的 model-router 段）：
//   model-router:
//     enabled: true
//     cooldownMs: 300000
//     maxSwitchesPerStep: 3
//     routes:
//       deepseek-v4-flash:
//         tier1: [{provider: opencode-go, model: mimo-v2.5, reasoningEffort: low}, {provider: volcengine, model: deepseek-v4-flash}]
//         tier2: [{provider: volcengine, model: deepseek-v4-flash}, {provider: opencode-go, model: deepseek-v4-flash}]
//         tier3: [{provider: opencode-go, model: deepseek-v4-pro, reasoningEffort: high}, ...]
//     # 兼容旧字段：simple → tier1, complex → tier2

import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

const NS = 'model-router'
const HISTORY_CAP = 60
const TIER_SLOTS = ['tier1', 'tier2', 'tier3']

function json(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > limit) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

export default {
  name: 'dsh-model-router',
  // llm/webServer/settings/sessions 都是 loadable service：必须 inject 声明，
  // ctx.get 拿不到（webServer undefined 会导致面板 API 静默不注册）。
  inject: ['llm', 'webServer', 'settings', 'sessions'],

  apply(ctx) {
    // ------------------------------------------------------------------
    // 注册自定义会话事件类型（关键：否则会话无法恢复）
    // ------------------------------------------------------------------
    // 本插件通过 session.append 把路由决策写进会话日志（供客户端订阅实时消费），
    // 但 model-router/route 不在 harness 的 KNOWN_SESSION_EVENT_TYPES 白名单内。
    // 恢复（resume）会话时 dsh-session-persistence.assertEventsSupported 会对未知
    // 且未标记 ignorable 的事件抛 SessionFormatUnsupportedError，导致含该事件的
    // 会话全部打不开（含本插件自己写入事件的会话）。
    //   session.append(type, data, opts) 不透传 ignorable 标记（事件在内部构造并
    // deepFreeze，opts 只读取 sourceEventSeqs/surfaceOp），无法让事件本身携带
    // ignorable；因此这里把类型注册进共享的 KNOWN_SESSION_EVENT_TYPES Set——
    // 这正是 harness 注释里"为 out-of-repo 插件事件保留的注册面"（registration
    // surface）的落地方式：dsh-session-persistence 与本插件解析到同一个模块实例
    // （同一 realpath），mutate 后 assertEventsSupported 即放行，历史/新会话都可恢复。
    // 该 Set 是生成文件（scripts/gen-persistence-catalog.ts）的运行时产物，
    // 每次启动本插件都重新注册，幂等且随版本升级自动重新生效。
    try {
      KNOWN_SESSION_EVENT_TYPES.add('model-router/route')
    } catch (e) {
      ctx.logger.warn('dsh-model-router: 注册 model-router/route 事件类型失败，含该事件的会话可能无法恢复：' + String((e && e.message) || e))
    }

    // ------------------------------------------------------------------
    // 配置 schema（schemastery）
    // ------------------------------------------------------------------
    const Candidate = z.object({
      provider: z.string().required(),
      model: z.string().required(),
      reasoningEffort: z.string(), // 思考级别：可选（schemastery 中 z.string() 默认可空）
    })
    const Route = z.object({
      tier1: z.array(Candidate).default([]),
      tier2: z.array(Candidate).default([]),
      tier3: z.array(Candidate).default([]),
      simple: z.array(Candidate).default([]),  // 兼容旧字段 → tier1（schemastery 无 .optional()，字段默认可选；用 .default([]) 兜底）
      complex: z.array(Candidate).default([]), // 兼容旧字段 → tier2（同上）
    })
    const Config = z.object({
      enabled: z.boolean().default(true),
      cooldownMs: z.natural().default(300000),
      maxSwitchesPerStep: z.natural().min(1).max(10).default(3),
      routes: z.dict(Route).default({}),
      // 手动档位持久化：sessionId -> tier1|tier2|tier3
      // 存进 settings，重启/刷新后仍记住用户手动选的档位。
      manualTiers: z.dict(z.string(), z.string()).default({}),
    })

    // 旧 simple/complex → tier1/tier2 迁移（新字段为空且旧字段存在时）
    function normalizeRoute(route) {
      const out = {
        tier1: route.tier1,
        tier2: route.tier2,
        tier3: route.tier3,
      }
      if (out.tier1.length === 0 && route.simple && route.simple.length > 0) out.tier1 = route.simple
      if (out.tier2.length === 0 && route.complex && route.complex.length > 0) out.tier2 = route.complex
      return out
    }

    // 按「候选模型名」反查套餐：会话模型是真实模型名（如 volcengine/deepseek-v4-flash）
    // 而非套餐 key（如 Economy）时，找到包含它的套餐路由。
    // 遍历顺序 = settings 里的声明顺序，取第一个匹配（多套餐共享候选时的约定）。
    function findByCandidate(routes, model) {
      for (const [key, raw] of Object.entries(routes)) {
        const r = normalizeRoute(raw)
        for (const slot of TIER_SLOTS) {
          const chain = r[slot]
          if (chain && chain.some((c) => c.model === model)) return raw
        }
      }
      return undefined
    }

    // ------------------------------------------------------------------
    // 运行时状态：冷却 + 事件历史 + 计数
    // （声明在 installSettingsSection 之前：其 onChange 首次调用会访问 manualTiers）
    // ------------------------------------------------------------------
    const cooldowns = new Map() // `provider/model` -> until timestamp
    const history = []          // {ts, type, model, tier?, purpose, from?, by?, code?}
    const stats = new Map()     // unifiedId -> {requests, failovers}
    // 手动档位：sessionId -> 'tier1'|'tier2'|'tier3'（用户在下拉里显式选档，覆盖默认 purpose 规则）
    const manualTiers = new Map()
    const MANUAL_TIERS_CAP = 500

    const cooldownKey = (c) => `${c.provider}/${c.model}`

    let current = () => Config()
    installSettingsSection(ctx, NS, Config, Config(), {
      setSource(source) { current = source },
      onChange() {
        // 从持久化配置恢复手动档位到内存 Map（首次加载/配置变更时）
        try {
          const persisted = current().manualTiers ?? {}
          manualTiers.clear()
          for (const [sid, tier] of Object.entries(persisted)) {
            if (sid && TIER_SLOTS.includes(tier)) manualTiers.set(sid, tier)
          }
        } catch (e) {
          // 恢复失败不影响路由（退回自动档）
        }
        ctx.logger.info(`dsh-model-router: 配置已更新，${Object.keys(current().routes).length} 个统一模型路由`)
      },
    })

    function setManualTier(sessionId, tier) {
      if (!sessionId) return Promise.resolve()
      if (tier === 'auto' || tier === undefined || tier === null) {
        manualTiers.delete(sessionId)
        return persistManualTier(sessionId, '')
      } else {
        manualTiers.set(sessionId, tier)
        if (manualTiers.size > MANUAL_TIERS_CAP) {
          const oldest = manualTiers.keys().next().value
          if (oldest !== undefined) manualTiers.delete(oldest)
        }
        return persistManualTier(sessionId, tier)
      }
    }

    // 把一条手动档位写回 settings（持久化，跨重启记住）。
    // 用 mutate 路径级 set/unset，避免重写整个配置段。
    // tier 为空字符串 → unset（清除）；否则 set。
    async function persistManualTier(sessionId, tier) {
      const settings = ctx.settings
      if (!settings || typeof settings.mutate !== 'function') return
      try {
        await settings.mutate(NS, tier === ''
          ? [{ op: 'unset', path: ['manualTiers', sessionId] }]
          : [{ op: 'set', path: ['manualTiers', sessionId], value: tier }])
      } catch (e) {
        // 只读 provider / 冲突等：持久化失败不影响内存路由
        ctx.logger.debug?.('dsh-model-router: persist manualTier failed: ' + String((e && e.message) || e))
      }
    }

    function record(entry) {
      history.push({ ts: Date.now(), ...entry })
      if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP)
    }

    // 把路由决策事件 append 到会话日志（客户端订阅会话事件流实时消费，
    // 替代轮询 /api/model-router/state）。保留 record() 供面板全局历史。
    // 类型已在本插件 apply() 注册进 KNOWN_SESSION_EVENT_TYPES，故含该事件的
    // 会话仍可被本 build 恢复；session.append 本身不校验未知类型
    //（assertSupportedRequestHeader 只拦 legacy 类型），append 后经 session/event 推送给已订阅的客户端。
    function emitRouteEvent(sessionId, entry) {
      if (!sessionId) return
      try {
        const session = ctx.sessions?.get(sessionId)
        if (!session?.append) return
        session.append('model-router/route', {
          ts: Date.now(),
          ...entry,
        })
      } catch (e) {
        // 会话可能已销毁/append 校验失败——事件制只是增强，失败不影响路由本身
        ctx.logger.debug?.('dsh-model-router: emitRouteEvent failed: ' + String((e && e.message) || e))
      }
    }
    function bump(modelId, field) {
      const s = stats.get(modelId) ?? { requests: 0, failovers: 0 }
      s[field] += 1
      stats.set(modelId, s)
    }

    function markCooldown(candidate) {
      const ms = current().cooldownMs
      if (ms > 0) cooldowns.set(cooldownKey(candidate), Date.now() + ms)
    }

    function isCoolingDown(candidate, now = Date.now()) {
      const until = cooldowns.get(cooldownKey(candidate))
      if (until === undefined) return false
      if (until <= now) { cooldowns.delete(cooldownKey(candidate)); return false }
      return true
    }

    // ------------------------------------------------------------------
    // 可转移错误码白名单
    // ------------------------------------------------------------------
    const RETRYABLE_CODES = new Set([
      'AUTH', 'RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT',
      'UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'EMPTY_RESPONSE',
    ])
    function isRetryableFailure(failure) {
      if (!failure) return false
      if (typeof failure.code === 'string' && RETRYABLE_CODES.has(failure.code)) return true
      if (typeof failure.status === 'number' && failure.status >= 500 && failure.status < 600) return true
      return false
    }

    const RESOLVED = Symbol('dshModelRouterResolved')

    // ------------------------------------------------------------------
    // 重放状态（replayState）清洗
    // ------------------------------------------------------------------
    // DSH 的 pi-ai 适配器要求：历史里每条 assistant 消息的
    // source.provider/source.model 必须等于它身上携带的
    // replayState.provider/replayState.model（见 dsh-llm-pi-ai 的
    // replayedAssistant），否则重建上下文时抛 INVALID_REPLAY_STATE
    // （"provider does not match assistant source" 或
    // "model does not match assistant source"），且该坏消息留在历史里
    // 会让后续所有步骤都在第 1 步失败。
    //
    // 本插件在 llm/stream 中间件层改写 provider/model，但 agent loop 落盘
    // assistant 消息时 source 记的是「改写前」的外层 provider/model，
    // 而 replayState 来自真正服务的候选——两者一旦不同（路由把历史从
    // A 模型切到 B 模型，包括同 provider 不同 model 的切换，
    // 如 mimo-v2.5 → deepseek-v4-flash），下一条请求就会撞上校验。
    //
    // 这里的修法与 DSH 自身的 forAdapter 一致：把 replayState 传给「产生它
    // 的那个 provider/model」以外的任何候选前，剥掉这条消息的 replayState，
    // 让它按「外来 assistant 消息」重建（文本/工具调用内容完整保留，只丢
    // 原生签名元数据）。既防止新污染，也能让已污染的会话自愈。
    function withSanitizedReplayState(options, provider) {
      const messages = options.messages
      if (!Array.isArray(messages)) return options
      let changed = false
      const sanitized = messages.map((message) => {
        const source = message.source
        if (message.role !== 'assistant' || source?.kind !== 'model' || source.replayState === undefined) return message
        const rs = source.replayState
        // 只有「replayState 的 provider 与 model 都属于当前候选，且与消息
        // 自身 source 完全一致」时保留原生 replay；否则剥离（内容不受影响）。
        // 注意必须同时校验 model：同 provider 下切换模型（如 tier 候选里
        // opencode-go 的 mimo-v2.5 与 deepseek-v4-flash）会产出
        // 「provider 相同而 model 不同」的坏消息，只查 provider 会漏掉。
        if (rs.provider === provider && rs.provider === source.provider && rs.model === source.model) return message
        changed = true
        return { ...message, source: { kind: 'model', provider: source.provider, model: source.model } }
      })
      return changed ? { ...options, messages: sanitized } : options
    }

    // ------------------------------------------------------------------
    // 思考包裹标签剥离（流级）
    // ------------------------------------------------------------------
    // 模型开启推理时（如 deepseek 系在 reasoningEffort 非 off 时）会在输出流里写入
    // 思考边界标记：`<thinking>…</thinking>` / `</thinking>` / `<response>` /
    // `</response>` 等（部分通道只出现残缺片段如 `</think`、` response`）。
    // harness 的 pi-ai 适配层与界面渲染层都不剥离这些标记，导致界面把思考标签
    // 当作正文显示。这里在路由流上做状态化剥离（支持标签跨 chunk 被拆散的情况），
    // 对 text-delta / reasoning-delta 都生效；只剥离精确的思考包裹标签，
    // 避免误伤正文里普通出现的 "response" 单词。
    function makeThinkingTagStripper() {
      let carry = ''
      // 完整标签：<thinking> </thinking> <reasoning> </reasoning> <response> </response>
      // <answer> </answer> <antml:thinking> <antml:invoke name="..."> </antml:invoke> 等
      const TAG_RE = /<\/?(?:thinking|think|reasoning|response|answer|output|final|result|antml:(?:thinking|invoke|parameter|result|output|reasoning))(?:\s[^>]*)?>/gi
      // 残缺边界标记：`</think`、`\n response`、`. response`、` response`（后直接接正文无空格）
      const PARTIAL_RE = /(?:^|[\s.。！？!?，,；;:：])(<)?\/?(?:think(?:ing)?|respons|reasoning|answer)?$/gi
      // 剥离单独成词的裸标记：紧跟非空白（无空格）的 response 是模型边界标记，不是普通词
      const BARE_RESPONSE_RE = /(?:^|[\s.。！？!?，,；;:：])response(?=[^\s\w])/gi

      return function clean(text) {
        let input = carry + text
        let output = input.replace(TAG_RE, '')
        output = output.replace(BARE_RESPONSE_RE, '')
        // 检测尾部是否为标签/标记的残缺前缀（如 `</thi`、` resp`），跨 chunk 缓存续接
        const tail = output.match(/<(?:\/?[a-zA-Z][a-zA-Z:]*)?$/) || output.match(/<\/?(?:think|resp|reason|answer|antml)[a-zA-Z:]*$/)
        if (tail) {
          carry = tail[0]
          output = output.slice(0, output.length - tail[0].length)
        } else {
          carry = ''
        }
        return output
      }
    }

    // ------------------------------------------------------------------
    // 故障转移路由 generator
    // ------------------------------------------------------------------
    async function* routeThrough(chain, options, cfg) {
      let lastFailure = null
      let switches = 0
      const tier = options.__mrTier
      const stripThinking = makeThinkingTagStripper()

      for (const candidate of chain) {
        if (isCoolingDown(candidate)) continue

        // 实时状态：每次尝试候选时记录「当前档位 + 正在尝试的供应商/模型」，
        // 供对话界面在运行时展示（client 轮询 state 取最新一条）。
        record({
          type: 'started', model: options.model, tier,
          purpose: options.purpose ?? 'main',
          sessionId: options.sessionId ?? null,
          try: cooldownKey(candidate),
        })
        emitRouteEvent(options.sessionId, {
          type: 'started', model: options.model, tier,
          purpose: options.purpose ?? 'main',
          try: cooldownKey(candidate),
        })

        let sawContent = false
        let candidateFailed = false
        try {
          const stream = ctx.llm.stream(withSanitizedReplayState({
            ...options,
            [RESOLVED]: true,
            provider: candidate.provider,
            model: candidate.model,
            ...(candidate.reasoningEffort !== undefined ? { reasoningEffort: candidate.reasoningEffort } : {}),
          }, candidate.provider))
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              sawContent = true
            }
            if (chunk.type === 'finish') {
              const reason = chunk.reason
              const failed = reason.kind === 'error' || reason.kind === 'aborted'
              if (failed && !sawContent && reason.failure && isRetryableFailure(reason.failure)) {
                lastFailure = reason.failure
                candidateFailed = true
                switches++
                markCooldown(candidate)
                bump(options.model, 'failovers')
                record({
                  type: 'failover', model: options.model, tier,
                  purpose: options.purpose ?? 'main',
                  sessionId: options.sessionId ?? null,
                  from: cooldownKey(candidate), code: reason.failure.code,
                  status: reason.failure.status ?? null,
                })
                emitRouteEvent(options.sessionId, {
                  type: 'failover', model: options.model, tier,
                  purpose: options.purpose ?? 'main',
                  from: cooldownKey(candidate), code: reason.failure.code,
                  status: reason.failure.status ?? null,
                })
                ctx.logger.warn(
                  `dsh-model-router: ${tier} 候选 ${cooldownKey(candidate)} 首 token 前失败` +
                  `（${reason.failure.code}${reason.failure.status ? ` HTTP ${reason.failure.status}` : ''}），切换下一候选（第 ${switches} 次）`
                )
                break
              }
              // 正常终态（或已输出后失败/不可转移失败）→ 透传
              if (!candidateFailed) {
                record({ type: 'served', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, by: cooldownKey(candidate) })
                emitRouteEvent(options.sessionId, {
                  type: 'served', model: options.model, tier,
                  purpose: options.purpose ?? 'main',
                  by: cooldownKey(candidate),
                })
              }
              yield cleanChunk(chunk)
              return
            }
            yield chunk
          }
          if (!candidateFailed) return
          if (switches >= cfg.maxSwitchesPerStep) break
        } catch (error) {
          if (!sawContent) {
            const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN'
            lastFailure = { message: String((error && error.message) || error), code }
            candidateFailed = true
            switches++
            markCooldown(candidate)
            bump(options.model, 'failovers')
            record({
              type: 'failover', model: options.model, tier,
              purpose: options.purpose ?? 'main',
              sessionId: options.sessionId ?? null,
              from: cooldownKey(candidate), code, status: null,
            })
            emitRouteEvent(options.sessionId, {
              type: 'failover', model: options.model, tier,
              purpose: options.purpose ?? 'main',
              from: cooldownKey(candidate), code, status: null,
            })
            ctx.logger.warn(`dsh-model-router: ${tier} 候选 ${cooldownKey(candidate)} 抛错（${code}），切换下一候选（第 ${switches} 次）`)
            if (switches >= cfg.maxSwitchesPerStep) break
            continue
          }
          throw error
        }
      }

      record({ type: 'all-failed', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, code: lastFailure?.code ?? 'NO_CANDIDATE' })
      emitRouteEvent(options.sessionId, {
        type: 'all-failed', model: options.model, tier,
        purpose: options.purpose ?? 'main',
        code: lastFailure?.code ?? 'NO_CANDIDATE',
      })
      ctx.logger.error(`dsh-model-router: 统一模型 ${options.model}（${tier}）所有候选失败`)
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: lastFailure ?? { message: `dsh-model-router: ${options.model} 无可用候选`, code: 'NO_ADAPTER' } },
      }
    }

    // ------------------------------------------------------------------
    // 选档
    // ------------------------------------------------------------------
    function selectTier(options, route) {
      // 显式 options.tier 最高优先（调用方明确指定）
      if (options.tier !== undefined) {
        const t = Number(options.tier)
        if (Number.isInteger(t) && t >= 1 && t <= 3) return `tier${t}`
      }
      // 系统轻量任务（压缩/标题）永远走 tier1，不受用户手动档影响：
      // 手动档是为「对话质量」服务的，压缩跑强模型纯属浪费。
      const p = options.purpose
      if (p === 'compaction' || p === 'session-title') return 'tier1'
      // 手动档位：用户在下拉显式选的档（仅当该档有候选时生效），作用于主对话
      const manual = options.sessionId ? manualTiers.get(options.sessionId) : undefined
      if (manual && route[manual] && route[manual].length > 0) return manual
      return 'tier2'
    }

    // 选中档空 → 逐级降档（tier3→tier2→tier1），全空返回 null
    function pickChain(route, tierSlot) {
      const idx = TIER_SLOTS.indexOf(tierSlot)
      const order = TIER_SLOTS.slice(0, idx + 1).reverse() // 从选中档降到 tier1
      for (const slot of order) {
        if (route[slot] && route[slot].length > 0) return { slot, chain: route[slot] }
      }
      return null
    }

    // ------------------------------------------------------------------
    // llm/stream waterfall 拦截
    // ------------------------------------------------------------------
    const dispose = ctx.on('llm/stream', (options, next) => {
      if (options[RESOLVED]) return next()
      const cfg = current()
      if (!cfg.enabled) return next()

      const raw = cfg.routes[options.model] || findByCandidate(cfg.routes, options.model)
      if (!raw) return next()

      const route = normalizeRoute(raw)
      const tierSlot = selectTier(options, route)
      const picked = pickChain(route, tierSlot)
      if (!picked) return next()

      const available = picked.chain.filter((c) => !isCoolingDown(c))
      if (available.length === 0) {
        record({ type: 'passthrough', model: options.model, tier: picked.slot, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null })
        emitRouteEvent(options.sessionId, {
          type: 'passthrough', model: options.model, tier: picked.slot,
          purpose: options.purpose ?? 'main',
        })
        ctx.logger.warn(`dsh-model-router: ${options.model}（${picked.slot}）候选全部冷却中，放行原路径`)
        // 放行原路径也要清洗历史 replayState：next() 无法携带改动后的 options
        // （waterfall 的 next 用原始参数调用下一段），若历史里已有跨 provider 的
        // 坏消息，必须先剥掉再走 RESOLVED 重入；无需清洗时保持 next() 原路径。
        const sanitized = withSanitizedReplayState(options, options.provider)
        if (sanitized === options) return next()
        return ctx.llm.stream({ ...sanitized, [RESOLVED]: true })
      }

      bump(options.model, 'requests')
      ctx.logger.info(
        `dsh-model-router: 路由 ${options.model} → ${picked.slot} (purpose=${options.purpose ?? 'main'}${options.tier !== undefined ? `, tier=${options.tier}` : ''}) → ` +
        `[${picked.chain.map(cooldownKey).join(' → ')}]`
      )
      return routeThrough(picked.chain, { ...options, __mrTier: picked.slot }, cfg)
    })

    // ------------------------------------------------------------------
    // 面板 API
    // ------------------------------------------------------------------
    async function buildCatalog() {
      const providers = ctx.llm.listProviders().map((p) => p.id)
      const catalog = {}
      await Promise.all(providers.map(async (pid) => {
        try {
          const models = await ctx.llm.listModels(pid)
          catalog[pid] = models.map((m) => m.id).sort()
        } catch {
          catalog[pid] = []
        }
      }))
      return catalog
    }

    // 仅对当前配置引用的候选模型解析思考级别（有界、快速）
    async function buildEfforts(routes) {
      const efforts = {}
      const seen = new Set()
      for (const route of Object.values(routes)) {
        for (const slot of TIER_SLOTS) {
          for (const c of route[slot] || []) {
            const key = `${c.provider}/${c.model}`
            if (seen.has(key)) continue
            seen.add(key)
            try {
              const info = await ctx.llm.resolveModelInfo(c.provider, c.model)
              const reasoning = info && info.reasoning
              if (reasoning && Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0) {
                efforts[key] = reasoning.efforts.map((e) => ({ id: e.id, name: e.name }))
              }
            } catch {
              // 忽略解析失败：该模型无思考级别信息
            }
          }
        }
      }
      return efforts
    }

    // 校验并规范化一份提交的 section；返回 {section} 或抛错
    async function validateSection(input) {
      if (input === null || typeof input !== 'object') throw new Error('body 必须是对象')
      const section = Config(input) // schema 规范化+默认值；非法直接抛
      const catalog = await buildCatalog()
      for (const [id, route] of Object.entries(section.routes)) {
        for (const slot of TIER_SLOTS) {
          for (const c of route[slot]) {
            if (!(catalog[c.provider] ?? []).includes(c.model)) {
              throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 不存在于当前模型目录`)
            }
            if (c.reasoningEffort !== undefined) {
              try {
                const info = await ctx.llm.resolveModelInfo(c.provider, c.model)
                const efforts = info && info.reasoning ? info.reasoning.efforts : []
                if (!efforts.some((e) => e.id === c.reasoningEffort)) {
                  throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 不支持思考级别 ${c.reasoningEffort}`)
                }
              } catch (e) {
                if (e && e.message && String(e.message).startsWith('路由')) throw e
                throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 无法校验思考级别：${String((e && e.message) || e)}`)
              }
            }
          }
        }
      }
      // 归一：去掉兼容旧字段，只保留 tier1/tier2/tier3
      const normalized = {}
      for (const [id, route] of Object.entries(section.routes)) {
        normalized[id] = { tier1: route.tier1, tier2: route.tier2, tier3: route.tier3 }
      }
      return { ...section, routes: normalized }
    }

    const webServer = ctx.webServer
    const settings = ctx.settings

    if (webServer !== undefined) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/model-router/state',
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const now = Date.now()
            const cfg = current()
            const routes = {}
            for (const [id, raw] of Object.entries(cfg.routes)) routes[id] = normalizeRoute(raw)
            const [catalog, efforts] = await Promise.all([buildCatalog(), buildEfforts(routes)])
            json(res, 200, {
              ok: true,
              config: { ...cfg, routes },
              writable: settings !== undefined,
              catalog,
              efforts,
              cooldowns: [...cooldowns.entries()].map(([key, until]) => ({
                key, until, remainingMs: Math.max(0, until - now),
              })),
              manualTiers: Object.fromEntries(manualTiers),
              history: history.slice().reverse(),
              stats: Object.fromEntries(stats),
            })
          } catch (e) {
            json(res, 500, { ok: false, error: String((e && e.message) || e) })
          }
        },
      }), 'dsh-model-router: state route')

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/model-router/save',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          try {
            if (settings === undefined) return json(res, 503, { ok: false, error: 'settings 服务不可用' })
            const body = await readBody(req)
            const section = await validateSection(body)
            await settings.replace(NS, section)
            json(res, 200, { ok: true, config: current() })
          } catch (e) {
            json(res, 400, { ok: false, error: String((e && e.message) || e) })
          }
        },
      }), 'dsh-model-router: save route')

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/model-router/cooldowns/clear',
        handler: (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          cooldowns.clear()
          record({ type: 'cooldowns-cleared' })
          json(res, 200, { ok: true })
        },
      }), 'dsh-model-router: cooldowns route')

      // 手动档位：client 在下拉里显式选档时调用；tier=auto 清除回默认规则
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/model-router/tier',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const body = await readBody(req)
            const sessionId = String(body.sessionId ?? '')
            const tier = String(body.tier ?? 'auto')
            if (!sessionId) return json(res, 400, { ok: false, error: 'sessionId 必填' })
            if (tier !== 'auto' && !TIER_SLOTS.includes(tier)) {
              return json(res, 400, { ok: false, error: `tier 必须是 ${TIER_SLOTS.join('/')} 或 auto` })
            }
            await setManualTier(sessionId, tier)
            record({ type: 'manual-tier', model: sessionId, tier: manualTiers.get(sessionId) ?? 'auto', purpose: 'manual' })
            emitRouteEvent(sessionId, {
              type: 'manual-tier', tier: manualTiers.get(sessionId) ?? 'auto',
              purpose: 'manual',
            })
            json(res, 200, { ok: true, manual: manualTiers.get(sessionId) ?? 'auto' })
          } catch (e) {
            json(res, 400, { ok: false, error: String((e && e.message) || e) })
          }
        },
      }), 'dsh-model-router: tier route')
    }

    ctx.effect(() => () => {
      dispose()
      cooldowns.clear()
      history.length = 0
      stats.clear()
      manualTiers.clear()
    }, 'dsh-model-router: cleanup')

    ctx.logger.info('dsh-model-router: 已加载（统一 ModelID 三档路由 + 故障转移 + 思考级别 + 管理面板 API）')
  },
}
