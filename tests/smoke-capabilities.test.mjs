// 冒烟测试：真实 apply(ctx) + 模拟宿主服务，验证 model-capabilities 读写流程
// （含 input 类型与供应商请求头的写回路径；settings.update 的深合并 / mutate 的路径 set/unset
//   语义对齐 dsh-settings 源码实现；写后校验模拟 llm-pi-ai assertServiceable 严格面）
import { apply } from '../lib/index.js'
import assert from 'node:assert/strict'

// ---- 模拟 llm-pi-ai 的 settings 命名空间 ----
// update = 深合并（mergeLayers 语义：数组整体替换）；mutate = 路径 set/unset（applyPathOp 语义）。
function makeLlmPiAiStore(initial) {
  let section = JSON.parse(JSON.stringify(initial))
  const merge = (under, over) => {
    if (over === undefined) return under
    if (under === null || over === null || typeof under !== 'object' || typeof over !== 'object' || Array.isArray(under) || Array.isArray(over)) return over
    const merged = { ...under }
    for (const [k, v] of Object.entries(over)) merged[k] = k in merged ? merge(merged[k], v) : v
    return merged
  }
  const applyOp = (cur, op) => {
    const [head, ...rest] = op.path
    if (head === undefined) return op.op === 'unset' ? {} : { ...op.value }
    if (rest.length === 0) {
      if (op.op === 'set') return { ...cur, [head]: op.value }
      const { [head]: _drop, ...kept } = cur
      return kept
    }
    const child = cur[head]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) {
      if (op.op === 'unset') return cur
      return { ...cur, [head]: applyOp({}, { ...op, path: rest }) }
    }
    return { ...cur, [head]: applyOp(child, { ...op, path: rest }) }
  }
  return {
    get: () => JSON.parse(JSON.stringify(section)),
    update: (patch) => { section = merge(section, patch) },
    mutate: (ops) => { section = ops.reduce(applyOp, section) },
  }
}

// 模拟 llm-pi-ai 写后严格校验（resolveProfiles strict 的行为面）：
// 目录命中项取目录 api/baseUrl；未命中项需自带 api/baseURL，否则拒绝写入。
const CATALOG = {
  'opencode-go': {
    'deepseek-v4-flash': { api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', input: ['text'] },
    'deepseek-v4-pro': { api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', input: ['text'] },
  },
  'zai-coding-cn': {
    'glm-5.3': { api: 'openai-completions', baseUrl: 'https://api.z.ai/api/coding/paas/v4', input: ['text'] },
  },
}
function assertServiceable(section) {
  for (const [pid, p] of Object.entries(section.providers ?? {})) {
    const cat = CATALOG[pid] ?? {}
    for (const m of (p.models ?? [])) {
      const base = cat[m.id]
      if (!base) throw new Error(`llm-pi-ai: model "${m.id}" needs an api; the installed catalog does not describe it`)
      if (m.contextWindow !== undefined && (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0)) throw new Error(`bad contextWindow on ${m.id}`)
      if (m.input !== undefined && !Array.isArray(m.input)) throw new Error(`bad input on ${m.id}`)
    }
  }
}

const initialLlmPiAi = {
  providers: {
    'opencode-go': {
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000 },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 384000 },
      ],
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
    },
    'zai-coding-cn': {
      models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 131072 }],
      apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
    },
  },
}
const store = makeLlmPiAiStore(initialLlmPiAi)

// ---- 模拟 cordis ctx ----
const handlers = {}
const disposers = []
const pluginSections = {} // ns -> { value, source }
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  // settings 服务：installSection（插件自身 ns）+ llm-pi-ai 读写（写后跑严格校验）
  settings: {
    installSection(_owner, ns, _schema, entry, hooks) {
      pluginSections[ns] = { value: entry }
      hooks.setSource(() => pluginSections[ns].value)
      hooks.onChange?.()
      return { get: () => pluginSections[ns].value }
    },
    describe: () => [{ ns: 'llm-pi-ai', user: store.get() }],
    async mutate(_ns, ops) {
      store.mutate(ops)
      assertServiceable(store.get()) // llm-pi-ai onChange 的 assertServiceable
      pluginSections['llm-pi-ai']?.onChange?.()
      return store.get()
    },
    async update(_ns, patch) {
      store.update(patch)
      assertServiceable(store.get())
      return store.get()
    },
  },
  llm: {
    listProviders: () => [{ id: 'opencode-go' }, { id: 'zai-coding-cn' }],
    listConfigurableProviders: () => [
      { provider: 'opencode-go', declared: false },
      { provider: 'zai-coding-cn', declared: true },
    ],
    listModels: async () => [],
    resolveModelInfo: async (provider, model) => {
      const base = (CATALOG[provider] ?? {})[model]
      return { provider, id: model, name: model, inputModalities: base ? [...base.input] : null }
    },
    resolveCallConfig: async () => ({}),
  },
  webServer: { register: (route) => { handlers[route.path] = route.handler } },
  on: () => () => {},
  inject(_groups, cb) { cb({ settings: ctx.settings }) },
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
  },
}

