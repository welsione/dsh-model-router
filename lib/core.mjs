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

// 可转移判断：错误码白名单命中，或 HTTP 状态为 429/408/5xx。
// 注意：429（限流）与 408（请求超时）是「瞬时/可恢复」失败，必须可转移——
// 它们的失败在 dsh-llm 层往往以 RATE_LIMIT/TIMEOUT code 到达，但有些
// adapter 只透传 status，若把 429 排除会导致第一个候选被限流时整个请求失败。
export function isRetryableFailure(failure) {
  if (!failure) return false
  if (typeof failure.code === 'string' && RETRYABLE_CODES.has(failure.code)) return true
  if (typeof failure.status === 'number') {
    if (failure.status === 429 || failure.status === 408) return true
    if (failure.status >= 500 && failure.status < 600) return true
  }
  return false
}

// 「瞬时/可恢复」错误：限流/配额/服务端/超时/传输/空响应——重试（同一候选
// 短暂等待后再试）大概率能恢复。AUTH（凭据问题）、UNKNOWN_MODEL、
// MODEL_NOT_FOUND（配置问题）属于「配置类」错误，重试无意义，直接切换候选。
export const TRANSIENT_CODES = new Set([
  'RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
])

export function isTransientFailure(failure) {
  if (!failure) return false
  if (typeof failure.code === 'string' && TRANSIENT_CODES.has(failure.code)) return true
  if (typeof failure.status === 'number') {
    if (failure.status === 429 || failure.status === 408) return true
    if (failure.status >= 500 && failure.status < 600) return true
  }
  return false
}

// 从「整链所有候选的失败」里选一个代表失败，用于 all-failed 上报。
// 语义：优先选【非瞬时 / 持久性】错误（AUTH/INVALID_CREDENTIAL/UNKNOWN_MODEL/
// MODEL_NOT_FOUND/INVALID_ARGUMENT 等）——宿主层的 dsh-llm-retry 对瞬时错误
// 才会整链重试，而持久性错误（凭据/套餐/配置问题不会自愈）重试毫无意义。
// 注意用 isTransientFailure 判定（而非 isRetryableFailure：后者含 AUTH 等
// 可转移但不该重试的错误码）。全部瞬时时才报第一个（链顺序 = 预期路径）。
// 返回 null 表示没有失败记录。
export function pickRepresentativeFailure(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return null
  const persistent = failures.find((f) => f && !isTransientFailure(f))
  return persistent ?? failures[0]
}

// 失败「代价」权重（健康度扣分用）：服务端/网络类失败说明候选本身不稳，
// 扣分重；限流/配额类说明候选其实活着、只是被限，扣分轻。
export function failureWeight(code, status) {
  const s = Number(status)
  if (code === 'SERVER' || code === 'TRANSPORT' || code === 'TIMEOUT' || (s >= 500 && s < 600)) return 3
  if (code === 'RATE_LIMIT' || code === 'QUOTA' || s === 429) return 1
  return 2
}

