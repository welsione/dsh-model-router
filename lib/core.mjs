// dsh-model-router — 纯逻辑核心（无 dsh 依赖，可独立单元测试）
//
// 从 lib/index.js 提取的可测纯函数。保持无副作用、不 import dsh 运行时，
// 便于 tests/ 用 node:test 直接覆盖，也符合「把路由决策逻辑与 io 接线分开」的
// 工程卫生（发布前四连里的单元测试层）。

export const NS = 'model-router'
export const TIER_SLOTS = ['tier1', 'tier2', 'tier3']

// 跨层标记：llm/stream 中间件内部重入（防止把自己的改写再路由一次）
export const RESOLVED = Symbol('dshModelRouterResolved')

// 可转移错误码白名单（首 token 前失败才切，见 routeThrough 判断）
export const RETRYABLE_CODES = new Set([
  'AUTH', 'RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  'UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'EMPTY_RESPONSE',
])

export const cooldownKey = (c) => `${c.provider}/${c.model}`

export function isRetryableFailure(failure) {
  if (!failure) return false
  if (typeof failure.code === 'string' && RETRYABLE_CODES.has(failure.code)) return true
  if (typeof failure.status === 'number' && failure.status >= 500 && failure.status < 600) return true
  return false
}

// 旧 simple/complex → tier1/tier2 迁移；缺省档位兜底为空数组（对裸对象也安全）
export function normalizeRoute(route) {
  const out = {
    tier1: route.tier1 ?? [],
    tier2: route.tier2 ?? [],
    tier3: route.tier3 ?? [],
  }
  if (out.tier1.length === 0 && route.simple && route.simple.length > 0) out.tier1 = route.simple
  if (out.tier2.length === 0 && route.complex && route.complex.length > 0) out.tier2 = route.complex
  // 套餐级档位显示名（tier1/tier2/tier3 → 自定义名），透传
  if (route.tierNames && typeof route.tierNames === 'object' && Object.keys(route.tierNames).length > 0) {
    out.tierNames = route.tierNames
  }
  return out
}