apply(ctx)

// ---- 模拟 req/res ----
function mockReq(method, body) {
  return {
    method,
    url: '/api/model-router/model-capabilities',
    on(ev, cb) { if (ev === 'data' && body) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() },
  }
}
function mockRes() {
  const res = { code: 0, body: null }
  res.writeHead = function (code) { this.code = code }
  res.end = function (body) { this.body = JSON.parse(body); this.done = true }
  return res
}
async function call(method, body) {
  const handler = handlers['/api/model-router/model-capabilities']
  const res = mockRes()
  await handler(mockReq(method, body), res)
  return { code: res.code, body: res.body }
}

// ---- GET：能力 + 请求头 + declared + resolvedInput ----
const get1 = await call('GET')
assert.equal(get1.code, 200)
assert.equal(get1.body.ok, true)
assert.deepEqual(Object.keys(get1.body.capabilities).sort(), ['opencode-go', 'zai-coding-cn'])
assert.deepEqual(get1.body.providerHeaders['opencode-go'], {})
assert.deepEqual(get1.body.declared, ['zai-coding-cn'])
assert.deepEqual(get1.body.resolvedInput['opencode-go/deepseek-v4-flash'], ['text'])
console.log('GET ok: capabilities/providerHeaders/declared/resolvedInput 全部返回')

// ---- POST 模型级 input 写回 ----
const post1 = await call('POST', { provider: 'opencode-go', model: 'deepseek-v4-flash', patch: { input: ['text', 'image'] } })
assert.equal(post1.code, 200, 'input 写回应成功: ' + JSON.stringify(post1.body))
const flash = post1.body.capabilities['opencode-go'].find((m) => m.id === 'deepseek-v4-flash')
assert.deepEqual(flash.input, ['text', 'image'])
console.log('POST input ok:', JSON.stringify(flash.input))

// ---- POST 请求头写回（供应商级，无 model）----
const post2 = await call('POST', { provider: 'opencode-go', patch: { headers: { 'x-opencode-session': 'dsh' } } })
assert.equal(post2.code, 200, 'headers 写回应成功: ' + JSON.stringify(post2.body))
assert.deepEqual(post2.body.providerHeaders['opencode-go'], { 'x-opencode-session': 'dsh' })
console.log('POST headers ok:', JSON.stringify(post2.body.providerHeaders['opencode-go']))

// ---- POST 请求头删除（空 dict → unset）----
const post3 = await call('POST', { provider: 'opencode-go', patch: { headers: {} } })
assert.equal(post3.code, 200)
assert.deepEqual(post3.body.providerHeaders['opencode-go'], {})
console.log('POST headers 清除 ok')

// ---- POST input: null 清除声明 ----
const post4 = await call('POST', { provider: 'opencode-go', model: 'deepseek-v4-flash', patch: { input: null } })
assert.equal(post4.code, 200)
const flash4 = post4.body.capabilities['opencode-go'].find((m) => m.id === 'deepseek-v4-flash')
assert.equal('input' in flash4, false)
console.log('POST input 清除 ok（回退目录）')

// ---- POST 非法 input（video 被宿主 schema 拒绝，插件侧拦截）----
const post5 = await call('POST', { provider: 'opencode-go', model: 'deepseek-v4-flash', patch: { input: ['video'] } })
assert.equal(post5.code, 400)
assert.match(post5.body.error, /text\/image/)
console.log('POST video 拒绝 ok:', post5.body.error)

// ---- POST 非法请求头（换行值）----
const post6 = await call('POST', { provider: 'opencode-go', patch: { headers: { 'x-bad': 'a\nb' } } })
assert.equal(post6.code, 400)
assert.match(post6.body.error, /x-bad/)
console.log('POST 非法头拒绝 ok:', post6.body.error)

// ---- POST 未配置供应商 ----
const post7 = await call('POST', { provider: 'nope', patch: { headers: { 'x-a': '1' } } })
assert.equal(post7.code, 404)
assert.match(post7.body.error, /未配置在宿主/)
console.log('POST 未配置供应商拒绝 ok')

// ---- POST 请求头改回非空（供最终快照展示）----
const post8 = await call('POST', { provider: 'opencode-go', patch: { headers: { 'x-opencode-session': 'dsh-model-router' } } })
assert.equal(post8.code, 200)

// ---- 最终配置快照（校验 apiKeyEnv 等其余字段未被破坏）----
const finalProv = store.get().providers['opencode-go']
assert.deepEqual(finalProv.headers, { 'x-opencode-session': 'dsh-model-router' })
assert.equal(finalProv.apiKeyEnv, 'OPENCODE_GO_API_KEY')
assert.equal(finalProv.models.length, 2)
assert.equal(finalProv.models[0].contextWindow, 1000000)
console.log('最终 opencode-go 配置:', JSON.stringify(finalProv))
console.log('\n全部冒烟断言通过 ✅')
