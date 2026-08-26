// dsh-model-router — 核心纯函数单元测试（node:test，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TIER_SLOTS,
  cooldownKey,
  isRetryableFailure,
  isTransientFailure,
  pickRepresentativeFailure,
  cooldownDurationMs,
  failureWeight,
  normalizeRoute,
  findByCandidate,
  selectTier,
  pickChain,
  rankChainByHealth,
  candidateHealthScore,
  effortsForCandidate,
  validateReasoningEffort,
  withSanitizedReplayState,
} from '../lib/core.mjs'

const cand = (provider, model, reasoningEffort) => {
  const c = { provider, model }
  if (reasoningEffort) c.reasoningEffort = reasoningEffort
  return c
}
const route = (t1 = [], t2 = [], t3 = []) => ({ tier1: t1, tier2: t2, tier3: t3 })

test('cooldownKey', () => {
  assert.equal(cooldownKey({ provider: 'volcengine', model: 'deepseek-v4-flash' }), 'volcengine/deepseek-v4-flash')
})

test('TIER_SLOTS ordered tier1→tier3', () => {
  assert.deepEqual(TIER_SLOTS, ['tier1', 'tier2', 'tier3'])
})

test('isRetryableFailure: retryable codes', () => {
  for (const code of ['AUTH', 'RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'EMPTY_RESPONSE']) {
    assert.equal(isRetryableFailure({ code }), true, code)
  }
  assert.equal(isRetryableFailure({ code: 'INVALID_ARGUMENT' }), false)
  assert.equal(isRetryableFailure({ status: 503 }), true)
  assert.equal(isRetryableFailure({ status: 500 }), true)
  // 429 限流 / 408 请求超时：瞬时可恢复 → 必须可转移（否则首个候选被限流即整体失败）
  assert.equal(isRetryableFailure({ status: 429 }), true)
  assert.equal(isRetryableFailure({ status: 408 }), true)
  // 4xx 业务错误不可转移
  assert.equal(isRetryableFailure({ status: 401 }), false)
  assert.equal(isRetryableFailure({ status: 404 }), false)
  assert.equal(isRetryableFailure(null), false)
  assert.equal(isRetryableFailure(undefined), false)
})

test('isTransientFailure: transient errors (retryable in place)', () => {
  for (const code of ['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']) {
    assert.equal(isTransientFailure({ code }), true, code)
  }
  assert.equal(isTransientFailure({ status: 429 }), true)
  assert.equal(isTransientFailure({ status: 408 }), true)
  assert.equal(isTransientFailure({ status: 503 }), true)
  assert.equal(isTransientFailure({ status: 500 }), true)
  // 配置类错误：可转移但不该重试（重试无意义）
  assert.equal(isTransientFailure({ code: 'AUTH' }), false)
  assert.equal(isTransientFailure({ code: 'UNKNOWN_MODEL' }), false)
  assert.equal(isTransientFailure({ code: 'MODEL_NOT_FOUND' }), false)
  assert.equal(isTransientFailure({ status: 401 }), false)
  assert.equal(isTransientFailure({ status: 404 }), false)
  assert.equal(isTransientFailure(null), false)
  assert.equal(isTransientFailure(undefined), false)
})

test('pickRepresentativeFailure: prefers persistent (non-transient) failure over transient', () => {
  // AUTH 是非瞬时（持久性）错误 → 应被选中（宿主层不会对持久性错误整链盲目重试）
  const failures = [
    { code: 'RATE_LIMIT', status: 429 },
    { code: 'AUTH', status: 401 },
  ]
  assert.equal(pickRepresentativeFailure(failures).code, 'AUTH')
  // 顺序无关：持久性错误的优先
  const reversed = [failures[1], failures[0]]
  assert.equal(pickRepresentativeFailure(reversed).code, 'AUTH')
  // UNKNOWN_MODEL 也是持久性
  assert.equal(pickRepresentativeFailure([{ code: 'SERVER' }, { code: 'UNKNOWN_MODEL' }]).code, 'UNKNOWN_MODEL')
})
test('pickRepresentativeFailure: all-transient -> first (chain order)', () => {
  const failures = [
    { code: 'TIMEOUT' },
    { code: 'SERVER', status: 500 },
  ]
  assert.equal(pickRepresentativeFailure(failures).code, 'TIMEOUT')
})
test('pickRepresentativeFailure: empty / invalid input -> null', () => {
  assert.equal(pickRepresentativeFailure([]), null)
  assert.equal(pickRepresentativeFailure(undefined), null)
  assert.equal(pickRepresentativeFailure(null), null)
})

test('normalizeRoute: migrates legacy simple/complex when new slots empty', () => {
  const legacy = { simple: [cand('a', 'm1')], complex: [cand('b', 'm2')] }
  const out = normalizeRoute(legacy)
  assert.deepEqual(out.tier1, legacy.simple)
  assert.deepEqual(out.tier2, legacy.complex)
  assert.deepEqual(out.tier3, [])
})
test('normalizeRoute: prefers new fields over legacy', () => {
  const out = normalizeRoute({ tier1: [cand('a', 'new1')], simple: [cand('a', 'old1')] })
  assert.equal(out.tier1[0].model, 'new1')
})

test('findByCandidate: reverse lookup by real model name', () => {
  const routes = {
    plan: route([], [cand('v', 'deepseek-v4-flash')]),
    speed: route([cand('o', 'mimo-v2.5')]),
  }
  assert.equal(findByCandidate(routes, 'deepseek-v4-flash'), routes.plan)
  assert.equal(findByCandidate(routes, 'mimo-v2.5'), routes.speed)
  assert.equal(findByCandidate(routes, 'nope-model'), undefined)
})

test('selectTier: explicit options.tier wins', () => {
  assert.equal(selectTier({ tier: 3 }, route(), () => undefined), 'tier3')
  assert.equal(selectTier({ tier: 1 }, route(), () => undefined), 'tier1')
  assert.equal(selectTier({ tier: 9 }, route(), () => undefined), 'tier2') // 非法回默认
})
test('selectTier: system light tasks forced to tier1 (manual ignored)', () => {
  assert.equal(selectTier({ purpose: 'compaction', sessionId: 's1' }, route(), () => 'tier3'), 'tier1')
  assert.equal(selectTier({ purpose: 'session-title', sessionId: 's1' }, route(), () => 'tier3'), 'tier1')
})
test('selectTier: manual tier applies only when that slot has candidates', () => {
  const r = route([cand('o', 'm')], [cand('v', 'd')])
  assert.equal(selectTier({ sessionId: 's1' }, r, () => 'tier1'), 'tier1')
  // 手动选了空档 tier3 → 回退默认 tier2
  assert.equal(selectTier({ sessionId: 's1' }, r, () => 'tier3'), 'tier2')
})
test('selectTier: default is tier2', () => {
  assert.equal(selectTier({}, route(), () => undefined), 'tier2')
})

test('pickChain: direct slot, downgrade, all-empty', () => {
  const r = { tier1: [cand('a', 'm1')], tier2: [], tier3: [cand('c', 'm3')] }
  assert.equal(pickChain(r, 'tier3').slot, 'tier3')
  assert.equal(pickChain(r, 'tier2').slot, 'tier1') // tier2 空 → 降 tier1
  assert.equal(pickChain({ tier1: [], tier2: [], tier3: [] }, 'tier3'), null)
})

test('withSanitizedReplayState: keeps replayState matching current candidate', () => {
  const msg = { role: 'assistant', source: { kind: 'model', provider: 'v', model: 'deepseek-v4-flash', replayState: { provider: 'v', model: 'deepseek-v4-flash' } } }
  const options = { messages: [msg] }
  assert.equal(withSanitizedReplayState(options, 'v', 'deepseek-v4-flash'), options) // 干净 → 返回原引用
})
test('withSanitizedReplayState: strips when provider differs', () => {
  const msg = { role: 'assistant', source: { kind: 'model', provider: 'v', model: 'deepseek-v4-flash', replayState: { provider: 'v', model: 'deepseek-v4-flash' } } }
  const out = withSanitizedReplayState({ messages: [msg] }, 'opencode-go', 'mimo-v2.5')
  assert.equal(out.messages[0].source.replayState, undefined)
  assert.equal(out.messages[0].source.provider, 'v') // 内容/来源保留，只丢原生 replay
})
test('withSanitizedReplayState: strips when model differs on same provider (needs candidate model)', () => {
  const msg = { role: 'assistant', source: { kind: 'model', provider: 'o', model: 'deepseek-v4-flash', replayState: { provider: 'o', model: 'deepseek-v4-flash' } } }
  // 候选切到同 provider 的不同模型 mimo-v2.5 → 必须剥离（否则 INVALID_REPLAY_STATE）
  const out = withSanitizedReplayState({ messages: [msg] }, 'o', 'mimo-v2.5')
  assert.equal(out.messages[0].source.replayState, undefined)
})
test('withSanitizedReplayState: leaves user/tool messages alone', () => {
  const user = { role: 'user', content: 'hi' }
  const options = { messages: [user] }
  assert.equal(withSanitizedReplayState(options, 'v'), options)
})

test('candidateHealthScore: neutral when no evidence', () => {
  assert.equal(candidateHealthScore(undefined), 0)
  assert.equal(candidateHealthScore({}), 0)
  assert.equal(candidateHealthScore({ ok: 0, fail: 0 }), 0)
})
test('candidateHealthScore: legacy {ok,fail} counters fall back to ok - 2*fail', () => {
  assert.equal(candidateHealthScore({ ok: 3, fail: 0 }), 3)
  assert.equal(candidateHealthScore({ ok: 0, fail: 1 }), -2)
  assert.equal(candidateHealthScore({ ok: 2, fail: 1 }), 0) // 2 - 2*1
})
test('candidateHealthScore: fresh buf records with weights (decay=1 at now)', () => {
  const now = Date.now()
  const buf = [
    { ok: true, ts: now },
    { ok: true, ts: now },
    { ok: true, ts: now },
  ]
  assert.equal(candidateHealthScore({ buf }, now), 3) // 3 次成功
  // 1 次未知码失败 = -2
  assert.equal(candidateHealthScore({ buf: [...buf, { ok: false, ts: now, code: null }] }, now), 1)
})
test('candidateHealthScore: failure weight by code (rate-limit -1, server -3)', () => {
  const now = Date.now()
  const mk = (code, status) => ({ ok: false, ts: now, code, status })
  assert.equal(candidateHealthScore({ buf: [mk('RATE_LIMIT')] }, now), -1)
  assert.equal(candidateHealthScore({ buf: [mk('QUOTA')] }, now), -1)
  assert.equal(candidateHealthScore({ buf: [mk('SERVER')] }, now), -3)
  assert.equal(candidateHealthScore({ buf: [mk('TRANSPORT')] }, now), -3)
  assert.equal(candidateHealthScore({ buf: [mk(null, 503)] }, now), -3)
  assert.equal(candidateHealthScore({ buf: [mk(null, 429)] }, now), -1)
  assert.equal(candidateHealthScore({ buf: [mk('AUTH')] }, now), -2)
})
test('candidateHealthScore: time decay — old results weigh less', () => {
  const now = Date.now()
  const old = now - 10 * 60_000 // 10 分钟前（≈ 半衰期 5 分钟的 e^-2 ≈ 0.135）
  const recent = now - 1000
  const oldFail = candidateHealthScore({ buf: [{ ok: false, ts: old, code: 'SERVER' }] }, now)
  const recentFail = candidateHealthScore({ buf: [{ ok: false, ts: recent, code: 'SERVER' }] }, now)
  assert.ok(recentFail < oldFail, `recent ${recentFail} should be worse than old ${oldFail}`)
  assert.ok(oldFail > -3 && oldFail < 0, `old fail decays toward 0: ${oldFail}`)
})

test('failureWeight: rate-limit/quota/429 light, server/transport/timeout heavy', () => {
  assert.equal(failureWeight('RATE_LIMIT', null), 1)
  assert.equal(failureWeight('QUOTA', null), 1)
  assert.equal(failureWeight(null, 429), 1)
  assert.equal(failureWeight('SERVER', null), 3)
  assert.equal(failureWeight('TRANSPORT', null), 3)
  assert.equal(failureWeight('TIMEOUT', null), 3)
  assert.equal(failureWeight(null, 503), 3)
  assert.equal(failureWeight('AUTH', null), 2)
  assert.equal(failureWeight(null, null), 2)
})

test('cooldownDurationMs: base scaling by failure class', () => {
  const base = 300000, max = 1800000, backoff = 2, streak = 0
  // 硬失败（AUTH/未知模型/其他）= 满额
  assert.equal(cooldownDurationMs({ code: 'AUTH' }, base, max, backoff, streak), 300000)
  assert.equal(cooldownDurationMs({}, base, max, backoff, streak), 300000)
  // 服务端/超时/传输 = 0.5x
  assert.equal(cooldownDurationMs({ code: 'SERVER' }, base, max, backoff, streak), 150000)
  assert.equal(cooldownDurationMs({ code: 'TIMEOUT' }, base, max, backoff, streak), 150000)
  assert.equal(cooldownDurationMs({ status: 503 }, base, max, backoff, streak), 150000)
  // 限流/配额/空响应 = 0.2x
  assert.equal(cooldownDurationMs({ code: 'RATE_LIMIT' }, base, max, backoff, streak), 60000)
  assert.equal(cooldownDurationMs({ code: 'QUOTA' }, base, max, backoff, streak), 60000)
  assert.equal(cooldownDurationMs({ status: 429 }, base, max, backoff, streak), 60000)
  assert.equal(cooldownDurationMs({ code: 'EMPTY_RESPONSE' }, base, max, backoff, streak), 60000)
})
test('cooldownDurationMs: exponential backoff on consecutive failures, capped', () => {
  const base = 300000, max = 1800000, backoff = 2
  // 连续失败 streak=1 → 2x；streak=2 → 4x；… 封顶 max
  assert.equal(cooldownDurationMs({ code: 'AUTH' }, base, max, backoff, 0), 300000)
  assert.equal(cooldownDurationMs({ code: 'AUTH' }, base, max, backoff, 1), 600000)
  assert.equal(cooldownDurationMs({ code: 'AUTH' }, base, max, backoff, 2), 1200000)
  assert.equal(cooldownDurationMs({ code: 'AUTH' }, base, max, backoff, 3), 1800000) // 2400000 → 封顶 1800000
  assert.equal(cooldownDurationMs({ code: 'AUTH' }, base, max, backoff, 10), 1800000) // 封顶
  // 限流类也退避但基数小：streak=1 → 120000
  assert.equal(cooldownDurationMs({ code: 'RATE_LIMIT' }, base, max, backoff, 1), 120000)
  // 自定义退避倍数
  assert.equal(cooldownDurationMs({ code: 'AUTH' }, base, max, 3, 1), 900000)
})
test('cooldownDurationMs: clamps tiny bases to 1s', () => {
  assert.equal(cooldownDurationMs({ code: 'AUTH' }, 100, 5000, 2, 0), 1000)
})

test('rankChainByHealth: promotes stable-success candidate, demotes frequent-failures', () => {
  const ok = cand('v', 'deepseek-v4-flash')
  const bad = cand('o', 'mimo-v2.5')
  const health = new Map([
    [cooldownKey(ok), { ok: 5, fail: 0 }],
    [cooldownKey(bad), { ok: 0, fail: 4 }],
  ])
  // 配置顺序 bad 在前，但健康度让 ok 提前
  const out = rankChainByHealth([bad, ok], health)
  assert.equal(cooldownKey(out[0]), cooldownKey(ok))
  assert.equal(cooldownKey(out[1]), cooldownKey(bad))
})
test('rankChainByHealth: ties keep configured order (stable)', () => {
  const a = cand('v', 'm1')
  const b = cand('o', 'm2')
  const c = cand('x', 'm3')
  const health = new Map([
    [cooldownKey(a), { ok: 1, fail: 0 }], // score 1
    [cooldownKey(c), { ok: 2, fail: 0 }], // score 2 → 提前
  ])
  const out = rankChainByHealth([a, b, c], health)
  assert.deepEqual(out.map(cooldownKey), [cooldownKey(c), cooldownKey(a), cooldownKey(b)]) // b 无记录 score 0
})
test('rankChainByHealth: no evidence / disabled input returns original order', () => {
  const a = cand('v', 'm1')
  const b = cand('o', 'm2')
  assert.deepEqual(rankChainByHealth([a, b], null).map(cooldownKey), [cooldownKey(a), cooldownKey(b)])
  assert.deepEqual(rankChainByHealth([a], new Map()).map(cooldownKey), [cooldownKey(a)]) // 单候选原样
})

// ------------------------------------------------------------------
// 思考级别兜底（reasoning-efforts-fallback）
// ------------------------------------------------------------------
test('effortsForCandidate: listed model keeps catalog efforts (verified)', () => {
  const catalog = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
  const out = effortsForCandidate(catalog, ['low', 'medium', 'high'])
  assert.deepEqual(out, [
    { id: 'low', name: 'Low', verified: true },
    { id: 'high', name: 'High', verified: true },
  ])
})
test('effortsForCandidate: unlisted model falls back to generic efforts (unverified)', () => {
  const out = effortsForCandidate(null, ['low', 'medium', 'high'])
  assert.deepEqual(out, [
    { id: 'low', name: 'low', verified: false },
    { id: 'medium', name: 'medium', verified: false },
    { id: 'high', name: 'high', verified: false },
  ])
})
test('effortsForCandidate: empty catalog treated as unlisted → fallback; empty fallback yields nothing', () => {
  // 空目录数组 = 适配器未暴露可选档位 → 视同未标注，走兜底
  assert.deepEqual(effortsForCandidate([], ['low']), [{ id: 'low', name: 'low', verified: false }])
  assert.deepEqual(effortsForCandidate(null, []), [])
  assert.deepEqual(effortsForCandidate(undefined, undefined), [])
})
test('validateReasoningEffort: listed model enforces catalog pool', () => {
  const catalog = [{ id: 'low' }, { id: 'high' }]
  assert.equal(validateReasoningEffort('low', catalog, ['low', 'medium', 'high']), null)
  assert.ok(validateReasoningEffort('max', catalog, ['low', 'medium', 'high']).includes('不在该模型目录支持的档位'))
})
test('validateReasoningEffort: unlisted model allows fallback pool', () => {
  assert.equal(validateReasoningEffort('high', null, ['low', 'medium', 'high']), null)
  assert.ok(validateReasoningEffort('max', null, ['low', 'medium', 'high']).includes('不在该模型兜底档位'))
})
test('validateReasoningEffort: empty value passes; empty fallback rejects all', () => {
  assert.equal(validateReasoningEffort('', null, ['low']), null)
  assert.equal(validateReasoningEffort(undefined, null, ['low']), null)
  assert.ok(validateReasoningEffort('low', null, []).includes('未配置兜底档位'))
})

