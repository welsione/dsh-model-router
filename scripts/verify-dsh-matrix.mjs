#!/usr/bin/env node
/**
 * dsh-model-router — 多版本 DSH 自动验证矩阵
 *
 * 对一组 DSH 版本，各起一套一次性环境做两层验证（不碰本机真实 ~/.dsh）：
 *   L4 运行级冒烟：复用 dsh-plugin-developer 的 test.mjs——npm pack → 安装 →
 *      层生效(dump-config) → 启动冒烟(存活≥20s + HTTP 探测 + apply 标记) → 卸载。
 *   L5 API 探测：真实启动宿主（预置 llm-pi-ai 供应商配置），对插件面板 API 做读写验证：
 *      GET state / GET model-capabilities（新字段 providerHeaders/declared/resolvedInput）
 *      / POST 请求头写回 / POST input 写回与 null 删除 / POST video 拒绝，并以
 *      GET 回读校验落盘（settings.yaml 作辅助证据）。
 *
 * 用法:
 *   node scripts/verify-dsh-matrix.mjs [选项]
 *     --versions <a,b>   逗号分隔的 DSH 版本（默认覆盖全部兼容边界，见 DEFAULT_VERSIONS）
 *     --dev-tools <dir>  dsh-plugin-developer 目录（默认 ../dsh-plugin-developer；缺失则跳过 L4）
 *     --timeout <秒>     L5 启动等待上限（默认 120）
 *     --keep             保留各版本的临时目录（排障用）
 *     --json             只输出机器可读 JSON
 * 退出码: 0 = 全部通过；1 = 存在失败；2 = 内部错误。
 *
 * 成本说明：每版本需 npm 安装完整 dsh（约 280MB），默认 5 个版本；npm cache 会去重
 * 相同依赖，首次约 10-20 分钟。CI 可按需 --versions 挑 1-2 个边界版本。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def }
const jsonOnly = args.includes('--json')
const keep = args.includes('--keep')
const l5TimeoutSec = Number(argVal('--timeout', '120') || 120)
const devToolsDir = path.resolve(argVal('--dev-tools', path.resolve(REPO, '..', 'dsh-plugin-developer')))
const VERSIONS = (argVal('--versions', '') || '').split(',').map(s => s.trim()).filter(Boolean)

// 覆盖插件历史上的全部兼容边界 + 最新预览（见文件头注释）。
// 注：0.1.5-rc.3 是坏发布（依赖从未发布的 dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3，
// 任何 registry 都装不上），故 0.1.5 线取 rc.2。
const DEFAULT_VERSIONS = ['0.1.0-rc.8', '0.1.1-rc.2', '0.1.2-rc.1', '0.1.5-rc.2', '0.1.7-alpha.1']
const versions = VERSIONS.length > 0 ? VERSIONS : DEFAULT_VERSIONS
const ROOT = path.join(os.tmpdir(), `dsh-verify-matrix-${process.pid}-${Date.now()}`)
const npmCache = path.join(ROOT, '.npmcache')
const port = 42000 + Math.floor(Math.random() * 20000) // 42000-61999，避开 3080 与常用段

const results = [] // { version, layer: 'L4'|'L5'|'env', id, passed, detail, evidence }
const add = (version, layer, id, passed, detail, evidence) => results.push({ version, layer, id, passed: !!passed, detail, evidence: evidence ?? null })

const log = (...m) => { if (!jsonOnly) console.log(...m) }

function sh(cmd, cargs, opts = {}) {
  const r = spawnSync(cmd, cargs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  if (r.error) return { ok: false, status: -1, stdout: '', stderr: String(r.error.message) }
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}
const tail = (s, n = 12) => (s || '').trim().split(/\r?\n/).slice(-n).join('\n')

function waitForPort(portNo, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const step = () => {
      if (Date.now() > deadline) return resolve(false)
      const req = http.get({ host: '127.0.0.1', port: portNo, path: '/', timeout: 1500 }, (r) => { r.resume(); resolve(true) })
      req.on('timeout', () => { req.destroy(); setTimeout(step, 800) })
      req.on('error', () => setTimeout(step, 800))
    }
    step()
  })
}
const api = (base, p, method = 'GET', body) => {
  const u = new URL(base)
  u.pathname = p // 保留 query（如 ?token=…），仅替换路径
  return fetch(u, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
}

const waitForExit = (child, ms) => new Promise((res) => {
  const t = setTimeout(() => res({ timedOut: true }), ms)
  child.once('exit', (code, sig) => { clearTimeout(t); res({ timedOut: false, code, sig }) })
})
const tryKill = (child) => { try { if (child && child.exitCode === null) child.kill('SIGTERM') } catch { /* ignore */ } }