// 冷却时长：按失败类型分级 -> 乘指数退避（连续失败次数）-> 封顶。
//   quick  限流/配额/空响应（候选活着只是被限）   factor 0.2
//   medium 服务端/超时/传输（可能瞬时可恢复）      factor 0.5
//   hard   认证/未知模型/其他（需要人工介入）      factor 1.0
// 退避：dur = base * factor * backoff^(streak-1)，封顶 maxMs。
// streak=0（首次失败）→ 1 倍；连续第 n 次 → backoff^(n-1) 倍。
export function cooldownDurationMs(failure, baseMs, maxMs, backoff = 2, streak = 0) {
  const base = Math.max(1000, Math.round(Number(baseMs) || 300000))
  const cap = Math.max(base, Number(maxMs) || 1800000)
  const multi = Math.max(1, Math.round(Number(backoff) || 2))
  const code = failure?.code
  const s = Number(failure?.status)
  let factor = 1
  if (code === 'RATE_LIMIT' || code === 'QUOTA' || s === 429) factor = 0.2
  else if (code === 'SERVER' || code === 'TIMEOUT' || code === 'TRANSPORT' || (s >= 500 && s < 600)) factor = 0.5
  else if (code === 'EMPTY_RESPONSE') factor = 0.2
  const dur = base * factor * Math.pow(multi, Math.max(0, streak))
  return Math.min(cap, Math.round(dur))
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
// 结果记录（ok/fail + 时间戳 + 错误码，见 lib/index.js 的 markHealth），
// 据此打分，稳定成功的候选提前、频繁失败的候选后移，降低再次踩坑的概率。
//
// 评分规则（确定性、可单测、无外部状态）：
//   1) 时间衰减：每条记录按「距今」指数衰减，半衰期 5 分钟——最近的结果
//      权重高，陈旧结果快速失去影响（候选可能已恢复/已劣化）。
//   2) 错误码加权：成功 +decay；失败 -decay × failureWeight(code,status)
//      （服务端/网络类 -3，限流/配额类 -1，其余 -2）。
//   3) 无记录/未知 = 0。
// 兼容旧形态：buf 是布尔数组（无时间戳）时回退为 ok - 2*fail、无衰减。
// 排序用稳定排序：同分保持原配置顺序（用户显式排序仍然优先）。
// 入参 healthByKey = Map<`provider/model`, {buf:[{ok,ts,code?,status?}]}>。
export const HEALTH_HALF_LIFE_MS = 5 * 60_000 // 5 分钟半衰期

export function candidateHealthScore(health, now = Date.now()) {
  if (!health) return 0
  const buf = health.buf
  if (!Array.isArray(buf) || buf.length === 0) {
    return (health.ok || 0) - 2 * (health.fail || 0)
  }
  let score = 0
  for (const rec of buf) {
    const ts = typeof rec === 'object' ? rec.ts : undefined
    const age = ts === undefined ? 0 : Math.max(0, now - ts)
    const decay = Math.exp(-age / HEALTH_HALF_LIFE_MS)
    if (rec.ok) score += decay
    else if (typeof rec === 'object') score -= decay * failureWeight(rec.code, rec.status)
    else score -= decay * 2
  }
  return score
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

// ------------------------------------------------------------------
// 上下文窗口感知（feature: context-aware filtering）
//
// 问题：同一档候选链里上下文窗口可能不同（如 tier3 = k3-256k(256K) +
// glm-5.3(1M)）。会话体量超过小窗口候选后，每次请求都先打它失败一次
// （上下文溢出）再 failover——浪费一次请求 + 延迟，且溢出错误会污染该
// 候选的冷却/健康档案（它对小请求其实是健康的）。
//
// 做法：按请求 messages 的启发式 token 估算，跳过「肯定装不下」的候选。
// 估算标尺与宿主 dsh-token-meter 完全一致（固定密度 CHARS_PER_TOKEN=4，
// 每块结构开销 BLOCK_OVERHEAD=4，消息角色开销 ROLE_OVERHEAD=4）——
// 与 compaction 压力判定同源，避免两套标尺互相打架。
// ------------------------------------------------------------------
export const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

function estimateContentTokens(blocks) {
  let tokens = 0
  if (!Array.isArray(blocks)) return tokens
  for (const block of blocks) {
    if (!block || typeof block !== 'object') { tokens += BLOCK_OVERHEAD; continue }
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN)
          + Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContentTokens(block.content) + BLOCK_OVERHEAD
        break
      default:
        // image/file 等：JSON 序列化长度粗估（base64 会放大，但这类块罕见，
        // 且高估只会保守跳过，不会误放行装不下的请求）
        try { tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN) } catch { tokens += BLOCK_OVERHEAD }
    }
  }
  return tokens
}

// 单条消息：content 数组（string content 也兼容）+ 角色框架开销
export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0
  const content = message.content
  const blocks = Array.isArray(content)
    ? content
    : (typeof content === 'string' ? [{ type: 'text', text: content }] : [])
  return estimateContentTokens(blocks) + ROLE_OVERHEAD
}

