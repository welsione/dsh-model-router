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
//   POST /api/model-router/tier            -> 设置 / 清除会话手动档位
//
// 配置（settings 的 model-router 段）：
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
//
// 纯逻辑（选档/降档/错误判定/replayState 清洗）集中在 ./core.mjs，可单元测试。

import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  NS,
  TIER_SLOTS,
  RESOLVED,
  cooldownKey,
  isRetryableFailure,
  isTransientFailure,
  cooldownDurationMs,
  normalizeRoute,
  findByCandidate,
  selectTier as selectTierCore,
  pickChain as pickChainCore,
  rankChainByHealth,
  withSanitizedReplayState,
} from './core.mjs'

const HISTORY_CAP = 60

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

export const name = 'dsh-model-router'
// llm/webServer/settings/sessions 都是 loadable service：必须 inject 声明，
// ctx.get 拿不到（webServer undefined 会导致面板 API 静默不注册）。
export const inject = ['llm', 'webServer', 'settings', 'sessions']

export function apply(ctx) {
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
    // 该套餐的档位显示名：tier1/tier2/tier3 → 自定义名（缺省用默认 lite/normal/pro）。
    // 只影响展示（对话窗口套餐选择器 / 设置面板徽章），内部逻辑仍按 tier 标识路由。
    tierNames: z.dict(z.string(), z.string()).default({}),
  })
  const Config = z.object({
    enabled: z.boolean().default(true),
    // 冷却基础时长（AUTH/未知模型等「硬」失败用满额；限流/配额/空响应按 0.2 系数、
    // 服务端/超时/传输按 0.5 系数缩短），连续失败指数退避，封顶 cooldownMaxMs。
    cooldownMs: z.natural().default(300000),
    cooldownMaxMs: z.natural().default(1800000), // 冷却退避封顶（默认 30 分钟）
    cooldownBackoff: z.natural().min(1).max(16).default(2), // 连续失败的退避倍数
    maxSwitchesPerStep: z.natural().min(1).max(10).default(3),
    // 瞬时错误（限流/配额/服务端/超时/传输/空响应）重试：同一候选短暂等待后
    // 重试（最多 maxRetriesPerCandidate 次），全失败才进冷却并切换候选。
    // 避免「限流一下就立刻冷却」——限流常是瞬时的，等 1-2 秒再试可能成功。
    // AUTH/UNKNOWN_MODEL 等配置类错误不重试（重试无意义），直接切换。
    retryOnThrottle: z.boolean().default(true),
    maxRetriesPerCandidate: z.natural().min(0).max(5).default(2),
    retryBackoffMs: z.natural().default(1000), // 重试间隔，线性退避（1x,2x,...）
    // 健康度感知择优：候选链按滑动窗口内的成功/失败重排（稳定成功提前、频繁失败后移）。
    // 默认开启，可在面板关闭恢复「纯配置顺序」语义。
    healthRanking: z.boolean().default(true),
    healthWindowSize: z.natural().min(3).max(30).default(8), // 每个候选保留的滑动窗口大小
    // 思考级别兜底：目录未标注推理能力的候选，也允许手动选择思考级别（值未经验证，透传供应商）。
    // 默认参考 models.dev 最常见档位（low/medium/high），可自定义为完整集或供应商支持的具体档位。
    reasoningEffortsFallback: z.array(z.string()).default(['low', 'medium', 'high']),
    routes: z.dict(Route).default({}),
    // 手动档位持久化：sessionId -> tier1|tier2|tier3
    // 存进 settings，重启/刷新后仍记住用户手动选的档位。
    manualTiers: z.dict(z.string(), z.string()).default({}),
  })

  // ------------------------------------------------------------------
  // 运行时状态：冷却 + 事件历史 + 计数
  // （声明在 installSettingsSection 之前：其 onChange 首次调用会访问 manualTiers）
  // ------------------------------------------------------------------
  const cooldowns = new Map() // `provider/model` -> until timestamp
  const history = []          // {ts, type, model, tier?, purpose, from?, by?, code?}
  const stats = new Map()     // unifiedId -> {requests, failovers}
  // 候选健康度（feature: health-ranking）：key(`provider/model`) -> {ok, fail}
  // 滑动窗口计数（窗口大小 = healthWindowSize），用于择优排序与面板展示。
  const health = new Map()
  // 手动档位：sessionId -> 'tier1'|'tier2'|'tier3'（用户在下拉里显式选档，覆盖默认 purpose 规则）
  const manualTiers = new Map()
  const MANUAL_TIERS_CAP = 500
  const getManualTier = (sid) => manualTiers.get(sid)

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

  // 分级冷却 + 指数退避：按失败类型算基础时长（限流 0.2x / 服务端 0.5x / 硬失败 1x），
  // 再乘 退避倍数^(连续失败次数)，封顶 cooldownMaxMs。
  // 记录 {until, code, status, streak}：面板「冷却中的候选」展示失败原因与退避进度。
  function markCooldown(candidate, failure) {
    const cfg = current()
    const base = cfg.cooldownMs
    if (base <= 0) return
    const key = cooldownKey(candidate)
    const rec = health.get(key)
    const streak = rec ? (rec.streak || 0) : 0
    const dur = cooldownDurationMs(failure, base, cfg.cooldownMaxMs, cfg.cooldownBackoff, streak)
    cooldowns.set(key, {
      until: Date.now() + dur,
      durationMs: dur,
      code: failure?.code ?? null,
      status: failure?.status ?? null,
      streak,
    })
  }

  // 记录候选健康度结果（滑动窗口）。每条记录带时间戳与失败信息：
  //   - buf: [{ok, ts, code?, status?}]（时间衰减评分 + 错误码加权）
  //   - streak: 连续失败次数（成功清零），供冷却指数退避
  // 窗口按 healthWindowSize 裁剪（超出即丢弃最旧，保持有界）。
  function markHealth(candidate, ok, failure) {
    const key = cooldownKey(candidate)
    const win = Math.max(3, current().healthWindowSize)
    let rec = health.get(key)
    if (!rec) { rec = { ok: 0, fail: 0, total: 0, buf: [], streak: 0 }; health.set(key, rec) }
    const ts = Date.now()
    const entry = ok
      ? { ok: true, ts }
      : { ok: false, ts, code: failure?.code ?? null, status: failure?.status ?? null }
    rec.buf.push(entry)
    if (ok) { rec.ok += 1; rec.streak = 0 } else { rec.fail += 1; rec.streak += 1 }
    rec.total += 1
    if (rec.buf.length > win) {
      const dropped = rec.buf.shift()
      if (dropped.ok) rec.ok -= 1; else rec.fail -= 1
    }
  }

  function isCoolingDown(candidate, now = Date.now()) {
    const rec = cooldowns.get(cooldownKey(candidate))
    if (rec === undefined) return false
    const until = typeof rec === 'number' ? rec : rec.until // 兼容旧数字形态
    if (until <= now) { cooldowns.delete(cooldownKey(candidate)); return false }
    return true
  }

  // ------------------------------------------------------------------
  // 故障转移路由 generator
  // ------------------------------------------------------------------
  // 单个候选的尝试函数：初始请求 + 瞬时错误重试（最多 maxRetriesPerCandidate 次）。
  // 返回：
  //   'served'  —— 成功，且已把 chunk 全部 yield 给调用方（透传完成）
  //   'retried' —— 瞬时错误重试后成功（chunk 已透传）
  // 失败时：
  //   非瞬时错误 / 重试耗尽 → 抛回 failure（由 routeThrough 统一记冷却+切换）
  //   已输出内容后失败 → 抛回（不重试不切换）
  // 注：generator 内无法把「已透传部分 chunk 后又失败」回滚，所以这里用闭包捕获
  // 失败，成功时把流透传给外层。为保持简单，成功路径由外层 for-await 透传，
  // 本函数只负责「发起 + 判失败/重试」，不 yield——由 routeThrough 统一透传。
  //
  // 更直接的实现：本函数返回一个「消费器」，外层 while 循环处理透传。
  // 为最小化复杂度，我们把「单次尝试」也内联在 routeThrough 里，但用清晰标志。
  // 见下方 routeThrough 实现。

  async function* routeThrough(chain, options, cfg) {
    let lastFailure = null
    let switches = 0
    const tier = options.__mrTier

    for (const candidate of chain) {
      if (isCoolingDown(candidate)) continue

      record({
        type: 'started', model: options.model, tier,
        purpose: options.purpose ?? 'main',
        sessionId: options.sessionId ?? null,
        try: cooldownKey(candidate),
        effort: candidate.reasoningEffort ?? null,
      })
      emitRouteEvent(options.sessionId, {
        type: 'started', model: options.model, tier,
        purpose: options.purpose ?? 'main',
        try: cooldownKey(candidate),
        effort: candidate.reasoningEffort ?? null,
      })

      const maxAttempts = cfg.retryOnThrottle ? (1 + (cfg.maxRetriesPerCandidate || 0)) : 1
      let attempt = 0
      let sawContent = false
      let candidateFailed = false

      // 单候选尝试循环：attempt=0 初始，瞬时错误未达上限则重试
      while (attempt < maxAttempts && !candidateFailed) {
        sawContent = false
        let attemptFailed = false
        let attemptFailure = null
        let normalEnd = false // 流正常结束（finish 非失败分支已透传 return，不会到这）
        try {
          const stream = ctx.llm.stream(withSanitizedReplayState({
            ...options,
            [RESOLVED]: true,
            provider: candidate.provider,
            model: candidate.model,
            ...(candidate.reasoningEffort !== undefined ? { reasoningEffort: candidate.reasoningEffort } : {}),
          }, candidate.provider, candidate.model))
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              sawContent = true
            }
            if (chunk.type === 'finish') {
              const reason = chunk.reason
              const failed = reason.kind === 'error' || reason.kind === 'aborted'
              if (failed && !sawContent && reason.failure && isRetryableFailure(reason.failure)) {
                attemptFailed = true
                attemptFailure = reason.failure
                break // 跳出 for-await
              }
              // 正常终态（或已输出后失败/不可转移失败）→ 透传
              if (!candidateFailed) {
                markHealth(candidate, true)
                record({ type: 'served', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, by: cooldownKey(candidate), effort: candidate.reasoningEffort ?? null })
                emitRouteEvent(options.sessionId, {
                  type: 'served', model: options.model, tier,
                  purpose: options.purpose ?? 'main',
                  by: cooldownKey(candidate),
                  effort: candidate.reasoningEffort ?? null,
                })
              }
              yield chunk
              return
            }
            yield chunk
          }
          // for-await 自然结束：仅当本次尝试未被判失败（finish 失败 break 会跳过）
          // 且未抛错 → 视为成功透传（罕见：流无 finish 直接结束）
          if (!attemptFailed) normalEnd = true
        } catch (error) {
          if (!sawContent) {
            attemptFailed = true
            const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN'
            attemptFailure = { message: String((error && error.message) || error), code }
          } else {
            throw error // 已输出内容后抛错 → 透传上层
          }
        }

        if (normalEnd && !attemptFailed) {
          // 流自然结束（无 finish 错误）→ 成功（内容已 yield 给调用方）。
          // 补记 served 事件 + 健康度成功，避免 OverlayStatus 卡在「请求中」
          // 高亮、健康度漏记成功。
          markHealth(candidate, true)
          record({ type: 'served', model: options.model, tier, purpose: options.purpose ?? 'main', sessionId: options.sessionId ?? null, by: cooldownKey(candidate), effort: candidate.reasoningEffort ?? null })
          emitRouteEvent(options.sessionId, {
            type: 'served', model: options.model, tier,
            purpose: options.purpose ?? 'main',
            by: cooldownKey(candidate),
            effort: candidate.reasoningEffort ?? null,
          })
          return
        }

        // ---- 本次尝试失败，决策：重试 or 切换 ----
        if (attemptFailed) {
          lastFailure = attemptFailure
          const transient = isTransientFailure(attemptFailure)
          const canRetry = transient && attempt + 1 < maxAttempts
          if (canRetry) {
            const wait = cfg.retryBackoffMs * (attempt + 1)
            ctx.logger.warn(
              `dsh-model-router: ${tier} 候选 ${cooldownKey(candidate)} 首 token 前失败` +
              `（${attemptFailure.code}${attemptFailure.status ? ` HTTP ${attemptFailure.status}` : ''}），` +
              `瞬时错误，${wait}ms 后重试（第 ${attempt + 1}/${maxAttempts} 次）`
            )
            await new Promise((r) => setTimeout(r, wait))
            attempt++
            continue // 进下次尝试
          }
          // 非瞬时错误 或 重试耗尽 → 判失败，切换候选
          candidateFailed = true
          switches++
          markCooldown(candidate, attemptFailure)
          markHealth(candidate, false, attemptFailure)
          bump(options.model, 'failovers')
          record({
            type: 'failover', model: options.model, tier,
            purpose: options.purpose ?? 'main',
            sessionId: options.sessionId ?? null,
            from: cooldownKey(candidate), code: attemptFailure.code,
            status: attemptFailure.status ?? null,
          })
          emitRouteEvent(options.sessionId, {
            type: 'failover', model: options.model, tier,
            purpose: options.purpose ?? 'main',
            from: cooldownKey(candidate), code: attemptFailure.code,
            status: attemptFailure.status ?? null,
          })
          ctx.logger.warn(
            `dsh-model-router: ${tier} 候选 ${cooldownKey(candidate)} 首 token 前失败` +
            `（${attemptFailure.code}${attemptFailure.status ? ` HTTP ${attemptFailure.status}` : ''}` +
            `${transient ? `，重试 ${maxAttempts} 次仍失败` : ''}），切换下一候选（第 ${switches} 次）`
          )
        }
      }

      // 尝试循环结束：若候选成功 → 已在成功分支 return；到这里 = 失败需切换
      if (candidateFailed && switches >= cfg.maxSwitchesPerStep) break
      if (!candidateFailed) return // 理论不可达（成功分支 return 了），保险
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
  // llm/stream waterfall 拦截
  // ------------------------------------------------------------------
  const dispose = ctx.on('llm/stream', (options, next) => {
    if (options[RESOLVED]) return next()
    const cfg = current()
    if (!cfg.enabled) return next()

    const raw = cfg.routes[options.model] || findByCandidate(cfg.routes, options.model)
    if (!raw) return next()

    const route = normalizeRoute(raw)
    const tierSlot = selectTierCore(options, route, getManualTier)
    const picked = pickChainCore(route, tierSlot)
    if (!picked) return next()

    // 健康度择优（feature: health-ranking）：开启时按滑动窗口内成功/失败重排候选链，
    // 稳定成功候选提前、频繁失败候选后移；关闭时保持纯配置顺序。
    const chain = cfg.healthRanking ? rankChainByHealth(picked.chain, health) : picked.chain

    const available = chain.filter((c) => !isCoolingDown(c))
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
      const sanitized = withSanitizedReplayState(options, options.provider, options.model)
      if (sanitized === options) return next()
      return ctx.llm.stream({ ...sanitized, [RESOLVED]: true })
    }

    bump(options.model, 'requests')
    ctx.logger.info(
      `dsh-model-router: 路由 ${options.model} → ${picked.slot} (purpose=${options.purpose ?? 'main'}${options.tier !== undefined ? `, tier=${options.tier}` : ''}${cfg.healthRanking ? ', 健康排序' : ''}) → ` +
      `[${chain.map(cooldownKey).join(' → ')}]`
    )
    return routeThrough(chain, { ...options, __mrTier: picked.slot }, cfg)
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

  // 单个候选可用的思考级别档位（目录标注 verified=true；未标注则用兜底档位
  // 逐个实际请求预检，只保留宿主真正接受的，verified=false）。null = 不可用/未知。
  async function resolveEffortsFor(provider, model, fallback) {
    let list = null
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const reasoning = info && info.reasoning
      if (reasoning && Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0) {
        list = reasoning.efforts.map((e) => ({ id: e.id, name: e.name, verified: true }))
      }
    } catch {
      list = null
    }
    if (list === null && Array.isArray(fallback) && fallback.length > 0) {
      list = []
      const results = await Promise.all(fallback.map(async (id) => {
        try {
          await ctx.llm.resolveCallConfig({ provider, model, reasoningEffort: id })
          return { ok: true, id }
        } catch {
          return { ok: false, id }
        }
      }))
      for (const r of results) if (r.ok) list.push({ id: r.id, name: r.id, verified: false })
    }
    // 合并用户显式配置的档位：宿主认可 ∪ 用户配置。用户配置的档位即使被宿主
    // resolveModelInfo 裁剪（如 anthropic 只认 off/low/medium/high），也保留在下拉。
    const configured = configuredEffortsFor(provider, model)
    if (configured && configured.length > 0) {
      const seen = new Set((list || []).map((e) => e.id))
      const merged = (list || []).slice()
      for (const e of configured) {
        if (!seen.has(e.id)) {
          merged.push({ id: e.id, name: e.name, verified: true })
          seen.add(e.id)
        }
      }
      list = merged
    }
    return list
  }

  // 仅对当前配置引用的候选模型解析思考级别（有界、快速）
  async function buildEfforts(routes) {
    const efforts = {}
    const seen = new Set()
    const fallback = current().reasoningEffortsFallback || ['low', 'medium', 'high']
    for (const route of Object.values(routes)) {
      for (const slot of TIER_SLOTS) {
        for (const c of route[slot] || []) {
          const key = `${c.provider}/${c.model}`
          if (seen.has(key)) continue
          seen.add(key)
          const list = await resolveEffortsFor(c.provider, c.model, fallback)
          if (list !== null && list.length > 0) efforts[key] = list
        }
      }
    }
    return efforts
  }

  // 校验并规范化一份提交的 section；返回 {section} 或抛错
  async function validateSection(input) {
    if (input === null || typeof input !== 'object') throw new Error('body 必须是对象')
    const section = Config(input) // schema 规范化+默认值；非法直接抛
    // 面板保存的 body 不携带 manualTiers（会话手动档位由 /api/model-router/tier
    // 的 mutate 路径维护）。Config 对缺失字段填 default({})，若不兜底，
    // settings.replace 整段替换会把用户手动选的档位清空——表现为
    // 「明明选了夯(tier3)，改一次面板配置后自动变回 NPC(tier2 默认档)」。
    // 这里在 body 未显式提供 manualTiers 时保留现有持久化值。
    if (input.manualTiers === undefined) {
      section.manualTiers = current().manualTiers ?? {}
    }
    // reasoningEffortsFallback 同理：面板目前没有编辑入口，若 body 未携带，
    // 保留现有持久化值（否则 settings.replace 会把用户自定义的兜底档位集
    // 重置回默认 ['low','medium','high']）。
    if (input.reasoningEffortsFallback === undefined) {
      const existing = current().reasoningEffortsFallback
      if (Array.isArray(existing)) section.reasoningEffortsFallback = existing
    }
    // 各套餐的档位名称校验：key 只能是 tier1/tier2/tier3，值为非空字符串
    for (const [routeId, route] of Object.entries(section.routes)) {
      if (route.tierNames) {
        for (const [k, v] of Object.entries(route.tierNames)) {
          if (!TIER_SLOTS.includes(k)) throw new Error(`套餐 ${routeId} 档位名称的 key "${k}" 非法，只能是 tier1/tier2/tier3`)
          if (typeof v !== 'string' || v.trim() === '') throw new Error(`套餐 ${routeId} 档位 ${k} 的名称不能为空`)
        }
      }
    }
    const catalog = await buildCatalog()
    for (const [id, route] of Object.entries(section.routes)) {
      for (const slot of TIER_SLOTS) {
        for (const c of route[slot]) {
          if (!(catalog[c.provider] ?? []).includes(c.model)) {
            throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 不存在于当前模型目录`)
          }
          if (c.reasoningEffort !== undefined) {
            // 实际请求预检：resolveCallConfig 会对该 provider/model 的显式 effort
            // 做 capability 校验（宿主在 provider I/O 之前拒绝不支持的 effort，
            // 抛 UNSUPPORTED_REASONING_EFFORT）。通过才允许保存，失败在保存时即报错。
            try {
              await ctx.llm.resolveCallConfig({
                provider: c.provider,
                model: c.model,
                reasoningEffort: c.reasoningEffort,
              })
            } catch (e) {
              const code = e && typeof e.code === 'string' ? e.code : ''
              if (code === 'UNSUPPORTED_REASONING_EFFORT') {
                throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 不支持思考级别 ${c.reasoningEffort}（已用实际请求预检确认），请换一个档位`)
              }
              throw new Error(`路由 ${id} 的 ${slot} 候选 ${c.provider}/${c.model} 思考级别预检失败：${String((e && e.message) || e)}`)
            }
          }
        }
      }
    }
    // 归一：去掉兼容旧字段，只保留 tier1/tier2/tier3 + 套餐级 tierNames
    const normalized = {}
    for (const [id, route] of Object.entries(section.routes)) {
      normalized[id] = { tier1: route.tier1, tier2: route.tier2, tier3: route.tier3, ...(route.tierNames && Object.keys(route.tierNames).length > 0 ? { tierNames: route.tierNames } : {}) }
    }
    return { ...section, routes: normalized }
  }

  const webServer = ctx.webServer
  const settings = ctx.settings

  // ------------------------------------------------------------------
  // 模型能力（写回宿主 llm-pi-ai 配置）
  //
  // llm-pi-ai 通过 installSettingsSection 注册了同名的 settings 命名空间，
  // 且 onChange 会重新注册 adapter（热重载，live 生效）。插件用全局
  // ctx.settings（SettingsProvider）读写该命名空间：get/describe 读，
  // update 深合并写（只改目标 provider/model 的字段，其余配置保留）。
  // ------------------------------------------------------------------
  const LLM_PI_AI_NS = 'llm-pi-ai'
  const llmRawConfig = () => {
    if (!settings || typeof settings.describe !== 'function') return undefined
    try {
      const desc = settings.describe().find((d) => String(d.ns) === LLM_PI_AI_NS)
      return desc ? (desc.user ?? desc.value) : undefined
    } catch {
      return undefined
    }
  }

  // 自定义（hand-declared）供应商集合：pi-ai 不内置、完全由配置声明的 provider。
  // 模型能力编辑只对这类 provider 开放（内置目录的能力不该由本插件改写）。
  const declaredProviders = () => {
    try {
      const llm = ctx.llm
      if (!llm || typeof llm.listConfigurableProviders !== 'function') return new Set()
      return new Set(llm.listConfigurableProviders().filter((p) => p.declared === true).map((p) => p.provider))
    } catch {
      return new Set()
    }
  }

  // 从 llm-pi-ai 原始配置里取 provider/models 能力（reasoningEfforts/contextWindow/maxTokens）
  // 只返回自定义（declared）供应商的模型能力。
  function llmModelCapabilities() {
    const raw = llmRawConfig()
    const providers = (raw && raw.providers) || {}
    const declared = declaredProviders()
    const out = {}
    for (const [pid, p] of Object.entries(providers)) {
      if (!declared.has(pid)) continue
      const models = (p && Array.isArray(p.models) ? p.models : []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
        ...(m.reasoningEfforts !== undefined ? { reasoningEfforts: m.reasoningEfforts } : {}),
      }))
      out[pid] = models
    }
    return out
  }

  // 读取某 provider/model 在 llm-pi-ai 配置里显式声明的思考级别档位（任意供应商，
  // 不只自定义）。用户在模型能力卡片配置的档位，即使宿主 resolveModelInfo 裁剪
  // 掉（如 anthropic-messages 只认 off/low/medium/high），也应出现在路由下拉里。
  function configuredEffortsFor(provider, model) {
    try {
      const raw = llmRawConfig()
      if (!raw) return null
      const p = raw.providers && raw.providers[provider]
      if (!p || !Array.isArray(p.models)) return null
      const m = p.models.find((x) => x && x.id === model)
      const re = m && m.reasoningEfforts
      if (!re || typeof re !== 'object') return null
      // 键存在即声明了该档位（off 值为 null 也算声明）
      const ids = Object.keys(re)
      if (ids.length === 0) return null
      return ids.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), verified: true }))
    } catch {
      return null
    }
  }

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
            cooldowns: [...cooldowns.entries()].map(([key, rec]) => {
              const until = typeof rec === 'number' ? rec : rec.until // 兼容旧数字形态
              const detail = typeof rec === 'object' ? rec : {}
              return {
                key, until, remainingMs: Math.max(0, until - now),
                durationMs: detail.durationMs ?? null,
                code: detail.code ?? null,
                status: detail.status ?? null,
                streak: detail.streak ?? 0,
              }
            }),
            manualTiers: Object.fromEntries(manualTiers),
            history: history.slice().reverse(),
            stats: Object.fromEntries(stats),
            health: Object.fromEntries([...health.entries()].map(([k, h]) => [k, { ok: h.ok, fail: h.fail, streak: h.streak ?? 0 }])),
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

    // 模型能力：读取/写回 llm-pi-ai 的 provider/models 能力配置（reasoningEfforts/contextWindow/maxTokens）。
    // 同一 path 由 webServer 按 exact 去重，GET/POST 在此分发。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/model-capabilities',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          try {
            json(res, 200, {
              ok: true,
              writable: settings !== undefined && llmRawConfig() !== undefined,
              capabilities: llmModelCapabilities(),
            })
          } catch (e) {
            json(res, 500, { ok: false, error: String((e && e.message) || e) })
          }
          return
        }
        if (req.method === 'POST') {
          try {
            if (settings === undefined) return json(res, 503, { ok: false, error: 'settings 服务不可用' })
            const raw = llmRawConfig()
            if (raw === undefined) return json(res, 404, { ok: false, error: `未找到 ${LLM_PI_AI_NS} 配置，无法写回宿主模型能力` })
            const body = await readBody(req)
            const provider = String(body.provider ?? '')
            const model = String(body.model ?? '')
            const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
            if (!provider || !model) return json(res, 400, { ok: false, error: 'provider/model 必填' })
            // 只允许更新能力相关字段
            const allowed = new Set(['contextWindow', 'maxTokens', 'reasoningEfforts'])
            const cleanPatch = {}
            for (const [k, v] of Object.entries(patch)) {
              if (allowed.has(k)) cleanPatch[k] = v
            }
            if (Object.keys(cleanPatch).length === 0) return json(res, 400, { ok: false, error: 'patch 必须包含 contextWindow/maxTokens/reasoningEfforts 之一' })
            // 只允许修改自定义（hand-declared）供应商的能力；内置目录供应商由宿主目录管理
            if (!declaredProviders().has(provider)) {
              return json(res, 403, { ok: false, error: `provider ${provider} 是内置目录供应商，模型能力由宿主目录管理；只允许修改自定义供应商（如 ${[...declaredProviders()].join('、')}）` })
            }
            const providers = (raw.providers && typeof raw.providers === 'object') ? raw.providers : {}
            const p = providers[provider]
            if (!p || !Array.isArray(p.models)) return json(res, 404, { ok: false, error: `provider ${provider} 不存在或没有 models 列表` })
            const idx = p.models.findIndex((m) => m && m.id === model)
            if (idx < 0) return json(res, 404, { ok: false, error: `model ${provider}/${model} 不在 provider 配置中` })
            // 构造新的 models 数组（该 provider 的完整列表，只改目标项）
            const nextModels = p.models.map((m, i) => (i === idx ? { ...m, ...cleanPatch } : m))
            // 深合并写回：只替换 providers.<pid>.models，其余字段保留
            await settings.update(LLM_PI_AI_NS, { providers: { [provider]: { models: nextModels } } })
            ctx.logger.info(`dsh-model-router: 已写回宿主模型能力 ${provider}/${model} ${Object.keys(cleanPatch).join(',')}`)
            json(res, 200, { ok: true, capabilities: llmModelCapabilities() })
          } catch (e) {
            json(res, 400, { ok: false, error: String((e && e.message) || e) })
          }
          return
        }
        json(res, 405, { ok: false, error: 'method not allowed' })
      },
    }), 'dsh-model-router: model-capabilities')

    // 单个候选的可用思考级别档位：面板对新加（未保存）候选实时查询真实能力，
    // 避免误显示「不支持思考级别」（buildEfforts 只覆盖已保存候选）。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/model-router/efforts',
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          // 手动解析 query（避免 URL base 字面量触发静态扫描的明文 http 规则）
          const q = (req.url || '').split('?')[1] || ''
          const params = new URLSearchParams(q)
          const provider = params.get('provider') || ''
          const model = params.get('model') || ''
          if (!provider || !model) return json(res, 400, { ok: false, error: 'provider/model 必填' })
          const fallback = current().reasoningEffortsFallback || ['low', 'medium', 'high']
          const list = await resolveEffortsFor(provider, model, fallback)
          json(res, 200, { ok: true, key: `${provider}/${model}`, efforts: list || [] })
        } catch (e) {
          json(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }), 'dsh-model-router: efforts single')

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
    health.clear()
    manualTiers.clear()
  }, 'dsh-model-router: cleanup')

  console.log('[dsh-model-router] plugin ready') // 启动标记：运行级测试断言 apply 真实执行
  ctx.logger.info('dsh-model-router: 已加载（统一 ModelID 三档路由 + 故障转移 + 健康度择优 + 思考级别 + 管理面板 API）')
}
