// dsh-model-router — 核心纯函数单元测试（node:test，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TIER_SLOTS,
  cooldownKey,
  isRetryableFailure,
  normalizeRoute,
  findByCandidate,
  selectTier,
  pickChain,
  rankChainByHealth,
  candidateHealthScore,
  effortsForCandidate,
  validateReasoningEffort,
  makeThinkingTagStripper,
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
  assert.equal(isRetryableFailure({ status: 429 }), false)
  assert.equal(isRetryableFailure(null), false)
  assert.equal(isRetryableFailure(undefined), false)
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

test('makeThinkingTagStripper: strips wrapper tags, keeps inner content', () => {
  const strip = makeThinkingTagStripper()
  // 设计语义：只剥包裹标签，不删内容（防止 <response>答案</response> 这类整段包裹被误删）
  assert.equal(strip('<thinking>思考中</thinking>正文'), '思考中正文')
  assert.equal(strip('<response>答案</response>'), '答案')
  assert.equal(strip('<antml:thinking>t</antml:thinking>hello'), 'thello')
})
test('makeThinkingTagStripper: tag split across chunks', () => {
  const strip = makeThinkingTagStripper()
  assert.equal(strip('前<thinki'), '前')
  assert.equal(strip('ng>x</thinking>后'), 'x后')
})
test('makeThinkingTagStripper: strips bare boundary response', () => {
  const strip = makeThinkingTagStripper()
  assert.equal(strip('你好 response！结束'), '你好！结束')
})
test('makeThinkingTagStripper: keeps ordinary words with spaces', () => {
  const strip = makeThinkingTagStripper()
  assert.equal(strip('请给出 response 说明'), '请给出 response 说明')
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
test('candidateHealthScore: success counts +1, failure costs 2', () => {
  assert.equal(candidateHealthScore({ ok: 3, fail: 0 }), 3)
  assert.equal(candidateHealthScore({ ok: 0, fail: 1 }), -2)
  assert.equal(candidateHealthScore({ ok: 2, fail: 1 }), 0) // 2 - 2*1
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

