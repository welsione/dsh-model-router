// dsh-model-router — 客户端：设置页「模型路由」管理面板
// 经 window.__ModuleLoader__.load 注册（package.json 声明 dsh.client）。
// 与宿主通信（同源 fetch）：
//   GET  /api/model-router/state
//   POST /api/model-router/save
//   POST /api/model-router/cooldowns/clear
window.__ModuleLoader__.load({
  id: 'dsh-model-router',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    function api(path, body) {
      return fetch(path, body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (res) { return res.json().catch(function () { return null }) })
        .then(function (payload) {
          if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || 'request failed')
          return payload
        })
    }

    var EMPTY_CONFIG = { enabled: true, cooldownMs: 300000, maxSwitchesPerStep: 3, routes: {} }

    function Panel() {
      var s1 = React.useState(true);  var loading = s1[0]; var setLoading = s1[1]
      var s2 = React.useState(null);  var loadError = s2[0]; var setLoadError = s2[1]
      var s3 = React.useState(null);  var data = s3[0]; var setData = s3[1]
      var s4 = React.useState(null);  var cfg = s4[0]; var setCfg = s4[1]
      var s5 = React.useState(null);  var notice = s5[0]; var setNotice = s5[1]
      var s6 = React.useState(false); var saving = s6[0]; var setSaving = s6[1]
      var s7 = React.useState('');    var newId = s7[0]; var setNewId = s7[1]
      var s8 = React.useState(0);     var tick = s8[0]; var setTick = s8[1]
      // 最近事件：默认折叠，展开后只展示最近 10 条
      var s10 = React.useState(false); var historyOpen = s10[0]; var setHistoryOpen = s10[1]
      // 模型能力（写回宿主 llm-pi-ai）：capabilities = { provider: [models] }，writable 标识是否可写
      var s11 = React.useState(null); var capabilities = s11[0]; var setCapabilities = s11[1]
      var s12 = React.useState(false); var capsWritable = s12[0]; var setCapsWritable = s12[1]
      var s13 = React.useState(false); var capsOpen = s13[0]; var setCapsOpen = s13[1]
      // 每行编辑草稿：key = `provider/model` → {contextWindow, maxTokens, reasoningEfforts}
      var s14 = React.useState({}); var capsDraft = s14[0]; var setCapsDraft = s14[1]
      var s15 = React.useState(null); var capsSavingKey = s15[0]; var setCapsSavingKey = s15[1]
      // 未保存候选的惰性档位查询：extraEfforts = { key: [{id,name,verified}] }，fetchingKeys 去重
      var s16 = React.useState({}); var extraEfforts = s16[0]; var setExtraEfforts = s16[1]
      var s17 = React.useState({}); var fetchingEfforts = s17[0]; var setFetchingEfforts = s17[1]
      // 思考级别选择器弹层：openPick = { key: bool }
      var s18 = React.useState({}); var openPick = s18[0]; var setOpenPick = s18[1]

      var loadCapabilities = React.useCallback(function () {
        api('/api/model-router/model-capabilities').then(function (res) {
          setCapabilities(res.capabilities || {})
          setCapsWritable(!!res.writable)
        }).catch(function () {
          setCapabilities({})
          setCapsWritable(false)
        })
      }, [])
      React.useEffect(function () { loadCapabilities() }, [loadCapabilities])

      var load = React.useCallback(function () {
        setLoading(true); setLoadError(null)
        api('/api/model-router/state').then(function (res) {
          setData(res)
          setCfg({ enabled: res.config.enabled, cooldownMs: res.config.cooldownMs,
                   maxSwitchesPerStep: res.config.maxSwitchesPerStep,
                   healthRanking: res.config.healthRanking,
                   healthWindowSize: res.config.healthWindowSize,
                   routes: JSON.parse(JSON.stringify(res.config.routes)) })
          setLoading(false)
        }).catch(function (e) {
          setLoadError(String((e && e.message) || e)); setLoading(false)
        })
      }, [])
      React.useEffect(function () { load() }, [load])
      React.useEffect(function () {
        var t = setInterval(function () { setTick(Date.now()) }, 1000)
        return function () { clearInterval(t) }
      }, [])

      // 思考级别选择器弹层：点击外部 / Escape 关闭（web-design-guidelines: 弹层需可关闭）
      React.useEffect(function () {
        if (!Object.keys(openPick || {}).some(function (k) { return openPick[k] })) return
        var onDown = function (e) {
          // 点击不在 pickwrap 内（未命中 .dsh-mr-caps-pickwrap 或其内部）则全部关闭
          if (e.target && !e.target.closest('.dsh-mr-caps-pickwrap')) {
            setOpenPick({})
          }
        }
        var onKey = function (e) {
          if (e.key === 'Escape') setOpenPick({})
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [openPick])

      var save = function () {
        if (!cfg) return
        setSaving(true); setNotice(null)
        api('/api/model-router/save', cfg).then(function (res) {
          setCfg({ enabled: res.config.enabled, cooldownMs: res.config.cooldownMs,
                   maxSwitchesPerStep: res.config.maxSwitchesPerStep,
                   healthRanking: res.config.healthRanking,
                   healthWindowSize: res.config.healthWindowSize,
                   routes: JSON.parse(JSON.stringify(res.config.routes)) })
          setNotice('已保存并即时生效')
          return load()
        }).catch(function (e) {
          var msg = String((e && e.message) || e)
          if (/思考级别|reasoningEffort|reasoning/i.test(msg) && !/换一个档位|换一个/.test(msg)) {
            msg += '。可在候选的思考级别下拉里换一个档位，或留空使用默认。'
          }
          setNotice('保存失败：' + msg)
        }).finally(function () { setSaving(false) })
      }

      var clearCooldowns = function () {
        api('/api/model-router/cooldowns/clear').then(function () { return load() })
          .catch(function (e) { setNotice('清除失败：' + String((e && e.message) || e)) })
      }

      // 模型能力：保存某 provider/model 的能力草稿（写回宿主 llm-pi-ai，热重载生效）
      var saveCapability = function (provider, model) {
        var key = provider + '/' + model
        // 兜底：若草稿未初始化（未编辑过），基于当前值构建；空补丁则忽略
        var patch = capsDraft[key] || capsInitDraft(provider, model)
        var clean = {}
        if (patch.contextWindow !== undefined && patch.contextWindow !== '') clean.contextWindow = Number(patch.contextWindow)
        if (patch.maxTokens !== undefined && patch.maxTokens !== '') clean.maxTokens = Number(patch.maxTokens)
        if (patch.reasoningEfforts && typeof patch.reasoningEfforts === 'object') clean.reasoningEfforts = patch.reasoningEfforts
        if (Object.keys(clean).length === 0) return
        setCapsSavingKey(key); setNotice(null)
        api('/api/model-router/model-capabilities', { provider: provider, model: model, patch: clean })
          .then(function (res) {
            setNotice('已写回宿主模型能力 ' + key + '（热重载生效）')
            setCapabilities(res.capabilities || {})
            // 失效该候选的惰性档位缓存，路由思考级别下拉下次重新查询真实能力
            setExtraEfforts(function (x) { var n = Object.assign({}, x); delete n[key]; return n })
            setFetchingEfforts(function (f) { var n = Object.assign({}, f); delete n[key]; return n })
            // 保存后刷新主面板（efforts/目录可能变化）
            load()
          })
          .catch(function (e) {
            var msg = String((e && e.message) || e)
            if (/内置目录/.test(msg)) {
              msg += '。内置供应商的能力由宿主模型目录管理，请在宿主 Models 页面调整。'
            } else if (/no level beyond|offers no level/.test(msg)) {
              msg += '。至少勾选一个 off 之外的思考级别（如 low/medium/high）。'
            } else if (/reasoningEfforts/.test(msg)) {
              msg += '。请检查思考级别档位的 wire 值填写。'
            }
            setNotice('写回失败：' + msg)
          })
          .finally(function () { setCapsSavingKey(null) })
      }

      // 思考级别档位（与宿主 llm-pi-ai 的 THINKING_LEVELS 一致，升序）
      var THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

      // 初始化某模型的编辑草稿（从 capabilities 当前值生成）
      var capsInitDraft = function (provider, model) {
        var list = (capabilities || {})[provider] || []
        var m = list.find(function (x) { return x.id === model }) || {}
        var re = m.reasoningEfforts && typeof m.reasoningEfforts === 'object' ? m.reasoningEfforts : {}
        return {
          contextWindow: m.contextWindow !== undefined ? m.contextWindow : '',
          maxTokens: m.maxTokens !== undefined ? m.maxTokens : '',
          reasoningEfforts: JSON.parse(JSON.stringify(re)),
        }
      }

      // 读取草稿（惰性初始化），未初始化时用当前值兜底（同步返回，不依赖 setState）
      var capsGetDraft = function (provider, model) {
        var key = provider + '/' + model
        if (!(key in capsDraft)) {
          setCapsDraft(function (d) { return Object.assign({}, d, { [key]: capsInitDraft(provider, model) }) })
          return capsInitDraft(provider, model)
        }
        return capsDraft[key]
      }

      // 渲染模型能力编辑区：按 provider 分组，每个模型一行可编辑
      var renderCapsBody = function () {
        var provs = Object.keys(capabilities || {}).sort()
        if (provs.length === 0) {
          return React.createElement('div', { className: 'dsh-mr-empty' },
            '未配置自定义供应商（hand-declared）。内置目录供应商的模型能力由宿主模型目录管理。')
        }
        return React.createElement('div', { className: 'dsh-mr-caps' },
          provs.map(function (pid) {
            var list = capabilities[pid] || []
            if (list.length === 0) return null
            return React.createElement('div', { className: 'dsh-mr-caps-prov', key: pid },
              React.createElement('div', { className: 'dsh-mr-caps-provhead' },
                React.createElement('code', { className: 'dsh-mr-id' }, pid),
                React.createElement('span', { className: 'dsh-mr-hint' }, list.length + ' 个模型')),
              list.map(function (m) {
                var key = pid + '/' + m.id
                var d = capsGetDraft(pid, m.id) || capsInitDraft(pid, m.id)
                var saving = capsSavingKey === key
                return React.createElement('div', { className: 'dsh-mr-caps-row', key: key },
                  React.createElement('div', { className: 'dsh-mr-caps-head' },
                    React.createElement('code', null, m.id),
                    React.createElement('span', { className: 'dsh-mr-hint' }, m.name && m.name !== m.id ? m.name : '')),
                  React.createElement('div', { className: 'dsh-mr-caps-row1' },
                    React.createElement('label', { className: 'dsh-mr-caps-field' },
                      React.createElement('span', null, 'contextWindow'),
                      React.createElement('input', { type: 'number', min: '1', className: 'dsh-mr-num', value: d.contextWindow,
                        placeholder: '未设置…', name: 'contextWindow', autocomplete: 'off', inputMode: 'numeric',
                        'aria-label': pid + '/' + m.id + ' contextWindow',
                        onChange: function (e) {
                          var v = e.target.value
                          setCapsDraft(function (dd) { return Object.assign({}, dd, { [key]: Object.assign({}, dd[key] || capsInitDraft(pid, m.id), { contextWindow: v }) }) })
                        } })),
                    React.createElement('label', { className: 'dsh-mr-caps-field' },
                      React.createElement('span', null, 'maxTokens'),
                      React.createElement('input', { type: 'number', min: '1', className: 'dsh-mr-num', value: d.maxTokens,
                        placeholder: '未设置…', name: 'maxTokens', autocomplete: 'off', inputMode: 'numeric',
                        'aria-label': pid + '/' + m.id + ' maxTokens',
                        onChange: function (e) {
                          var v = e.target.value
                          setCapsDraft(function (dd) { return Object.assign({}, dd, { [key]: Object.assign({}, dd[key] || capsInitDraft(pid, m.id), { maxTokens: v }) }) })
                        } }))),
                  React.createElement('div', { className: 'dsh-mr-caps-re' },
                    React.createElement('span', { className: 'dsh-mr-caps-re-label' }, '思考级别'),
                    React.createElement('div', { className: 'dsh-mr-caps-pickwrap' },
                      React.createElement('button', {
                        type: 'button', className: 'dsh-mr-caps-pick' + (openPick[key] ? ' is-open' : ''),
                        'aria-haspopup': 'listbox', 'aria-expanded': !!openPick[key],
                        onClick: function () { setOpenPick(function (p) { return Object.assign({}, p, { [key]: !p[key] }) }) },
                      },
                        React.createElement('span', null, '+ 添加档位'),
                        React.createElement('span', { className: 'dsh-mr-caps-pickcaret' }, openPick[key] ? '▴' : '▾')),
                      openPick[key]
                        ? React.createElement('div', { className: 'dsh-mr-caps-picklist', role: 'listbox' },
                            THINKING_LEVELS.map(function (lv) {
                              var enabled = Object.prototype.hasOwnProperty.call(d.reasoningEfforts, lv)
                              return React.createElement('button', {
                                type: 'button', role: 'option', key: lv, 'aria-selected': enabled,
                                className: 'dsh-mr-caps-pickitem' + (enabled ? ' is-on' : ''),
                                onClick: function () {
                                  setCapsDraft(function (dd) {
                                    var base = dd[key] || capsInitDraft(pid, m.id)
                                    var re = Object.assign({}, base.reasoningEfforts || {})
                                    if (enabled) delete re[lv]
                                    else re[lv] = lv === 'off' ? null : (typeof re[lv] === 'string' ? re[lv] : lv)
                                    return Object.assign({}, dd, { [key]: Object.assign({}, base, { reasoningEfforts: re }) })
                                  })
                                },
                              },
                                React.createElement('span', { className: 'dsh-mr-caps-pickitem-name' }, lv),
                                enabled ? React.createElement('span', { className: 'dsh-mr-caps-pickitem-check' }, '✓') : null)
                            }))
                        : null)
                    ,
                    React.createElement('div', { className: 'dsh-mr-caps-chips' },
                      THINKING_LEVELS.map(function (lv) {
                        // 键存在即已启用（off 值为 null 也算启用：支持但不发送 wire）
                        var enabled = Object.prototype.hasOwnProperty.call(d.reasoningEfforts, lv)
                        if (!enabled) return null
                        var wireVal = d.reasoningEfforts[lv] || ''
                        // wire 与档位名不同才显示可编辑输入（保持胶囊简洁 {low ×}）
                        var showWire = lv !== 'off' && wireVal !== '' && wireVal !== lv
                        return React.createElement('span', { className: 'dsh-mr-chip', key: lv, title: '思考级别 ' + lv },
                          React.createElement('span', { className: 'dsh-mr-chip-name' }, lv),
                          showWire
                            ? React.createElement('input', {
                                type: 'text', className: 'dsh-mr-chip-wire', value: wireVal,
                                name: 'wire', autocomplete: 'off', spellCheck: false, translate: 'no',
                                'aria-label': pid + '/' + m.id + ' 思考级别 ' + lv + ' wire 值',
                                onClick: function (e) { e.stopPropagation() },
                                onChange: function (e) {
                                  var v = e.target.value
                                  setCapsDraft(function (dd) {
                                    var base = dd[key] || capsInitDraft(pid, m.id)
                                    var re = Object.assign({}, base.reasoningEfforts || {})
                                    re[lv] = v
                                    return Object.assign({}, dd, { [key]: Object.assign({}, base, { reasoningEfforts: re }) })
                                  })
                                } })
                            : null,
                          React.createElement('button', {
                            type: 'button', className: 'dsh-mr-chip-x', 'aria-label': '移除思考级别 ' + lv, title: '移除 ' + lv,
                            onClick: function () {
                              setCapsDraft(function (dd) {
                                var base = dd[key] || capsInitDraft(pid, m.id)
                                var re = Object.assign({}, base.reasoningEfforts || {})
                                delete re[lv]
                                return Object.assign({}, dd, { [key]: Object.assign({}, base, { reasoningEfforts: re }) })
                              })
                            } }, '×'))
                      }))),
                  React.createElement('div', { className: 'dsh-mr-caps-actions' },
                    React.createElement('button', { type: 'button', className: 'dsh-mr-add', disabled: saving || !capsWritable,
                      onClick: function () { saveCapability(pid, m.id) } },
                      saving ? '保存中…' : '保存')))
              }))
          }))
      }

      if (loading && !data) return React.createElement('div', { className: 'dsh-mr' },
        React.createElement('h2', null, '模型路由'),
        React.createElement('div', { className: 'dsh-mr-skel' }))

      if (loadError && !data) return React.createElement('div', { className: 'dsh-mr' },
        React.createElement('h2', null, '模型路由'),
        React.createElement('div', { className: 'dsh-mr-error' }, '加载失败：' + loadError + ' ',
          React.createElement('button', { type: 'button', onClick: load }, '重试')))

      var catalog = (data && data.catalog) || {}
      var efforts = (data && data.efforts) || {}
      var health = (data && data.health) || {}
      var providerIds = Object.keys(catalog).sort()
      var routes = (cfg && cfg.routes) || {}

      var setRoute = function (id, patch) {
        setCfg(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          next.routes[id] = Object.assign({}, next.routes[id], patch)
          return next
        })
      }
      var setChain = function (id, slot, chain) {
        var patch = {}; patch[slot] = chain
        setRoute(id, patch)
      }
      var addRoute = function () {
        var id = newId.trim()
        if (!id || !cfg || cfg.routes[id]) return
        setCfg(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          next.routes[id] = { tier1: [], tier2: [], tier3: [] }
          return next
        })
        setNewId('')
      }
      var removeRoute = function (id) {
        setCfg(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          delete next.routes[id]
          return next
        })
      }

      // 档位徽章：pro/normal/lite 配色
      var TIER_BADGE = {
        tier3: { text: 'pro',    cls: 'dsh-mr-badge-pro' },
        tier2: { text: 'normal', cls: 'dsh-mr-badge-normal' },
        tier1: { text: 'lite',   cls: 'dsh-mr-badge-lite' },
      }

      // 候选行编辑器
      var chainEditor = function (id, slot, label, hint) {
        var chain = (routes[id] && routes[id][slot]) || []
        var badge = TIER_BADGE[slot] || { text: slot, cls: '' }
        var modelOptions = function (provider, current) {
          var list = (catalog[provider] || []).slice()
          if (current && list.indexOf(current) < 0) list.unshift(current)
          return list
        }
        var effortOptions = function (c) {
          var key = c.provider + '/' + c.model
          // 已保存候选：优先用 state 返回的 efforts（目录档位）
          if (efforts[key]) return { list: efforts[key].slice(), state: 'ready' }
          // 惰性查询过的：用 extraEfforts
          if (extraEfforts[key]) return { list: extraEfforts[key].slice(), state: 'ready' }
          // 未命中且未在查询：发起单候选查询（面板新加未保存候选的真实能力）
          if (!fetchingEfforts[key]) {
            setFetchingEfforts(function (f) { return Object.assign({}, f, { [key]: true }) })
            api('/api/model-router/efforts?provider=' + encodeURIComponent(c.provider) + '&model=' + encodeURIComponent(c.model))
              .then(function (res) {
                setExtraEfforts(function (x) { return Object.assign({}, x, { [key]: (res.efforts || []).slice() }) })
              })
              .catch(function () {
                setExtraEfforts(function (x) { return Object.assign({}, x, { [key]: [] }) })
              })
              .finally(function () {
                setFetchingEfforts(function (f) { var n = Object.assign({}, f); delete n[key]; return n })
              })
          }
          // 查询中：中性状态（不误报「不支持思考级别」）
          return { list: [], state: 'detecting' }
        }
        var update = function (i, patch) {
          var next = chain.map(function (c, j) { return j === i ? Object.assign({}, c, patch) : c })
          setChain(id, slot, next)
        }
        var move = function (i, d) {
          var j = i + d
          if (j < 0 || j >= chain.length) return
          var next = chain.slice()
          var t = next[i]; next[i] = next[j]; next[j] = t
          setChain(id, slot, next)
        }
        return React.createElement('div', { className: 'dsh-mr-chain', key: id + '.' + slot },
          React.createElement('div', { className: 'dsh-mr-chain-head' },
            React.createElement('span', { className: 'dsh-mr-badge ' + badge.cls }, badge.text),
            React.createElement('span', { className: 'dsh-mr-chain-count' }, chain.length > 0 ? chain.length + ' 个候选' : '空')),
          chain.length === 0
            ? React.createElement('div', { className: 'dsh-mr-empty' }, '（空：命中该链时回退到上一档）')
            : chain.map(function (c, i) {
                var opts = effortOptions(c)
                var eList = opts.list
                // 已保存的思考级别不在当前可选列表时，补一个临时项避免下拉显示空白
                if (c.reasoningEffort && !eList.some(function (e) { return e.id === c.reasoningEffort })) {
                  eList = eList.concat([{ id: c.reasoningEffort, name: c.reasoningEffort + '（已存）', verified: false }])
                }
                var effortState = opts.state
                var hk = c.provider + '/' + c.model
                var h = health[hk]
                var hChip = h && (h.ok + h.fail > 0)
                  ? React.createElement('span', { className: 'dsh-mr-hstat' + ((h.fail > 0) ? ' dsh-mr-hstat-warn' : ''),
                      title: '健康度（近 ' + ((cfg && cfg.healthWindowSize) || 8) + ' 次）：成功 ' + h.ok + ' / 失败 ' + h.fail },
                      '✓' + h.ok + (h.fail > 0 ? ' ✗' + h.fail : ''))
                  : null
                var effortDisabled = effortState === 'ready' ? eList.length === 0 : true
                var effortLabel = effortState === 'detecting' ? '检测中…'
                  : (eList.length === 0 ? '不支持思考级别' : '默认')
                var effortTitle = effortState === 'detecting' ? '正在检测该模型的思考级别能力…'
                  : (eList.length === 0 ? '不支持思考级别' : (eList.some(function (e) { return !e.verified }) ? '思考级别（该模型目录未标注，兜底档位未经验证）' : '思考级别'))
                return React.createElement('div', { className: 'dsh-mr-cand', key: i },
                  React.createElement('span', { className: 'dsh-mr-ord' }, (i + 1) + '.'),
                  React.createElement('select', {
                    className: 'dsh-mr-sel', 'aria-label': '供应商', value: c.provider,
                    onChange: function (e) {
                      var p = e.target.value
                      var models = catalog[p] || []
                      update(i, { provider: p, model: models[0] || c.model })
                    },
                  }, providerIds.map(function (p) {
                    return React.createElement('option', { key: p, value: p }, p)
                  })),
                  React.createElement('select', {
                    className: 'dsh-mr-sel dsh-mr-sel-model', 'aria-label': '模型',
                    value: c.model, onChange: function (e) { update(i, { model: e.target.value }) },
                  }, modelOptions(c.provider, c.model).map(function (m) {
                    return React.createElement('option', { key: m, value: m }, m)
                  })),
                  React.createElement('select', {
                    className: 'dsh-mr-sel dsh-mr-sel-effort', 'aria-label': '思考级别',
                    title: effortTitle,
                    value: c.reasoningEffort || '',
                    disabled: effortDisabled,
                    onChange: function (e) {
                      var v = e.target.value
                      var patch = v === '' ? {} : { reasoningEffort: v }
                      if (v === '') delete patch.reasoningEffort
                      update(i, patch)
                    },
                  }, [
                    React.createElement('option', { key: 'default', value: '' }, effortLabel),
                  ].concat(eList.map(function (ef) {
                    return React.createElement('option', { key: ef.id, value: ef.id },
                      ef.name || ef.id + (ef.verified === false ? '（手动）' : ''))
                  }))),
                  hChip,
                  React.createElement('span', { className: 'dsh-mr-btns' },
                    React.createElement('button', { type: 'button', className: 'dsh-mr-mini', 'aria-label': '上移候选', title: '上移', disabled: i === 0, onClick: function () { move(i, -1) } }, '↑'),
                    React.createElement('button', { type: 'button', className: 'dsh-mr-mini', 'aria-label': '下移候选', title: '下移', disabled: i === chain.length - 1, onClick: function () { move(i, 1) } }, '↓'),
                    React.createElement('button', { type: 'button', className: 'dsh-mr-mini dsh-mr-danger', 'aria-label': '删除候选', title: '删除', onClick: function () {
                      setChain(id, slot, chain.filter(function (_, j) { return j !== i }))
                    } }, '×')))
              }),
          React.createElement('button', {
            type: 'button', className: 'dsh-mr-add',
            onClick: function () {
              var p0 = providerIds[0] || ''
              var m0 = (catalog[p0] || [])[0] || ''
              setChain(id, slot, chain.concat([{ provider: p0, model: m0 }]))
            },
          }, '+ 添加候选'))
      }

      var cooldownList = (data && data.cooldowns) || []
      var historyList = (data && data.history) || []
      var statsMap = (data && data.stats) || {}
      var now = tick || Date.now()

      var fmtRemaining = function (ms) {
        var s = Math.ceil(ms / 1000)
        if (s >= 60) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
        return s + ' 秒'
      }
      var fmtTime = function (ts) {
        try {
          return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ts))
        } catch {
          var d = new Date(ts)
          var p = function (n) { return (n < 10 ? '0' : '') + n }
          return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
        }
      }
      var typeLabel = { started: '尝试', failover: '切换', served: '服务', 'all-failed': '全失败', passthrough: '放行', 'manual-tier': '手动档', 'cooldowns-cleared': '清冷却' }

      return React.createElement('div', { className: 'dsh-mr' },
        React.createElement('h2', null, '模型路由'),
        React.createElement('p', { className: 'dsh-mr-sub' },
          '统一 ModelID 套餐：一个逻辑模型名汇聚多家供应商额度，首 token 前失败自动切换候选（带冷却）。',
          '三档 pro / normal / lite，每个候选可配思考级别。配置保存后即时生效。'),

        notice !== null
          ? React.createElement('div', { className: 'dsh-mr-ok', role: 'status', 'aria-live': 'polite' }, notice)
          : null,

        // ---- 全局设置 ----
        React.createElement('div', { className: 'dsh-mr-card' },
          React.createElement('div', { className: 'dsh-mr-card-head' },
            // 总开关：用 <button role="switch">（原生可聚焦 + Enter/Space 触发），
            // 取代纯 span+onClick（不可键盘操作，违反 a11y）。
            React.createElement('button', { type: 'button', className: 'dsh-mr-switch' + ((cfg && cfg.enabled) ? ' is-on' : ''),
              role: 'switch', 'aria-checked': !!(cfg && cfg.enabled), 'aria-label': '总开关', title: '总开关',
              onClick: function () { setCfg(function (p) { return Object.assign({}, p, { enabled: !p.enabled }) }) } }),
            React.createElement('b', null, '全局'),
            React.createElement('span', { className: 'dsh-mr-hint' }, (cfg && cfg.enabled) ? '已启用' : '已停用（全部放行）')),
          React.createElement('div', { className: 'dsh-mr-grid' },
            React.createElement('label', null, '失败冷却（毫秒，5 分钟 = 300000）',
              React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 0, step: 1000,
                name: 'cooldownMs', autocomplete: 'off', inputMode: 'numeric',
                value: cfg ? cfg.cooldownMs : 0,
                onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { cooldownMs: Math.max(0, Number(e.target.value) || 0) }) }) } })),
            React.createElement('label', null, '单步最多切换候选次数',
              React.createElement('input', { className: 'dsh-mr-num', type: 'number', min: 1, max: 10,
                name: 'maxSwitchesPerStep', autocomplete: 'off', inputMode: 'numeric',
                value: cfg ? cfg.maxSwitchesPerStep : 3,
                onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { maxSwitchesPerStep: Math.min(10, Math.max(1, Number(e.target.value) || 1)) }) }) } }))),
          React.createElement('label', { className: 'dsh-mr-check' },
            React.createElement('input', { type: 'checkbox', checked: !!(cfg && cfg.healthRanking),
              onChange: function (e) { setCfg(function (p) { return Object.assign({}, p, { healthRanking: e.target.checked }) }) } }),
            ' 健康度择优（稳定成功的候选优先，频繁失败的候选后移）'),
          React.createElement('div', { className: 'dsh-mr-actions' },
            React.createElement('button', { type: 'button', className: 'dsh-mr-primary', disabled: saving, onClick: save },
              saving ? '保存中…' : '保存全部'))),

        // ---- 冷却中候选 ----
        React.createElement('div', { className: 'dsh-mr-card' },
          React.createElement('div', { className: 'dsh-mr-card-head' },
            React.createElement('b', null, '冷却中的候选'),
            cooldownList.length > 0
              ? React.createElement('button', { type: 'button', className: 'dsh-mr-mini', onClick: clearCooldowns }, '全部清除')
              : React.createElement('span', { className: 'dsh-mr-hint' }, '当前无')),
          cooldownList.map(function (c) {
            return React.createElement('div', { className: 'dsh-mr-cd', key: c.key },
              React.createElement('code', null, c.key),
              React.createElement('span', { className: 'dsh-mr-hint' }, '剩余 ' + fmtRemaining(Math.max(0, c.until - now))))
          })),

        // ---- 模型能力（写回宿主 llm-pi-ai · 仅自定义供应商）----
        React.createElement('div', { className: 'dsh-mr-card' },
          React.createElement('div', { className: 'dsh-mr-card-head' },
            React.createElement('b', null, '自定义供应商模型能力'),
            React.createElement('button', { type: 'button', className: 'dsh-mr-mini', 'aria-expanded': capsOpen,
              onClick: function () { setCapsOpen(!capsOpen) } }, capsOpen ? '收起' : '展开'),
            React.createElement('span', { className: 'dsh-mr-hint' },
              capsWritable ? '写回宿主 llm-pi-ai，热重载生效' : '宿主配置不可写')),
          capsOpen ? renderCapsBody() : null),

        // ---- 路由编辑 ----
        React.createElement('div', { className: 'dsh-mr-card' },
          React.createElement('div', { className: 'dsh-mr-card-head' }, React.createElement('b', null, '统一模型路由'),
            React.createElement('span', { className: 'dsh-mr-hint' },
              Object.keys(routes).length + ' 个 · 累计 ' +
              Object.values(statsMap).reduce(function (a, s) { return a + s.requests }, 0) + ' 次请求 / ' +
              Object.values(statsMap).reduce(function (a, s) { return a + s.failovers }, 0) + ' 次切换')),
          Object.keys(routes).length === 0
            ? React.createElement('div', { className: 'dsh-mr-empty' },
                '还没有套餐。在对话窗口的套餐选择器中添加（或在此手动添加同名统一模型 ID），即可获得分级路由与故障转移。')
            : Object.keys(routes).sort().map(function (id) {
                var st = statsMap[id]
                var failRate = st && st.requests > 0
                  ? Math.round((st.failovers / st.requests) * 100) + '%'
                  : null
                return React.createElement('div', { className: 'dsh-mr-route', key: id },
                  React.createElement('div', { className: 'dsh-mr-route-head' },
                    React.createElement('code', { className: 'dsh-mr-id' }, id),
                    st ? React.createElement('span', { className: 'dsh-mr-hint' },
                      st.requests + ' 请求' + (st.failovers > 0 ? ' / ' + st.failovers + ' 切换' + (failRate ? '（切换率 ' + failRate + '）' : '') : '')) : null,
                    React.createElement('button', { type: 'button', className: 'dsh-mr-mini dsh-mr-danger', title: '删除此路由',
                      onClick: function () { removeRoute(id) } }, '删除路由')),
                  chainEditor(id, 'tier3'),
                  chainEditor(id, 'tier2'),
                  chainEditor(id, 'tier1'))
              }),
          React.createElement('div', { className: 'dsh-mr-newroute' },
            React.createElement('input', { className: 'dsh-mr-text', 'aria-label': '新统一模型 ID', placeholder: '新统一模型 ID，如 deepseek-v4-flash',
              name: 'newRouteId', autocomplete: 'off', spellCheck: false, translate: 'no',
              value: newId, onChange: function (e) { setNewId(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') addRoute() } }),
            React.createElement('button', { type: 'button', className: 'dsh-mr-add', disabled: !newId.trim(), onClick: addRoute }, '+ 添加'))),

        // ---- 事件历史（默认折叠，展开后只展示最近 10 条）----
        React.createElement('div', { className: 'dsh-mr-card' },
          React.createElement('div', { className: 'dsh-mr-card-head' },
            React.createElement('b', null, '最近事件'),
            historyList.length > 0
              ? React.createElement('button', {
                  type: 'button', className: 'dsh-mr-mini dsh-mr-mini-toggle',
                  onClick: function () { setHistoryOpen(!historyOpen) },
                  title: historyOpen ? '折叠' : '展开',
                },
                  historyOpen ? '折叠' : '展开',
                  React.createElement(historyOpen ? primitives.IconChevronUpOutline14 : primitives.IconChevronDownOutline14, { className: 'dsh-mr-mini-chevron' }))
              : React.createElement('span', { className: 'dsh-mr-hint' }, '暂无事件')),
            historyOpen && historyList.length > 0
            ? React.createElement('table', { className: 'dsh-mr-table' },
                React.createElement('thead', null, React.createElement('tr', null,
                  React.createElement('th', null, '时间'), React.createElement('th', null, '类型'),
                  React.createElement('th', null, '模型'), React.createElement('th', null, '档位'),
                  React.createElement('th', null, '任务'),
                  React.createElement('th', null, '详情'))),
                React.createElement('tbody', null, historyList.slice(0, 10).map(function (h, i) {
                  var detail = h.type === 'failover'
                    ? h.from + ' 失败 ' + h.code + (h.status ? '(HTTP ' + h.status + ')' : '') + ' → 下一候选'
                    : h.type === 'served' ? '由 ' + h.by + ' 服务'
                    : h.type === 'all-failed' ? '所有候选失败：' + h.code
                    : h.type === 'passthrough' ? '候选全部冷却，放行原路径'
                    : h.type === 'started' ? '尝试 ' + (h.try || '')
                    : h.type === 'manual-tier' ? '手动切档 → ' + (h.tier || '')
                    : '已清除全部冷却'
                  return React.createElement('tr', { key: i },
                    React.createElement('td', { className: 'dsh-mr-mono' }, fmtTime(h.ts)),
                    React.createElement('td', null, typeLabel[h.type] || h.type),
                    React.createElement('td', { className: 'dsh-mr-mono' }, h.model || '—'),
                    React.createElement('td', null, h.tier ? React.createElement('code', { className: 'dsh-mr-tier-tag' }, h.tier) : '—'),
                    React.createElement('td', null, h.purpose || '—'),
                    React.createElement('td', { className: 'dsh-mr-detail' }, detail))
                })))
            : null))

      // tick 引用（每秒刷新冷却剩余时间）
      void now
    }

    // ------------------------------------------------------------------
    // 对话窗口「套餐」选择器（替换原模型选择器，挂在 conversation.input.model）
    // ------------------------------------------------------------------
    // 通过 slot 注入拿到 {available, directory, load, select}：
    //   directory.getSnapshot().current = {provider, model, reasoningEffort?} 当前会话模型
    //   select({provider, model}) = 调 sessions.selectModel 设会话模型
    // 套餐列表来自宿主 /api/model-router/state 的 config.routes 键。
    // 选中套餐 → select({provider: 该套餐 tier2 首候选 provider, model: 套餐ID})，
    // 路由器按 options.model=套餐ID 接管真实路由。
    var TIER_META = { tier1: 'lite', tier2: 'normal', tier3: 'pro' }
    var TIER_ORDER = ['tier3', 'tier2', 'tier1']

    function PackageSelect({ available, directory, load, select, sessionId }) {
      var s1 = React.useState(false); var open = s1[0]; var setOpen = s1[1]
      var s2 = React.useState(null);  var pkgs = s2[0]; var setPkgs = s2[1]
      var s3 = React.useState(null);  var pkgErr = s3[0]; var setPkgErr = s3[1]
      var s4 = React.useState(false); var busy = s4[0]; var setBusy = s4[1]
      var s9 = React.useState(null);  var manual = s9[0]; var setManual = s9[1]
      var rootRef = React.useRef(null)
      var id = React.useId()

      var state = React.useSyncExternalStore(function (fn) { return directory.subscribe(fn) }, function () { return directory.getSnapshot() })

      var refreshPkgs = React.useCallback(function () {
        if (!available) return
        api('/api/model-router/state').then(function (res) {
          var routes = res.config.routes || {}
          var list = Object.keys(routes).sort().map(function (key) {
            var r = routes[key]
            var summary = TIER_ORDER.map(function (slot) {
              var chain = (r[slot] || []).map(function (c) { return c.model })
              return chain.length > 0 ? TIER_META[slot] + ':' + chain.join('/') : null
            }).filter(Boolean)
            var carrier = (r.tier2 && r.tier2[0]) || (r.tier1 && r.tier1[0]) || (r.tier3 && r.tier3[0])
            // models = 三档所有候选模型名（用于把当前真实模型反查回所属套餐）
            var models = TIER_ORDER.reduce(function (acc, slot) {
              var chain = r[slot] || []
              for (var i = 0; i < chain.length; i++) acc.push(chain[i].model)
              return acc
            }, [])
            return { key: key, summary: summary, carrier: carrier || null, models: models, slots: {
              tier1: r.tier1 || [], tier2: r.tier2 || [], tier3: r.tier3 || [],
            } }
          })
          setPkgs(list)
          setManual((res.manualTiers && res.manualTiers[sessionId]) || null)
          setPkgErr(null)
        }).catch(function (e) {
          setPkgErr(String((e && e.message) || e))
        })
      }, [available, sessionId])

      React.useEffect(function () { refreshPkgs() }, [refreshPkgs])

      // 同步当前会话模型：directory.load() 调 sessions.models 把 store.current 设为真实模型
      //（刷新后/默认模型下 current 是 null，会导致套餐匹配失败显示「未配置套餐」）。
      React.useEffect(function () {
        if (!available || !load) return
        load()
      }, [available, load])

      // 打开时刷新（冷却/路由可能变化）
      React.useEffect(function () {
        if (!open) return
        refreshPkgs()
        var closeOutside = function (event) {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return function () { document.removeEventListener('mousedown', closeOutside) }
      }, [open, refreshPkgs])

      var current = state.current
      // 当前套餐：先按「套餐 key == 会话模型名」，再按「候选模型反查套餐」
      //（选套餐时会话模型被设为真实载体模型，如 volcengine/deepseek-v4-flash）
      var activeKey = undefined
      if (current && current.model && pkgs) {
        activeKey = pkgs.find(function (p) { return p.key === current.model }) || pkgs.find(function (p) { return p.models.indexOf(current.model) !== -1 })
      }
      // 新会话/默认模型下 current 为 null 时无 activeKey，会导致显示「未配置套餐」、
      // 菜单也没有档位按钮。回退到第一个套餐作为「显示/交互」的默认套餐
      //（档位仍取默认 normal/tier2），让新会话一眼看到当前生效档位，可直接切档/选套餐。
      var displayKey = activeKey
      if (!displayKey && !current && pkgs && pkgs.length > 0) {
        displayKey = pkgs[0]
      }
      // 生效档位：手动档优先；未手动选择时默认 normal（tier2，主对话的默认路由档）。
      // 触发按钮始终显示「套餐 · 档位」，让新会话一眼看到当前生效档位。
      var effectiveTier = manual || 'tier2'
      // 套餐仍在加载（pkgs 为 null）时先显示占位，避免误显示「未配置套餐」。
      var triggerLabel
      if (pkgs === null) {
        triggerLabel = '套餐…'
      } else if (displayKey) {
        triggerLabel = displayKey.key + ' · ' + (TIER_META[effectiveTier] || effectiveTier)
      } else if (current) {
        triggerLabel = current.model + ' · 自定义'
      } else {
        triggerLabel = '未配置套餐'
      }

      var choose = function (pkg) {
        if (!pkg || !pkg.carrier) return
        if (displayKey && displayKey.key === pkg.key) { setOpen(false); return }
        setBusy(true)
        // 用真实载体模型 selectModel（套餐 key 如 Economy 非真实模型名，会被校验拒绝）
        select({ provider: pkg.carrier.provider, model: pkg.carrier.model })
          .then(function (ok) {
            if (!ok) setPkgErr('选择失败（套餐对应的载体模型不可用）')
          })
          .catch(function (e) { setPkgErr(String((e && e.message) || e)) })
          .finally(function () { setBusy(false); setOpen(false) })
      }

      // 手动选档：记录 host 端档位 + 把会话模型切到该档首候选
      var chooseTier = function (slot) {
        if (!displayKey || !sessionId) return
        var cands = (displayKey.slots && displayKey.slots[slot]) || []
        var first = cands[0]
        if (!first) { setPkgErr('该档未配置候选模型，无法手动选择'); return }
        setBusy(true)
        api('/api/model-router/tier', { sessionId: sessionId, tier: slot })
          .then(function () { return select({ provider: first.provider, model: first.model }) })
          .then(function (ok) {
            if (!ok) { setPkgErr('档位切换失败（该档首候选模型不可用）'); return }
            setManual(slot)
            setOpen(false)
          })
          .catch(function (e) { setPkgErr('档位切换失败：' + String((e && e.message) || e)) })
          .finally(function () { setBusy(false) })
      }

      // 注：「自动」选项已按需求移除——手动档选定后一直生效，
      // 想换档直接点其他档位按钮即可（host 端 /api/model-router/tier
      // 仍支持 tier=auto，只是 UI 不再提供入口）。

      return React.createElement('div', { ref: rootRef, className: 'dsh-mrp', onKeyDown: function (e) {
        if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false) }
      } },
        React.createElement('button', {
          ref: null, type: 'button', className: 'dsh-mrp-trigger',
          title: '选择模型套餐（统一 ModelID，含三档与故障转移）',
          'aria-haspopup': 'menu', 'aria-expanded': open,
          disabled: !available || busy,
          onClick: function () { setOpen(!open) },
        },
          React.createElement('span', { className: 'dsh-mrp-label' }, triggerLabel),
          React.createElement(primitives.IconChevronDownOutline14, { className: 'dsh-mrp-caret' + (open ? ' dsh-mrp-caret-open' : '') })),
        open && React.createElement('div', { className: 'dsh-mrp-menu', role: 'menu' },
          pkgErr !== null
            ? React.createElement('div', { className: 'dsh-mrp-msg' }, '套餐加载失败：' + pkgErr)
            : pkgs === null
              ? React.createElement('div', { className: 'dsh-mrp-msg' }, '加载中…')
              : pkgs.length === 0
                ? React.createElement('div', { className: 'dsh-mrp-msg' }, '未配置套餐。请到设置 → 模型路由 添加统一模型 ID。')
                : React.createElement('div', null,
                    // 档位区：作用于当前套餐
                    displayKey
                      ? React.createElement('div', { className: 'dsh-mrp-tiers' },
                          React.createElement('div', { className: 'dsh-mrp-tiers-label' }, displayKey.key + ' · 档位'),
                          TIER_ORDER.map(function (slot) {
                            var cands = (displayKey.slots && displayKey.slots[slot]) || []
                            var on = effectiveTier === slot
                            // 档位按钮只显示档位名（pro/normal/lite），候选明细放悬停 title
                            var label = TIER_META[slot] + (cands[0] ? '' : '（未配置）')
                            return React.createElement('button', {
                              key: slot, type: 'button', role: 'menuitem',
                              className: 'dsh-mrp-tier' + (on ? ' is-on' : ''),
                              disabled: !cands[0] || busy,
                              title: cands[0] ? ('使用 ' + slot + '：' + cands.map(function (c) { return c.provider + '/' + c.model }).join(' → ')) : '该档未配置候选',
                              onClick: function () { chooseTier(slot) },
                            },
                              React.createElement('span', { className: 'dsh-mrp-tier-name' }, label),
                              on ? React.createElement('span', { className: 'dsh-mrp-check' }, '✓') : null)
                          })
                       ) : null,
                    React.createElement('div', { className: 'dsh-mrp-divider' }),
                    pkgs.map(function (p) {
                      var on = !!(displayKey && displayKey.key === p.key)
                      return React.createElement('button', {
                        key: p.key, type: 'button', role: 'menuitem',
                        className: 'dsh-mrp-item' + (on ? ' is-on' : ''),
                        onClick: function () { choose(p) },
                      },
                        React.createElement('span', { className: 'dsh-mrp-item-main' },
                          React.createElement('span', { className: 'dsh-mrp-item-name' }, p.key)),
                        on ? React.createElement('span', { className: 'dsh-mrp-check' }, '✓') : null)
                    }))))
    }

    // 运行时路由状态：轮询 model-router state，显示「档位 · 供应商/模型」。
    // 渲染在输入框工具行（conversation.input.left，Full access 与套餐选择器之间）。
    // 事件制：host 端把路由决策 append 为会话事件（model-router/route），客户端订阅
    // 会话事件流实时消费（零轮询、按会话天然隔离）；订阅不可用时回退到 2s 轮询。
    function OverlayStatus(props) {
      var s1 = React.useState(null); var latest = s1[0]; var setLatest = s1[1]
      var s2 = React.useState(true); var active = s2[0]; var setActive = s2[1]
      var s3 = React.useState(false); var err = s3[0]; var setErr = s3[1]

      // 从会话事件快照（conversation.inputs: Map<seq,{event,view}>）里取本会话
      // 最新的 model-router/route 事件：优先 started（运行中），否则 served（最近）。
      // 按 seq 升序遍历，后写覆盖先写，天然得到最新状态。
      function deriveFromSession(session) {
        try {
          var snap = session.getSnapshot()
          var conv = snap && snap.views
          var inputs = conv && conv.inputs
          if (!inputs) return null
          var lastStarted = null, lastServed = null
          inputs.forEach(function (entry) {
            var ev = entry && entry.event
            if (!ev || ev.type !== 'model-router/route') return
            var d = ev.data || {}
            if (d.type === 'started') lastStarted = d
            else if (d.type === 'served') lastServed = d
          })
          var entry = lastStarted || lastServed
          if (!entry) return null
          return { latest: entry, active: lastStarted !== null }
        } catch (e) {
          return null
        }
      }

      React.useEffect(function () {
        var alive = true
        var timer = null
        var sid = props.sessionId
        var sessions = props.sessions
        var session = null
        var unsubscribe = null
        // 优先：订阅会话事件流
        try {
          if (sessions && sid) {
            var binding = sessions.binding ? sessions.binding(sid) : undefined
            session = binding && binding.session
          }
        } catch (e) { session = null }
        if (session && typeof session.subscribe === 'function') {
          var handleChange = function () {
            if (!alive) return
            var derived = deriveFromSession(session)
            if (derived) {
              setLatest(derived.latest)
              setActive(derived.active)
              setErr(null)
            }
          }
          try {
            unsubscribe = session.subscribe(handleChange)
            handleChange() // 初始读一次
          } catch (e) {
            unsubscribe = null
            session = null
          }
        }
        // 兜底：订阅不可用（或事件流未就绪）时轮询 state history
        var tick = function () {
          if (!alive) return
          api('/api/model-router/state').then(function (res) {
            if (!alive) return
            var h = res.history || []
            // 只取「本会话」的路由记录（多会话并行时避免显示别的会话的模型）。
            var mine = []
            for (var i = 0; i < h.length; i++) {
              var r = h[i]
              var rsid = r.sessionId !== undefined ? r.sessionId : (r.type === 'manual-tier' ? r.model : null)
              if (rsid === sid) mine.push(r)
            }
            // 取最新一条 started；没有则取最新 served
            var lastStarted = null, lastServed = null
            for (var j = mine.length - 1; j >= 0; j--) {
              var m = mine[j]
              if (!lastStarted && m.type === 'started') lastStarted = m
              if (!lastServed && (m.type === 'served')) lastServed = m
              if (lastStarted) break
            }
            var entry = lastStarted || lastServed
            if (entry) {
              setLatest(entry)
              setActive(entry.type === 'started')
            }
            setErr(null)
          }).catch(function (e) { if (alive) setErr(String((e && e.message) || e)) })
          timer = setTimeout(tick, 2000)
        }
        // 只有订阅不可用时才轮询；订阅成功则以事件为主，不启动轮询
        if (!session) {
          tick()
        }
        return function () {
          alive = false
          if (unsubscribe) { try { unsubscribe() } catch (e) {} }
          if (timer) clearTimeout(timer)
        }
      }, [props.sessionId, props.sessions])

      if (err) {
        return React.createElement('div', { className: 'dsh-mr-overlay dsh-mr-overlay-err' }, '路由状态不可用')
      }
      if (!latest) return null
      // 全部失败（候选耗尽/全冷却）：显示「路由失败」提示而非完全消失。
      if (latest.type === 'all-failed') {
        return React.createElement('div', { className: 'dsh-mr-overlay dsh-mr-overlay-err', title: '所有候选都失败（请检查冷却或切换套餐）' },
          '路由失败')
      }
      // 显示完整「供应商/模型」（如 volcengine-main/deepseek-v4-flash）；
      // 运行中保留高亮作为「正在」的隐式信号。
      var full = latest.try || latest.by || ''
      if (!full) return null
      return React.createElement('div', { className: 'dsh-mr-overlay' + (active ? ' dsh-mr-overlay-active' : ''), title: full },
        React.createElement('span', { className: 'dsh-mr-overlay-who' }, full))
    }

    function apply(ctx) {
      var styleEl = document.createElement('style')
      styleEl.id = 'dsh-mr-style'
      styleEl.textContent = [
        '.dsh-mr { display: flex; flex-direction: column; gap: 14px; max-width: 720px; width: 100%; color: var(--dsw-alias-label-primary); touch-action: manipulation; -webkit-tap-highlight-color: transparent; }',
        '.dsh-mr h2 { margin: 0; font-size: 16px; font-weight: 600; text-wrap: balance; }',
        '.dsh-mr-sub { margin: 2px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; text-wrap: pretty; }',
        '.dsh-mr-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }',
        '.dsh-mr-card-head { display: flex; align-items: center; gap: 8px; }',
        '.dsh-mr-card-head b { font-size: 13px; }',
        '.dsh-mr-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }',
        '.dsh-mr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }',
        '.dsh-mr-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
        '.dsh-mr-check input { accent-color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-num, .dsh-mr-text { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: inherit; font-size: 13px; outline: none; }',
        '.dsh-mr-num:focus, .dsh-mr-text:focus { border-color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-num:focus-visible, .dsh-mr-text:focus-visible, .dsh-mr-sel:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        '.dsh-mr-text { flex: 1; }',
        '.dsh-mr-actions { display: flex; justify-content: flex-end; }',
        '.dsh-mr-primary { padding: 6px 18px; border-radius: 8px; border: none; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-overlay); font-size: 13px; font-weight: 600; cursor: pointer; }',
        '.dsh-mr-primary:disabled { opacity: .6; cursor: default; }',
        '.dsh-mr-switch { position: relative; flex: none; width: 36px; height: 20px; border-radius: 999px; border: none; background: var(--dsw-alias-border-l2); cursor: pointer; transition: background .15s ease; padding: 0; display: inline-block; font: inherit; }',
        '.dsh-mr-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
        '.dsh-mr-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-overlay); transition: transform .15s ease; box-shadow: 0 1px 2px rgba(0,0,0,.3); }',
        '.dsh-mr-switch.is-on { background: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-switch.is-on::after { transform: translateX(16px); }',
        '.dsh-mr-cd { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-variant-numeric: tabular-nums; }',
        '.dsh-mr-caps { display: flex; flex-direction: column; gap: 12px; }',
        '.dsh-mr-caps-prov { display: flex; flex-direction: column; gap: 8px; }',
        '.dsh-mr-caps-provhead { display: flex; align-items: center; gap: 8px; }',
        '.dsh-mr-caps-row { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
        '.dsh-mr-caps-head { display: flex; align-items: baseline; gap: 8px; }',
        '.dsh-mr-caps-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }',
        '.dsh-mr-caps-row1 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }',
        '.dsh-mr-caps-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-caps-re { display: flex; flex-direction: column; gap: 6px; }',
        '.dsh-mr-caps-re-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-caps-pickwrap { position: relative; display: inline-flex; align-self: flex-start; }',
        '.dsh-mr-caps-pick { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }',
        '.dsh-mr-caps-pick:hover, .dsh-mr-caps-pick.is-open { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }',
        '.dsh-mr-caps-pick:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        '.dsh-mr-caps-pickcaret { font-size: 9px; color: var(--dsw-alias-label-tertiary); }',
        '.dsh-mr-caps-picklist { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; min-width: 160px; padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-specific-menu); box-shadow: var(--dsw-shadow-lv3); display: flex; flex-direction: column; gap: 1px; }',
        '.dsh-mr-caps-pickitem { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 5px 8px; border: none; border-radius: 6px; background: none; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; text-align: left; }',
        '.dsh-mr-caps-pickitem:hover { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mr-caps-pickitem:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }',
        '.dsh-mr-caps-pickitem.is-on .dsh-mr-caps-pickitem-name { color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-caps-pickitem-check { color: var(--dsw-alias-brand-primary); font-size: 12px; }',
        '.dsh-mr-caps-pickitem-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }',
        '.dsh-mr-caps-chips { display: flex; flex-wrap: nowrap; align-items: center; gap: 6px; overflow-x: auto; min-width: 0; padding-bottom: 2px; }',
        '.dsh-mr-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 11px; flex: none; }',
        '.dsh-mr-chip-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; }',
        '.dsh-mr-chip-wire { width: 48px; padding: 1px 4px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; outline: none; }',
        '.dsh-mr-chip-wire:hover, .dsh-mr-chip-wire:focus { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }',
        '.dsh-mr-chip-wire:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        '.dsh-mr-chip-x { border: none; background: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1; padding: 1px 3px; cursor: pointer; border-radius: 50%; }',
        '.dsh-mr-chip-x:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mr-chip-x:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
        '.dsh-mr-caps-actions { display: flex; justify-content: flex-end; }',
        '.dsh-mr-route { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }',
        '.dsh-mr-route-head { display: flex; align-items: center; gap: 10px; }',
        '.dsh-mr-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; font-weight: 700; color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-chain { display: flex; flex-direction: column; gap: 6px; }',
        '.dsh-mr-chain-head { display: flex; align-items: center; gap: 8px; }',
        '.dsh-mr-chain-label { font-size: 12px; font-weight: 600; }',
        '.dsh-mr-chain-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-chain-count { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-caption); flex: none; }',
        // 档位徽章：pro 紫 / normal 蓝 / lite 绿
        '.dsh-mr-badge { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; font-weight: 700; letter-spacing: .3px; padding: 2px 8px; border-radius: 999px; flex: none; text-transform: uppercase; }',
        '.dsh-mr-badge-pro { color: #a78bfa; background: rgba(139, 92, 246, .12); border: 1px solid rgba(139, 92, 246, .35); }',
        '.dsh-mr-badge-normal { color: #60a5fa; background: rgba(59, 130, 246, .12); border: 1px solid rgba(59, 130, 246, .35); }',
        '.dsh-mr-badge-lite { color: #4ade80; background: rgba(34, 197, 94, .12); border: 1px solid rgba(34, 197, 94, .35); }',
        '.dsh-mr-cand { display: grid; grid-template-columns: 22px minmax(90px, 1fr) minmax(110px, 1.4fr) 120px auto auto; align-items: center; gap: 6px; padding: 2px 4px; min-width: 0; }',
        '.dsh-mr-hstat { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; font-weight: 600; color: var(--dsw-alias-state-success-primary, #34c759); white-space: nowrap; flex: none; font-variant-numeric: tabular-nums; }',
        '.dsh-mr-hstat-warn { color: var(--dsw-alias-state-error-primary); }',
        '.dsh-mr-cand:hover { background: var(--dsw-alias-interactive-bg-hover); border-radius: 8px; }',
        '.dsh-mr-ord { font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary); width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); flex: none; }',
        '.dsh-mr-sel { width: 100%; min-width: 0; max-width: none; padding: 5px 6px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font-size: 12px; outline: none; text-overflow: ellipsis; }',
        '.dsh-mr-sel-model { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mr-sel-effort { color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-sel-effort:disabled { opacity: .55; cursor: not-allowed; }',
        '.dsh-mr-tier-tag { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }',
        '.dsh-mr-slash { color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-btns { display: flex; gap: 4px; flex: none; justify-content: flex-end; }',
        '.dsh-mr-mini { padding: 3px 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; line-height: 1.2; }',
        '.dsh-mr-mini:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-mini-toggle { display: inline-flex; align-items: center; gap: 4px; }',
        '.dsh-mr-mini-chevron { display: inline-flex; flex: none; }',
        '.dsh-mr-mini:disabled { opacity: .4; cursor: default; }',
        '.dsh-mr-danger:hover { color: var(--dsw-alias-state-error-primary) !important; border-color: var(--dsw-alias-state-error-primary) !important; }',
        '.dsh-mr-add { align-self: flex-start; padding: 4px 12px; border-radius: 8px; border: 1px dashed var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }',
        '.dsh-mr-add:hover:not(:disabled) { color: var(--dsh-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }',
        '.dsh-mr-add:disabled { opacity: .5; cursor: default; }',
        '.dsh-mr-newroute { display: flex; gap: 8px; }',
        '.dsh-mr-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
        '.dsh-mr-table th { text-align: left; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-table td { padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }',
        '.dsh-mr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mr-detail { color: var(--dsw-alias-label-secondary); }',
        '.dsh-mr-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 10px 0; }',
        '.dsh-mr-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary, #34c759); padding: 8px 12px; border: 1px solid currentColor; border-radius: 8px; }',
        '.dsh-mr-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); padding: 8px 12px; border: 1px solid currentColor; border-radius: 8px; }',
        '.dsh-mr-skel { height: 120px; border-radius: 12px; background: linear-gradient(90deg, var(--dsw-alias-bg-layer-1) 25%, var(--dsw-alias-bg-layer-2) 50%, var(--dsw-alias-bg-layer-1) 75%); background-size: 200% 100%; animation: dsh-mr-shimmer 1.2s infinite; }',
        '@keyframes dsh-mr-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }',
        '@media (prefers-reduced-motion: reduce) { .dsh-mr-skel, .dsh-mr-switch, .dsh-mr-caret, .dsh-mr-caret-open { animation: none !important; transition: none !important; } }',
        // ---- 对话窗口套餐选择器 ----
        '.dsh-mrp { position: relative; display: inline-flex; min-width: 0; }',
        '.dsh-mrp-trigger { min-width: 0; max-width: 220px; height: 28px; color: var(--dsw-alias-label-secondary); cursor: pointer; background: none; border: none; border-radius: 24px; outline: none; align-items: center; gap: 4px; padding: 0 4px 0 8px; font-size: 13px; font-weight: 500; line-height: 20px; display: flex; }',
        '.dsh-mrp-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mrp-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; border-radius: 24px; }',
        '.dsh-mrp-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }',
        '.dsh-mrp-label { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; }',
        '.dsh-mrp-caret { color: var(--dsw-alias-label-caption); flex: none; display: inline-flex; transition: transform .12s ease; }',
        '.dsh-mrp-caret-open { transform: rotate(180deg); }',
        '.dsh-mrp-menu { z-index: 20; min-width: 280px; max-width: min(340px, 100vw - 32px); max-height: min(360px, 100vh - 96px); overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--dsw-alias-border-inverted); background: var(--dsw-specific-menu); box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); border-radius: 12px; flex-direction: column; padding: 4px; display: flex; position: absolute; bottom: calc(100% + 8px); right: 0; }',
        '.dsh-mrp-msg { color: var(--dsw-alias-label-tertiary); padding: 10px; font-size: 13px; line-height: 20px; }',
        '.dsh-mrp-item { width: 100%; min-height: 44px; color: inherit; text-align: left; cursor: pointer; background: none; border: none; border-radius: 10px; outline: none; align-items: center; gap: 8px; padding: 6px 8px; display: flex; }',
        '.dsh-mrp-item:hover:not(:disabled), .dsh-mrp-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mrp-item.is-on { background: none; }',
        '.dsh-mrp-item-main { flex-direction: column; flex: 1; min-width: 0; display: flex; }',
        '.dsh-mrp-item-name { color: inherit; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; line-height: 20px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mrp-item-summary { color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 18px; overflow: hidden; }',
        '.dsh-mrp-check { color: var(--dsw-alias-label-primary); flex: 0 0 18px; place-items: center; display: grid; }',
        '.dsh-mrp-tiers { flex-direction: column; display: flex; gap: 2px; padding: 2px 0 4px; }',
        '.dsh-mrp-tiers-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 18px; padding: 2px 8px 4px; }',
        '.dsh-mrp-tier { width: 100%; min-height: 34px; color: var(--dsw-alias-label-secondary); text-align: left; cursor: pointer; background: none; border: none; border-radius: 8px; outline: none; align-items: center; gap: 8px; padding: 4px 8px; display: flex; font-size: 13px; }',
        '.dsh-mrp-tier:hover:not(:disabled), .dsh-mrp-tier:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mrp-tier.is-on { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mrp-tier:disabled { opacity: .45; cursor: default; }',
        '.dsh-mrp-tier-name { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; flex: 1; }',
        '.dsh-mrp-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 2px 0 4px; flex: none; }',
        // ---- 运行时路由状态（输入框工具行）----
        '.dsh-mr-overlay { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: 999px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2); white-space: nowrap; }',
        '.dsh-mr-overlay-active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }',
        '.dsh-mr-overlay-tier { font-weight: 600; }',
        '.dsh-mr-overlay-sep { color: var(--dsw-alias-label-caption); }',
        '.dsh-mr-overlay-who { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dsh-mr-overlay-phase { color: var(--dsw-alias-label-caption); }',
        '.dsh-mr-overlay-err { color: var(--dsw-alias-state-error-primary); }',
      ].join('\n')
      document.head.appendChild(styleEl)

      // sessions 必须声明在 inject 列表：Cordis 对未声明服务的属性访问直接抛
      // "cannot get property sessions without inject"（曾导致回调死亡、面板/选择器全消失）。
      ctx.inject(['slots', 'modelDirectories', 'sessions'], function (scope) {
        var models = scope.modelDirectories
        var sessions = scope.sessions
        scope.slots.inject('settings.section', function () {
          return scope.slots.register(
            { name: 'settings.section', id: 'model-router', order: 13, label: '模型路由' },
            function () { return React.createElement(Panel) }
          )
        })
        // 对话窗口「套餐」选择器 —— 遮蔽原生模型选择器。
        // 说明：ui-model-selection 保持启用（否则 modelDirectories/models 服务不存在）。
        // single slot 按 priority 升序取 [0]（lowest renders），priority:-1 遮蔽其默认 0。
        // 渲染方只传 {locked}；available/directory/load/select 必须由注册方 inject 提供
        //（复刻原 ui-model-selection 的 inject face，否则 PackageSelect 收到空 props 而崩溃）。
        scope.slots.inject('conversation.input.model', function () {
          return scope.slots.register({
            name: 'conversation.input.model',
            id: 'dsh-model-router-package',
            order: 10,
            priority: -1,
            inject: function (sessionId) {
              var directory = models.directoryFor(sessionId)
              var available = sessions.subagentAddress(sessionId) === undefined
              return {
                sessionId: sessionId,
                available: available,
                directory: directory.store,
                load: function () {
                  if (available) directory.load().catch(function () {})
                },
                select: function (selection) {
                  return available ? directory.select(selection).then(function () { return true }, function () { return false }) : Promise.resolve(false)
                },
              }
            },
          }, function (props) { return React.createElement(PackageSelect, props) })
        })
        // 运行时路由状态：渲染在输入框工具行（conversation.input.left，
        // Full access 与套餐选择器之间），显示档位 + 实际供应商/模型。
        scope.slots.inject('conversation.input.left', function () {
          return scope.slots.register({
            name: 'conversation.input.left',
            id: 'dsh-model-router-live',
            order: 5,
            inject: function (sessionId) {
              return { sessionId: sessionId, sessions: sessions }
            },
          }, function (props) { return React.createElement(OverlayStatus, props) })
        })
      })

      return function () {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      }
    }

    exports.apply = apply
    return module.exports
  },
})
