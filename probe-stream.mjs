#!/usr/bin/env node
/**
 * probe-stream.mjs — 复现 dsh-model-router 的流式包裹路径，观察思考内容是否漏进正文。
 *
 * 流程（与宿主 dsh-llm-pi-ai + 插件 routeThrough 一致）：
 *   1. 从 settings.yaml 构建目标 provider（kimi-coding / opencode-go / volcengine-mian）；
 *   2. 用 pi-ai streamSimple 拿原生事件（text_delta / thinking_delta / …）；
 *   3. 按宿主映射成 DSH chunk（text_delta→text-delta、thinking_delta→reasoning-delta、
 *      thinking_start/end→block-start/block-end reasoning）；
 *   4. 套插件 routeThrough 的逐 chunk 变换：stripThinking 作用于 text-delta 与 reasoning-delta；
 *   5. 打印变换后的流，确认思考内容最终落在哪个 chunk 类型。
 *
 * 用法： node probe-stream.mjs <provider> <model> [effort]
 * 例：   node probe-stream.mjs kimi-coding k3 max
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { getBuiltinModels, getBuiltinProviders, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

// ---- 复刻插件 lib/core.mjs 的 makeThinkingTagStripper（原样） ----
function makeThinkingTagStripper() {
  let carry = ''
  const TAG_RE = /<\/?(?:thinking|think|reasoning|response|answer|output|final|result|antml:(?:thinking|invoke|parameter|result|output|reasoning))(?:\s[^>]*)?>/gi
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

// ---- provider 构建（与 dsh-llm-pi-ai / test-model-reasoning.mjs 一致） ----
function loadCredentials() {
  const raw = readFileSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8')
  return YAML.parse(raw) ?? {}
}
function loadSettings() {
  const raw = readFileSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'settings.yaml'), 'utf8')
  return YAML.parse(raw)
}
function buildProvider(id, spec, apiKey) {
  const builtin = getBuiltinProviders().includes(id) ? getBuiltinModels(id) : undefined
  const providerBaseUrl = getBuiltinProviders().includes(id)
    ? builtinProviders().find((p) => p.id === id)?.baseUrl
    : undefined
  const models = (spec.models ?? []).map((m) => {
    const base = builtin?.find((x) => x.id === m.id)
    const api = spec.api ?? base?.api ?? 'openai-completions'
    return {
      id: m.id, name: m.name ?? base?.name ?? m.id, api, provider: id,
      baseUrl: spec.baseURL ?? base?.baseUrl ?? providerBaseUrl,
      input: m.input ?? base?.input ?? ['text'],
      contextWindow: m.contextWindow ?? base?.contextWindow ?? 262144,
      maxTokens: m.maxTokens ?? base?.maxTokens ?? 32768,
      cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(m.reasoningEfforts !== undefined
        ? { reasoning: true, thinkingLevelMap: m.reasoningEfforts }
        : base?.reasoning ? { reasoning: true, thinkingLevelMap: base.thinkingLevelMap } : { reasoning: false }),
    }
  })
  const isAnthropic = spec.api === 'anthropic-messages' || models.every((m) => m.api === 'anthropic-messages')
  const api = isAnthropic ? anthropicMessagesApi() : openAICompletionsApi()
  return createProvider({
    id, name: spec.displayName ?? id, baseUrl: spec.baseURL,
    auth: { apiKey: { name: spec.displayName ?? id, resolve: ({ credential }) => Promise.resolve({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: id }) } },
    models, api,
  })
}

const [providerId, modelId, effort] = process.argv.slice(2)
if (!providerId || !modelId) { console.error('usage: node probe-stream.mjs <provider> <model> [effort]'); process.exit(1) }

const settings = loadSettings()
const spec = settings['llm-pi-ai']?.providers?.[providerId]
if (!spec) { console.error(`provider ${providerId} not in settings`); process.exit(1) }
const creds = loadCredentials()
const apiKey = spec.apiKeyEnv === undefined ? undefined : creds[spec.apiKeyEnv]
if (!apiKey) { console.error(`no credential for ${spec.apiKeyEnv}`); process.exit(1) }

const models = createModels()
models.setProvider(buildProvider(providerId, spec, apiKey))
const resolved = models.getModel(providerId, modelId)
if (!resolved) { console.error(`model ${modelId} not found`); process.exit(1) }
console.log(`provider=${providerId} model=${modelId} reasoning=${resolved.reasoning} effort=${effort || '(default)'}\n`)

// ---- 1. 原生 pi-ai 事件流 ----
const context = {
  systemPrompt: 'You are a careful assistant. When asked, think step by step.',
  messages: [{ role: 'user', content: '3 + 5 = ? Reply with just the number, but think before answering.' }],
}
const options = {
  apiKey,
  maxTokens: 400,
  maxRetries: 0,
  signal: AbortSignal.timeout(30_000),
  ...(effort !== undefined && effort !== 'off' ? { reasoning: effort } : {}),
}

const native = []
try {
  for await (const ev of models.streamSimple(resolved, context, options)) native.push(ev)
} catch (e) {
  console.error('streamSimple error:', e?.message ?? e, e?.code ?? '')
  process.exit(1)
}

console.log('== 原生 pi-ai 事件（前 200 字符截断）==')
const typeCount = {}
for (const ev of native) {
  typeCount[ev.type] = (typeCount[ev.type] || 0) + 1
  const txt = ev.type === 'text_delta' || ev.type === 'thinking_delta' ? JSON.stringify((ev.delta ?? '').slice(0, 60)) : ''
  if (txt) console.log(`  [${ev.type}] ${txt}${((ev.delta ?? '').length > 60 ? '…' : '')}`)
  else console.log(`  [${ev.type}]`)
}
console.log('事件统计:', JSON.stringify(typeCount))

// ---- 2. 映射为 DSH chunk（宿主 dsh-llm-pi-ai 的转换） ----
const chunks = []
let thinkingIndex = 0, textIndex = 0
for (const ev of native) {
  switch (ev.type) {
    case 'thinking_start': chunks.push({ type: 'block-start', index: thinkingIndex, blockType: 'reasoning' }); break
    case 'thinking_delta': chunks.push({ type: 'reasoning-delta', index: thinkingIndex, text: ev.delta }); break
    case 'thinking_end': chunks.push({ type: 'block-end', index: thinkingIndex, block: { type: 'reasoning', text: ev.content } }); break
    case 'text_delta': chunks.push({ type: 'text-delta', index: textIndex, text: ev.delta }); break
    case 'text_end': chunks.push({ type: 'block-end', index: textIndex, block: { type: 'text', text: ev.content } }); break
    case 'finish': chunks.push({ type: 'finish', reason: ev.reason ?? {} }); break
    case 'error': chunks.push({ type: 'finish', reason: { kind: 'error', failure: ev.error } }); break
    default: chunks.push({ type: ev.type })
  }
}

// ---- 3. 插件 routeThrough 变换（stripThinking 作用于 text-delta / reasoning-delta） ----
console.log('\n== 插件变换后 chunk 流 ==')
const strip = makeThinkingTagStripper()
let reasoningLen = 0, textLen = 0, strippedN = 0, changed = []
for (const c of chunks) {
  if ((c.type === 'text-delta' || c.type === 'reasoning-delta') && typeof c.text === 'string') {
    const before = c.text
    const cleaned = strip(c.text)
    if (cleaned !== before) {
      strippedN++
      changed.push({ type: c.type, before: before.slice(0, 60), after: cleaned.slice(0, 60) })
    }
    if (c.type === 'reasoning-delta') reasoningLen += cleaned.length
    else textLen += cleaned.length
  }
}
console.log(`reasoning-delta 总字符=${reasoningLen} · text-delta 总字符=${textLen} · 被改写 chunk 数=${strippedN}`)
for (const x of changed) console.log(`  改写 [${x.type}]: ${JSON.stringify(x.before)} → ${JSON.stringify(x.after)}`)

console.log('\n== 判定 ==')
if (reasoningLen > 0) console.log('✔ 思考内容全程在 reasoning-delta（宿主渲染为思考块），未进入正文')
else console.log('✘ 没拿到 thinking_delta —— 该 provider 可能把思考以文本形式输出（需看 text-delta 内容）')
if (strippedN > 0) console.log('⚠ stripThinking 改写了流，检查上面改写是否把思考文字泄漏进 text-delta')