// 按「候选模型名」反查套餐：会话模型是真实模型名（如 volcengine/deepseek-v4-flash）
// 而非套餐 key（如 Economy）时，找到包含它的套餐路由。
// 遍历顺序 = settings 里的声明顺序，取第一个匹配（多套餐共享候选时的约定）。
export function findByCandidate(routes, model) {
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
// 健康度感知择优（feature: health-ranking）
//
// 目的：候选链不再只按「配置顺序」盲试。每个候选维护一个滑动窗口内的
// 结果计数（ok/fail，见 lib/index.js 的 markHealth），据此打分，
// 稳定成功的候选提前、频繁失败的候选后移，降低再次踩坑的概率。
//
// 评分规则（确定性、可单测、无外部状态）：
//   score = ok - 2 * fail     —— 一次失败约抵消两次成功；无记录/未知 = 0。
// 排序用稳定排序：同分保持原配置顺序（用户显式排序仍然优先）。
// 入参 healthByKey = Map<`provider/model`, {ok, fail}>（索引侧维护），缺省全 0。
export function candidateHealthScore(health) {
  if (!health) return 0
  return (health.ok || 0) - 2 * (health.fail || 0)
}

export function rankChainByHealth(chain, healthByKey) {
  if (!Array.isArray(chain) || chain.length < 2) return chain
  return chain
    .map((c, i) => ({ c, i, score: candidateHealthScore(healthByKey?.get(cooldownKey(c))) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((x) => x.c)
}

// ------------------------------------------------------------------
// 思考级别候选池（feature: reasoning-efforts-fallback）
//
// 目录已标注的候选：按目录暴露的档位（verified=true）。
// 目录未标注的候选：允许从兜底候选集选择（verified=false）。
// 默认兜底 = models.dev 出现频率最高的通用三档 low/medium/high，
// 用户可通过配置 reasoningEffortsFallback 自定义（如完整集
// none/minimal/low/medium/high/xhigh/max）。
//
// 注意：这里只定义「候选池」。真正决定哪些档位可保存/可用的，
// 是 lib/index.js 里的实际请求预检（ctx.llm.resolveCallConfig，
// 宿主在 provider I/O 之前拒绝不支持的显式 effort）。本函数保持
// 纯函数、确定性、可单测，描述候选池的组成规则。
// ------------------------------------------------------------------
export function effortsForCandidate(catalogEfforts, fallback) {
  // catalogEfforts: null/undefined/[] = 未标注 → 用兜底；非空数组 = 已标注
  const listed = Array.isArray(catalogEfforts) && catalogEfforts.length > 0
  const fb = Array.isArray(fallback) && fallback.length > 0 ? fallback : []
  if (listed) return catalogEfforts.map((e) => ({ id: e.id, name: e.name, verified: true }))
  if (fb.length > 0) return fb.map((id) => ({ id, name: id, verified: false }))
  return []
}

// 校验思考级别是否可接受：
//   - 已标注 → 必须在目录档位内
//   - 未标注 → 必须在兜底档位内（fallback 为空时拒绝一切手动档位）
// 返回 null = 通过，否则返回错误说明。
export function validateReasoningEffort(candidateEffort, catalogEfforts, fallback) {
  if (candidateEffort === undefined || candidateEffort === null || candidateEffort === '') return null
  const listed = Array.isArray(catalogEfforts) && catalogEfforts.length > 0
  const pool = listed ? catalogEfforts.map((e) => e.id) : (Array.isArray(fallback) ? fallback : [])
  if (pool.length === 0) return `模型目录未标注推理能力，且未配置兜底档位（reasoningEffortsFallback）`
  if (!pool.includes(candidateEffort)) {
    const which = listed ? '目录支持的档位' : '兜底档位（reasoningEffortsFallback）'
    return `思考级别 ${candidateEffort} 不在该模型${which}（${pool.join('/')}）中`
  }
  return null
}

// 选档：options.tier 显式 > 系统轻量 purpose(tier1) > 会话手动档 > tier2
export function selectTier(options, route, getManualTier = () => undefined) {
  if (options.tier !== undefined) {
    const t = Number(options.tier)
    if (Number.isInteger(t) && t >= 1 && t <= 3) return `tier${t}`
  }
  const p = options.purpose
  if (p === 'compaction' || p === 'session-title') return 'tier1'
  const manual = options.sessionId ? getManualTier(options.sessionId) : undefined
  if (manual && route[manual] && route[manual].length > 0) return manual
  return 'tier2'
}

// 选中档空 → 逐级降档（tier3→tier2→tier1），全空返回 null
export function pickChain(route, tierSlot) {
  const idx = TIER_SLOTS.indexOf(tierSlot)
  const order = TIER_SLOTS.slice(0, idx + 1).reverse()
  for (const slot of order) {
    if (route[slot] && route[slot].length > 0) return { slot, chain: route[slot] }
  }
  return null
}

// ------------------------------------------------------------------
// 思考包裹标签剥离（流级、状态化、支持标签跨 chunk 拆散）
// ------------------------------------------------------------------
export function makeThinkingTagStripper() {
  let carry = ''
  const TAG_RE = /<\/?(?:thinking|think|reasoning|response|answer|output|final|result|antml:(?:thinking|invoke|parameter|result|output|reasoning))(?:\s[^>]*)?>/gi
  const PARTIAL_RE = /(?:^|[\s.。！？!?，,；;:：])(<)?\/?(?:think(?:ing)?|respons|reasoning|answer)?$/gi
  const BARE_RESPONSE_RE = /(?:^|[\s.。！？!?，,；;:：])response(?=[^\s\w])/gi

  return function clean(text) {
    let input = carry + text
    let output = input.replace(TAG_RE, '')
    output = output.replace(BARE_RESPONSE_RE, '')
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
// replayState 清洗（跨 provider / 模型切换防污染，INVALID_REPLAY_STATE）
//
// 注意：必须同时拿到候选的 model——只比 provider 会漏掉「同 provider 换模型」
// （如 opencode-go 的 mimo-v2.5 → deepseek-v4-flash）的污染消息。
// ------------------------------------------------------------------
export function withSanitizedReplayState(options, provider, model) {
  const messages = options.messages
  if (!Array.isArray(messages)) return options
  let changed = false
  const sanitized = messages.map((message) => {
    const source = message.source
    if (message.role !== 'assistant' || source?.kind !== 'model' || source.replayState === undefined) return message
    const rs = source.replayState
    // 仅当 replayState 的 provider 与 model 都与「当前候选」及「消息自身 source」
    // 完全一致时保留原生 replay；否则剥离（内容不受影响）。
    if (rs.provider === provider && rs.model === model && rs.provider === source.provider && rs.model === source.model) return message
    changed = true
    return { ...message, source: { kind: 'model', provider: source.provider, model: source.model } }
  })
  return changed ? { ...options, messages: sanitized } : options
}