/** 预置 llm-pi-ai 供应商（无凭据也能完成能力写回验证：解析/校验均不触网） */
function seedSettingsYaml(home) {
  mkdirSync(home, { recursive: true })
  const doc = {
    'llm-pi-ai': {
      providers: {
        'opencode-go': {
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000 }],
          apiKeyEnv: 'OPENCODE_GO_API_KEY',
        },
      },
    },
  }
  writeFileSync(path.join(home, 'settings.yaml'), YAML.stringify(doc))
}
function readSettingsYaml(home) {
  try { return YAML.parse(readFileSync(path.join(home, 'settings.yaml'), 'utf8')) } catch { return null }
}

/* ---------------- L4：复用 dsh-plugin-developer 运行级测试 ---------------- */
function runL4(version, dshBin, tarball) {
  const script = path.join(devToolsDir, 'scripts', 'test.mjs')
  if (!existsSync(script)) {
    add(version, 'L4', 'skipped', false, `未找到 ${script}（--dev-tools 指定或 git clone dsh-plugin-developer）`)
    return
  }
  const r = sh('node', [script, tarball, '--dsh', dshBin, '--json', '--expect-marker', 'plugin ready', '--timeout', '20'], { timeout: 300000 })
  let report = null
  try { report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) } catch { /* 输出污染时兜底 */ }
  if (!report || !Array.isArray(report.checks)) {
    add(version, 'L4', 'run', false, `test.mjs 无有效 JSON 输出（exit=${r.status}）`, tail(r.stderr || r.stdout))
    return
  }
  const checks = report.checks
  const errors = checks.filter(c => c.level === 'error' && !c.passed)
  const warns = checks.filter(c => c.level === 'warn' && !c.passed)
  add(version, 'L4', 'run', errors.length === 0,
    `verdict=${report.verdict} · checks=${checks.length} · error=${errors.length} warn=${warns.length}`,
    errors.concat(warns).map(c => `${c.id}: ${c.detail}`).join('\n') || null)
}

