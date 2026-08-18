#!/usr/bin/env node
/**
 * test-model-reasoning.mjs — 测试 DSH 各 provider/model 是否真的支持思考档位（reasoningEffort）。
 *
 * 原理：复用 DSH 已安装的 @earendil-works/pi-ai，用 createModels + streamSimple 对每个候选
 * 模型发一个「最小真实请求」，依次测多个 reasoning 档位，观察端点是否接受（200/流式正常）
 * 以及返回是否真的带 thinking/reasoning 内容。测的就是 DSH 生产路径会遇到的真实行为。
 *
 * 用法：
 *   node test-model-reasoning.mjs                      # 测 settings.yaml 里所有 provider 的模型
 *   node test-model-reasoning.mjs volcengine-main      # 只测某 provider
 *   node test-model-reasoning.mjs volcengine-main deepseek-v4-flash   # 只测某模型
 *   node test-model-reasoning.mjs --probe-off          # 只测 off（不测思考档位，最快）
 *
 * 输出：每个 (provider/model × effort) 一行：
 *   OK      → 请求成功，且含 thinking/reasoning 内容
 *   NO-THINK→ 请求成功，但无 thinking/reasoning（模型静默关闭思考）
 *   ERR     → 请求失败，附错误码
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { getBuiltinModels, getBuiltinProviders, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SETTINGS = join(DSH_HOME, 'settings.yaml')
const CREDENTIALS = join(DSH_HOME, '.credentials.yaml')

// 测试用的最小请求：一句话 + 要求带思考。maxTokens 足够小以省额度。
const PROBE_SYSTEM = 'You are a careful assistant. When asked, think step by step.'
const PROBE_USER = '3 + 5 = ? Reply with just the number, but think before answering.'
const PROBE_MAX_TOKENS = 512

// 候选思考档位。off 永远先测（基线）；其余按顺序。
const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

// 从 credentials.yaml 解析 { envVar: key }
function loadCredentials() {
  const raw = readFileSync(CREDENTIALS, 'utf8')
  return YAML.parse(raw) ?? {}
}

// 从 settings.yaml 解析 llm-pi-ai.providers
function loadProviders() {
  const raw = readFileSync(SETTINGS, 'utf8')
  const doc = YAML.parse(raw)
  return doc?.['llm-pi-ai']?.providers ?? {}
}

// 复刻 dsh-llm-pi-ai 的 buildProvider：内置 catalog 有该 provider 就复用其模型元数据
// （reasoning / thinkingLevelMap / contextWindow / maxTokens / api），用户配置字段覆盖之；
// 无内置 catalog 的（如 volcengine）则全由配置构造，reasoning 默认 false（除非配了 reasoningEfforts）。
// baseUrl 兜底链与 DSH 一致：配置 baseURL → 内置模型 baseUrl → 内置 provider baseUrl。
function buildProvider(id, spec, apiKey) {
  const builtin = getBuiltinProviders().includes(id) ? getBuiltinModels(id) : undefined
  const providerBaseUrl = getBuiltinProviders().includes(id)
    ? builtinProviders().find((p) => p.id === id)?.baseUrl
    : undefined

  const models = (spec.models ?? []).map((m) => {
    const base = builtin?.find((x) => x.id === m.id)
    const api = spec.api ?? base?.api ?? 'openai-completions'
    return {
      id: m.id,
      name: m.name ?? base?.name ?? m.id,
      api,
      provider: id,
      baseUrl: spec.baseURL ?? base?.baseUrl ?? providerBaseUrl,
      input: m.input ?? base?.input ?? ['text'],
      contextWindow: m.contextWindow ?? base?.contextWindow ?? 262144,
      maxTokens: m.maxTokens ?? base?.maxTokens ?? 32768,
      cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(m.reasoningEfforts !== undefined
        ? { reasoning: true, thinkingLevelMap: m.reasoningEfforts }
        : base?.reasoning
          ? { reasoning: true, thinkingLevelMap: base.thinkingLevelMap }
          : { reasoning: false }),
    }
  })

  const isAnthropic = spec.api === 'anthropic-messages' || models.every((m) => m.api === 'anthropic-messages')
  const api = isAnthropic ? anthropicMessagesApi() : openAICompletionsApi()

  return createProvider({
    id,
    name: spec.displayName ?? id,
    baseUrl: spec.baseURL,
    // 与 DSH 的 harnessApiKeyAuth 一致：provider.auth.apiKey 是 {name, resolve} auth method，
    // pi-ai 的 resolveProviderAuth 会以 overrides.apiKey（即 stream options 里的 apiKey）为 credential 调用它。
    auth: {
      apiKey: {
        name: spec.displayName ?? id,
        resolve: ({ credential }) => Promise.resolve({
          auth: credential?.key === undefined ? {} : { apiKey: credential.key },
          source: id,
        }),
      },
    },
    models,
    api,
  })
}

// 发一次最小流式请求，返回 {ok, error, code, sawThinking}
// 注意：apiKey 必须直接放进 stream options（pi-ai 的 streamSimple 读 options.apiKey，
// 与 DSH 生产路径 profileOptions 一致），provider.auth 是另一条完整 stream 路径。
async function probe(models, model, effort, apiKey) {
  const context = {
    systemPrompt: PROBE_SYSTEM,
    messages: [{ role: 'user', content: PROBE_USER }],
  }
  const options = {
    apiKey,
    maxTokens: PROBE_MAX_TOKENS,
    maxRetries: 0,
    signal: AbortSignal.timeout(30_000), // 每个档位最多 30s，防挂死
    ...(effort === 'off' ? {} : { reasoning: effort }),
  }
  try {
    let sawThinking = false
    let sawText = false
    for await (const event of models.streamSimple(model, context, options)) {
      if (event.type === 'thinking_start' || event.type === 'thinking_delta' || event.type === 'thinking_end') {
        sawThinking = true
      }
      if (event.type === 'text_delta' || event.type === 'text_end') {
        sawText = true
      }
      if (event.type === 'error') throw event.error
    }
    if (!sawText) return { ok: false, error: 'no text output', code: 'EMPTY' }
    return { ok: true, sawThinking }
  } catch (e) {
    const errMsg = (e && (e.message || e.errorMessage)) || String(e)
    const code = (e && (e.code || e.statusCode)) || (/\b4\d\d\b/.test(errMsg) ? 'HTTP4xx' : 'ERR')
    return { ok: false, error: errMsg, code }
  }
}

async function main() {
  const filterProvider = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
  const filterModel = process.argv[3]
  const probeOffOnly = process.argv.includes('--probe-off')

  const providers = loadProviders()
  const credentials = loadCredentials()
  if (Object.keys(providers).length === 0) {
    console.error('未在 settings.yaml 找到 llm-pi-ai.providers')
    process.exit(1)
  }

  const targets = Object.entries(providers)
    .filter(([id]) => !filterProvider || id === filterProvider)

  console.log('模型思考档位实测\n' + '='.repeat(80))
  let total = 0, okCount = 0, noThink = 0, errCount = 0

  for (const [id, spec] of targets) {
    const envName = spec.apiKeyEnv
    const apiKey = credentials[envName]
    if (!apiKey) {
      console.log(`\n⚠ ${id}: 无凭据 ${envName}（跳过）`)
      continue
    }
    let models
    try {
      models = createModels()
      models.setProvider(buildProvider(id, spec, apiKey))
    } catch (e) {
      console.log(`\n⚠ ${id}: provider 构造失败 — ${e.message}`)
      continue
    }

    const modelList = (spec.models ?? [])
      .filter((m) => !filterModel || m.id === filterModel)
    if (modelList.length === 0) {
      console.log(`\n⚠ ${id}: 无模型匹配`)
      continue
    }

    for (const m of modelList) {
      const resolved = models.getModel(id, m.id)
      console.log(`\n${id} / ${m.id}  (declared reasoning=${resolved?.reasoning ?? false}, ctx=${resolved?.contextWindow}, max=${resolved?.maxTokens})`)
      const efforts = probeOffOnly ? ['off'] : EFFORTS
      for (const effort of efforts) {
        total++
        const r = await probe(models, resolved, effort, apiKey)
        const label = r.ok
          ? (r.sawThinking ? 'OK · 有思考' : 'NO-THINK · 无思考内容')
          : `ERR[${r.code}]`
        if (r.ok && r.sawThinking) okCount++
        else if (r.ok) noThink++
        else errCount++
        const detail = r.ok ? '' : `  (${(r.error || '').slice(0, 120)})`
        console.log(`  effort=${effort.padEnd(6)} → ${label}${detail}`)
      }
    }
  }

  console.log('\n' + '='.repeat(80))
  console.log(`汇总: 共 ${total} 次测试 · 有思考 ${okCount} · 成功无思考 ${noThink} · 失败 ${errCount}`)
  console.log('\n说明:')
  console.log('  OK · 有思考    = 端点接受该档位并返回 reasoning/thinking 内容 → 支持')
  console.log('  NO-THINK       = 端点接受但无思考内容 → 可能静默忽略思考参数，视为不支持')
  console.log('  ERR[4xx]       = 端点拒绝该档位 → 不支持（400/404/422 等）')
  console.log('  declared=false = 配置/内置目录未声明 reasoning（如 volcengine），但实测可能仍支持')
}

main().catch((e) => {
  console.error('测试失败:', e)
  process.exit(1)
})
