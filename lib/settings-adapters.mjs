// dsh-model-router — 宿主 settings 接入适配器（策略模式）
//
// DSH 不同世代接入 settings 的机制不同，本模块把它们归一为统一接口：
//
//   adapter = {
//     id:     string                 — 世代标识（日志/诊断用）
//     match:  (ctx) => boolean       — 能力探测：该宿主是否适用此适配器
//     setup:  (ctx, opts) => void    — 执行接入（注册/订阅）
//   }
//
// opts = {
//   ns, schema, plainSchema,
//   config,      — apply(ctx, config) 的第二参（0.1.7+ 为 ref-store，旧宿主为普通对象/缺省）
//   currentRef,  — 可变容器 { fn: () => section }；适配器安装自己的读取实现
//   onChange,    — 配置变更回调（每代机制的变更通知在此归一）
//   log,         — ctx.logger
// }
//
// 业务代码只面向 currentRef.fn()，不感知宿主世代。
//
// 注册顺序 = 探测顺序：从新到旧，第一个 match 的适配器胜出。
// 注意 freeFn 必须最后：dsh-settings <=0.1.5 的遗留 shim（installSettingsSection）
// 在 0.1.5 宿主上也存在，若排前会遮蔽 installSection 适配器。

import * as dshSettings from '@deepseek-ai/dsh-settings'

/** 0.1.7+ 的 config store：volatile 字段是 ref（{get}）；旧宿主第二参是普通对象/缺省。 */
export const isRefStore = (config) => {
  try {
    return !!config && typeof config === 'object' && typeof config.enabled?.get === 'function'
  } catch { return false }
}

const CONFIG_FIELDS = [
  'enabled', 'cooldownMs', 'cooldownMaxMs', 'cooldownBackoff', 'maxSwitchesPerStep',
  'retryOnThrottle', 'maxRetriesPerCandidate', 'retryBackoffMs', 'healthRanking',
  'healthWindowSize', 'reasoningEffortsFallback', 'contextAware', 'contextMargin',
  'contextReserveTokens', 'routes', 'manualTiers',
]

/** ref-store → 普通 section（解引用每个 volatile ref）。 */
export const readRefStore = (config) => {
  const out = {}
  for (const field of CONFIG_FIELDS) {
    const ref = config[field]
    out[field] = typeof ref?.get === 'function' ? ref.get() : ref
  }
  return out
}

/** 宿主 settings 服务的形态描述（日志/诊断用）。 */
export const describeSettingsSvc = (ctx) => {
  const s = ctx.settings
  return `settings service: installSection=${typeof s?.installSection === 'function'}, configure=${typeof s?.configure === 'function'}`
}

// ------------------------------------------------------------------
// 0.1.7+：settings 表单机制（SettingsForms）
// 宿主自动读取插件的 Config 命名导出（volatile 字段热更新）；本适配器
// 不注册任何 section，只负责：读 ref-store + 声明不自动生成设置页 +
// 订阅 volatile 更新事件。
// ------------------------------------------------------------------
const formsAdapter = {
  id: 'settings-forms (DSH 0.1.7+)',
  match: (ctx) => {
    const s = ctx.settings
    return typeof s?.configure === 'function' && typeof s?.installSection !== 'function'
  },
  setup: (ctx, opts) => {
    opts.currentRef.fn = () => (isRefStore(opts.config) ? readRefStore(opts.config) : opts.plainSchema())
    // 声明「不自动生成设置页」：面板由本插件经 client slots 注入，避免双页。
    ctx.inject(['settings'], (child) => {
      child.effect(() => {
        try { child.settings?.configure?.({ auto: false }, ctx.fiber) } catch (e) {
          ctx.logger.debug?.('dsh-model-router: settings presentation 配置失败: ' + String((e && e.message) || e))
        }
      })
    })
    ctx.on('loader/volatile-update', () => opts.onChange())
  },
}

// ------------------------------------------------------------------
// 0.1.2～0.1.5：SettingsProvider.installSection 方法
// ------------------------------------------------------------------
const installSectionAdapter = {
  id: 'installSection (DSH 0.1.2~0.1.5)',
  match: (ctx) => typeof ctx.settings?.installSection === 'function',
  setup: (ctx, opts) => {
    ctx.settings.installSection(ctx, opts.ns, opts.plainSchema, opts.plainSchema(), {
      setSource(source) { opts.currentRef.fn = source },
      onChange: opts.onChange,
    })
  },
}

// ------------------------------------------------------------------
// <=0.1.1：installSettingsSection 自由函数（遗留 shim，必须最后探测）
// ------------------------------------------------------------------
const freeFnAdapter = {
  id: 'installSettingsSection (DSH <=0.1.1)',
  match: () => typeof dshSettings.installSettingsSection === 'function',
  setup: (ctx, opts) => {
    dshSettings.installSettingsSection(ctx, opts.ns, opts.plainSchema, opts.plainSchema(), {
      setSource(source) { opts.currentRef.fn = source },
      onChange: opts.onChange,
    })
  },
}

/** 适配器注册表：顺序 = 探测优先级（从新到旧）。 */
export const SETTINGS_ADAPTERS = [formsAdapter, installSectionAdapter, freeFnAdapter]

/** 按注册顺序探测并返回命中的适配器；全部未命中时抛错（未知宿主形态）。 */
export const resolveSettingsAdapter = (ctx, log) => {
  for (const adapter of SETTINGS_ADAPTERS) {
    try {
      if (adapter.match(ctx)) return adapter
    } catch (e) {
      log?.warn?.(`dsh-model-router: 适配器 ${adapter.id} 探测异常: ${String((e && e.message) || e)}`)
    }
  }
  throw new Error(`dsh-model-router: 未找到适配的 settings 接入方式（${describeSettingsSvc(ctx)}）`)
}