/* ---------------- L5：真实启动宿主 + 面板 API 读写矩阵 ---------------- */
async function runL5(version, dshBin, tarball, root) {
  const home = path.join(root, 'home')
  const profile = 'web'
  seedSettingsYaml(home)
  const env = { ...process.env, DSH_HOME: home, npm_config_cache: npmCache }

  // 安装插件 tarball（与 L4 同一产物）
  const inst = sh(dshBin, ['plugin', '--profile', profile, 'add', tarball], { env, timeout: 180000 })
  if (!inst.ok) {
    add(version, 'L5', 'install', false, `插件安装失败: ${tail(inst.stderr || inst.stdout)}`)
    return
  }

  // 启动宿主
  const outLog = path.join(root, 'boot.stdout.log')
  const errLog = path.join(root, 'boot.stderr.log')
  let stdoutBuf = '', stderrBuf = ''
  const child = spawn(dshBin, ['--profile', profile, '--port', String(port), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', d => { stdoutBuf += d; try { writeFileSync(outLog, stdoutBuf) } catch { /* ignore */ } })
  child.stderr.on('data', d => { stderrBuf += d; try { writeFileSync(errLog, stderrBuf) } catch { /* ignore */ } })
  const up = await waitForPort(port, l5TimeoutSec * 1000)
  // 启动日志里的访问 URL（新版宿主带 token：http://127.0.0.1:PORT/?token=…；
  // token 在 query 上，API 调用需以「路径 + 原 query」拼接，不能直接在 URL 后接路径）
  const urlMatch = stdoutBuf.match(/https?:\/\/[^\s"']+/)
  let baseUrl = null
  if (up) {
    try {
      const u = new URL(urlMatch || `http://127.0.0.1:${port}/`)
      u.pathname = '/'
      u.hash = ''
      baseUrl = u.toString()
    } catch { baseUrl = `http://127.0.0.1:${port}/` }
  }
  add(version, 'L5', 'boot.http', up && !!baseUrl,
    up ? `HTTP 可达@${port}${urlMatch && new URL(urlMatch).searchParams.get('token') ? '（含 token，API 探测透传）' : ''}` : `启动 ${l5TimeoutSec}s 内不可达`,
    up ? null : tail(stderrBuf || stdoutBuf))

  if (!up || !baseUrl) { tryKill(child); return }

  const p = (s) => JSON.stringify(s)
  try {
    // 1. GET state
    const st = await api(baseUrl, '/api/model-router/state')
    add(version, 'L5', 'state', st.status === 200 && st.body?.ok === true,
      st.status === 200 ? `ok=true，routes=${Object.keys(st.body?.config?.routes ?? {}).length}` : `HTTP ${st.status}`)

    // 2. GET model-capabilities：新字段齐全（providerHeaders/declared/resolvedInput）
    const caps0 = await api(baseUrl, '/api/model-router/model-capabilities')
    const newFields = caps0.body && ['capabilities', 'providerHeaders', 'declared', 'resolvedInput'].every(k => k in caps0.body)
    add(version, 'L5', 'caps.get', caps0.status === 200 && caps0.body?.ok === true && newFields,
      caps0.status === 200
        ? `新字段${newFields ? '齐全' : '缺失:' + ['capabilities', 'providerHeaders', 'declared', 'resolvedInput'].filter(k => !(k in caps0.body))}；capabilities=${p(Object.keys(caps0.body?.capabilities ?? {}))}；resolvedInput[opencode-go/deepseek-v4-flash]=${p(caps0.body?.resolvedInput?.['opencode-go/deepseek-v4-flash'])}`
        : `HTTP ${caps0.status}`)

    // 3. POST 请求头写回（MissingSessionID 场景）+ GET 回读 + settings.yaml 落盘证据
    const hv = `verify-${version.replace(/[^\w.-]/g, '-')}`
    const h1 = await api(baseUrl, '/api/model-router/model-capabilities', 'POST', { provider: 'opencode-go', patch: { headers: { 'x-opencode-session': hv } } })
    const caps1 = await api(baseUrl, '/api/model-router/model-capabilities')
    const hdrOk = h1.status === 200 && caps1.body?.providerHeaders?.['opencode-go']?.['x-opencode-session'] === hv
    const yaml1 = readSettingsYaml(home)?.['llm-pi-ai']?.providers?.['opencode-go']?.headers?.['x-opencode-session']
    add(version, 'L5', 'caps.headers', hdrOk, `POST=${h1.status}，GET 回读=${p(caps1.body?.providerHeaders?.['opencode-go'])}${yaml1 ? `，settings.yaml 落盘=${p(yaml1)}` : '（settings.yaml 证据未取到，以回读为准）'}`)

    // 4. POST input 写回 + null 删除
    const i1 = await api(baseUrl, '/api/model-router/model-capabilities', 'POST', { provider: 'opencode-go', model: 'deepseek-v4-flash', patch: { input: ['text', 'image'] } })
    const afterSet = i1.body?.capabilities?.['opencode-go']?.find(m => m.id === 'deepseek-v4-flash')?.input
    const i2 = await api(baseUrl, '/api/model-router/model-capabilities', 'POST', { provider: 'opencode-go', model: 'deepseek-v4-flash', patch: { input: null } })
    const modelAfter = i2.body?.capabilities?.['opencode-go']?.find(m => m.id === 'deepseek-v4-flash')
    const yamlInput = readSettingsYaml(home)?.['llm-pi-ai']?.providers?.['opencode-go']?.models?.find(m => m.id === 'deepseek-v4-flash')?.input
    add(version, 'L5', 'caps.input', i1.status === 200 && Array.isArray(afterSet) && afterSet.join() === 'text,image' && i2.status === 200 && modelAfter && !('input' in modelAfter),
      `写入=${p(afterSet)}，null 删除后=${modelAfter ? (modelAfter.input === undefined ? '字段已删除' : p(modelAfter.input)) : '模型缺失'}${yamlInput !== undefined ? `，yaml=${p(yamlInput)}` : ''}`)

    // 5. POST video 拒绝（宿主 MODALITIES 仅 text/image）
    const v1 = await api(baseUrl, '/api/model-router/model-capabilities', 'POST', { provider: 'opencode-go', model: 'deepseek-v4-flash', patch: { input: ['video'] } })
    add(version, 'L5', 'caps.video_rejected', v1.status === 400, `HTTP ${v1.status}，error=${p(v1.body?.error)}`)

    // 6. 其余字段不破坏：headers 写回后 apiKeyEnv/models 仍在（settings.yaml 证据 + GET 回读）
    const prov = caps1.body?.capabilities?.['opencode-go']
    const yamlProv = readSettingsYaml(home)?.['llm-pi-ai']?.providers?.['opencode-go']
    add(version, 'L5', 'caps.no_side_effect',
      Array.isArray(prov) && prov.length === 1 && Array.isArray(yamlProv?.models) && yamlProv.models.length === 1 && yamlProv.apiKeyEnv === 'OPENCODE_GO_API_KEY',
      `GET capabilities=${p(prov?.length)} 个模型；yaml models=${p(yamlProv?.models?.length)}，apiKeyEnv=${p(yamlProv?.apiKeyEnv)}`)
  } catch (e) {
    add(version, 'L5', 'probe', false, `探测异常: ${String(e && e.message || e)}`)
  } finally {
    // apply 标记：所有 API 探测完成后检查（端口刚通时 stdout 可能尚未刷出该行）
    add(version, 'L5', 'boot.marker', stdoutBuf.includes('plugin ready'),
      stdoutBuf.includes('plugin ready') ? 'apply 已真实执行（启动标记出现）' : '未见 apply 启动标记')
    tryKill(child)
    await waitForExit(child, 5000)
    if (child.exitCode === null) try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  mkdirSync(npmCache, { recursive: true })
  const packDir = path.join(ROOT, 'pack')
  mkdirSync(packDir, { recursive: true })
  log(`dsh-model-router 多版本验证矩阵\n版本: ${versions.join(', ')}\n根目录: ${ROOT}\n`)

  // 产物只 pack 一次：npm pack（触发 prepack = npm test，失败即中止）
  const pk = sh('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: REPO, env: { ...process.env, npm_config_cache: npmCache } })
  const tgzList = pk.ok ? readdirSync(packDir).filter(f => f.endsWith('.tgz')) : []
  if (!pk.ok || tgzList.length === 0) {
    console.error('npm pack 失败（prepack 含 npm test）:', tail(pk.stderr || pk.stdout))
    return 2
  }
  const tarball = path.join(packDir, tgzList[0])
  log(`插件 tarball: ${tgzList[0]}\n`)

  for (const v of versions) {
    const root = path.join(ROOT, v)
    mkdirSync(root, { recursive: true })
    log(`\n════ DSH ${v} ════`)
    // 安装该版本 dsh（npm cache 去重依赖）。
    // 0.1.5-rc.2/rc.3 有解析死局：dsh@^0.1.5-rc.2 会解析到 dsh-web-app@0.1.5-rc.3，
    // 而后者依赖从未发布的 documentpreview@^0.1.5-rc.3 → ETARGET。用 overrides 把
    // documentpreview 钉在 rc.2 即可解开（已实测 rc.2 可完整安装启动）。
    const pkgDir = path.join(root, 'dsh-pkg')
    mkdirSync(pkgDir, { recursive: true })
    const wantsOverride = /^0\.1\.5-(rc\.[23]|)$/.test(v)
    const pkgJson = wantsOverride
      ? { name: 'dsh-verify-host', version: '1.0.0', private: true, dependencies: { '@deepseek-ai/dsh': v }, overrides: { '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': '0.1.5-rc.2' } }
      : { name: 'dsh-verify-host', version: '1.0.0', private: true, dependencies: { '@deepseek-ai/dsh': v } }
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2))
    const ins = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'],
      { cwd: pkgDir, timeout: 900000, env: { ...process.env, npm_config_cache: npmCache } })
    const dshBin = path.join(pkgDir, 'node_modules', '.bin', 'dsh')
    if (!ins.ok || !existsSync(dshBin)) {
      add(v, 'env', 'install', false, `npm install @deepseek-ai/dsh@${v} 失败: ${tail(ins.stderr || ins.stdout, 8)}`)
      continue
    }
    const ver = sh(dshBin, ['--version'], { timeout: 60000 })
    add(v, 'env', 'install', true, `dsh --version → ${ver.stdout.trim() || '?'}${wantsOverride ? '（overrides 钉 documentpreview@rc.2）' : ''}`)
    runL4(v, dshBin, tarball)
    await runL5(v, dshBin, tarball, root)
    if (!keep) { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } }
  }

  // ---- 汇总 ----
  const failed = results.filter(r => !r.passed)
  const report = {
    generatedAt: new Date().toISOString(),
    versions,
    plugin: JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    results,
  }
  const reportPath = path.join(ROOT, 'verify-matrix.report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    log('\n════════ 验证矩阵汇总 ════════')
    log('版本'.padEnd(16), '层'.padEnd(4), '结果', '说明')
    for (const r of results) {
      log(r.version.padEnd(16), r.layer.padEnd(4), r.passed ? '✅' : '❌', (r.detail || '').split('\n')[0].slice(0, 100))
    }
    log(`\n结论: ${report.verdict}（${results.filter(r => r.passed).length}/${results.length} 项通过）`)
    log(`报告: ${reportPath}`)
    if (!keep) log(`临时目录已清理（--keep 可保留）`)
    else log(`临时目录保留: ${ROOT}`)
  }
  return failed.length === 0 ? 0 : 1
}

main().then(code => process.exit(code)).catch((e) => { console.error('内部错误:', e); process.exit(2) })