// 整次请求的输入体量：messages 合计 + system + tools（若有）
export function estimateRequestTokens(options) {
  const messages = options?.messages
  let total = 0
  if (Array.isArray(messages)) {
    for (const m of messages) total += estimateMessageTokens(m)
  }
  const system = options?.system
  if (typeof system === 'string' && system.length > 0) {
    total += Math.ceil(system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  const tools = options?.tools
  if (Array.isArray(tools) && tools.length > 0) {
    try { total += Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD } catch { /* ignore */ }
  }
  return total
}

// 过滤装不下的候选。windowOf(candidate) 返回该候选的上下文窗口（number|null；
// null = 未知 → 不过滤，放行尝试）。reserveTokens = 输出预留（maxTokens 或固定值），
// margin = 窗口可用比例（如 0.9）。返回 { chain, skipped }：
//   chain   —— 过滤后的候选链（保持原顺序）
//   skipped —— [{candidate, window, needed}] 被跳过的候选及原因（供事件/面板展示）
// 注意：本函数不做「全被过滤」的兜底决策——调用方拿到空 chain 后自行决定
// （路由层会回退为「用原链继续 failover」，避免估算失准把可用候选误杀）。
export function filterChainByContext(chain, neededTokens, windowOf, opts = {}) {
  const margin = typeof opts.margin === 'number' && opts.margin > 0 && opts.margin <= 1 ? opts.margin : 1
  const reserve = typeof opts.reserveTokens === 'number' && opts.reserveTokens > 0 ? opts.reserveTokens : 0
  const need = neededTokens + reserve
  const kept = []
  const skipped = []
  for (const candidate of chain) {
    const win = windowOf(candidate)
    if (typeof win === 'number' && win > 0 && need > win * margin) {
      skipped.push({ candidate, window: win, needed: need })
      continue
    }
    kept.push(candidate)
  }
  return { chain: kept, skipped }
}

// ------------------------------------------------------------------
// L1 · 会话事件类型注册加固（卸载兼容）
// ------------------------------------------------------------------
// 本插件向会话日志写 'model-router/route' 自定义事件。harness 恢复会话时
// dsh-session-persistence.assertEventsSupported 对「不在 KNOWN_SESSION_EVENT_TYPES
// 且未带 ignorable 信封标记」的事件抛 SessionFormatUnsupportedError，导致
// 卸载本插件后所有含路由事件的历史会话拒载。
//   session.append(type, data, opts) 不透传 ignorable（opts 只读
// sourceEventSeqs/surfaceOp，事件在内部构造并 deepFreeze），无法让事件天生
// 自足；因此需要把类型注册进共享的 KNOWN_SESSION_EVENT_TYPES Set。
//   风险：该 Set 是模块级单例，注册只在「与 persistence 解析到同一模块实例
// （同一 realpath）」时生效。pnpm 提升 / harness 升级 / 多份拷贝导致 realpath
// 分叉时，静态 import 可能打到另一份 Set 上，persistence 认不得 → 老故障
// 无声复发。故这里把「目标 Set 的收集」抽成纯函数：静态 import 实例 +
// 经由各消费方包解析出的额外实例，逐份注册并在全部失败时升级日志级别。
export const ROUTE_EVENT_TYPE = 'model-router/route'

// 纯函数：把 type 注册进一组候选 Set。返回 { registered, failed } 供日志分级。
// 每个 entry 形如 { path, set }；对非 Set/抛错的实例记入 failed 而不中断。
export function registerRouteEventType(targets, type = ROUTE_EVENT_TYPE) {
  const registered = []
  const failed = []
  for (const t of targets) {
    const set = t && t.set
    try {
      if (set && typeof set.add === 'function') {
        set.add(type)
        registered.push(t.path || '<unknown>')
      } else {
        failed.push({ path: (t && t.path) || '<unknown>', reason: 'not a Set' })
      }
    } catch (e) {
      failed.push({ path: (t && t.path) || '<unknown>', reason: String((e && e.message) || e) })
    }
  }
  return { registered, failed }
}
