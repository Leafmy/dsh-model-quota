/**
 * dsh-model-quota — 浏览器半。
 *
 * 注册一个 `sidebar.footer.action` 条目：侧栏底部的额度卡片（默认展示
 * 「当前主供应商 · 剩余百分比」），点击后在卡片右侧弹出「模型余额与额度」
 * 面板，逐行列出各供应商的余额 / 5 小时·周·月窗口与重置时间。
 *
 * 数据全部来自同一来源的宿主路由 `/dsh-model-quota/api/*`（密钥不下发浏览器）。
 * 本文件是 DSH Web 客户端的 ModuleLoader 模块（`window.__ModuleLoader__.load`），
 * 由 package.json 的 `dsh.client` 清单声明为 web 平台。
 *
 * @module dsh-model-quota/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-quota',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    const React = require('react')
    const ReactDOM = require('react-dom')

    const API = '/dsh-model-quota/api'
    const h = React.createElement
    const PANEL_WIDTH = 316

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    /** 「10月15日 22:45」式时间。 */
    function fmtDateTime(value) {
      if (!value) return ''
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** 金额展示（宿主已归一化，这里只补货币符号）。 */
    function fmtAmount(amount, currency) {
      const n = Number(amount)
      if (!Number.isFinite(n)) return '—'
      return `${n < 0 ? '-' : ''}${currency || ''}${Math.abs(n).toFixed(2)}`
    }

    /** 稳定错误码 → 人话（对齐 Tianshu-harness 的 ProviderUsageError 词表）。 */
    const ERROR_LABELS = {
      auth: '密钥无效或已过期',
      'rate-limit': '被上游限流',
      timeout: '请求超时',
      network: '网络不可达',
      'invalid-response': '响应无法解析',
      unavailable: '上游暂不可用',
      unknown: '未知错误',
    }

    /** 缺省展示偏好（宿主没给时的兜底，保持与宿主 DEFAULT_PREFS 一致）。 */
    const FALLBACK_PREFS = {
      followModel: true,
      bonusFirst: true,
      bonusInColor: true,
      balance: { healthy: 20, warn: 5 },
      quota: { preferred: 'rolling', healthy: 20, warn: 5 },
    }

    /** 取快照里的偏好（带兜底）。 */
    function prefsOf(snap) {
      const prefs = snap && snap.settings && snap.settings.prefs
      return prefs || FALLBACK_PREFS
    }

    /** 余额金额 → 语义色（<=0 或欠费为灰）。 */
    function balanceTone(value, prefs) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return 'qh-dim'
      const healthy = prefs.balance.healthy
      const warn = prefs.balance.warn
      if (n >= healthy) return 'qh-good'
      if (n >= warn) return 'qh-warn'
      return 'qh-bad'
    }

    /** 额度剩余百分比 → 语义色（0% 为空条）。 */
    function quotaTone(remaining, prefs) {
      const n = Number(remaining)
      if (!Number.isFinite(n) || n <= 0) return 'qh-empty'
      const healthy = prefs.quota.healthy
      const warn = prefs.quota.warn
      if (n >= healthy) return 'qh-good'
      if (n >= warn) return 'qh-warn'
      return 'qh-bad'
    }

    /**
     * 余额展示模型：有未用完的赠金且开了「赠金优先」就展示赠金，
     * 否则展示余额；颜色按 prefs.bonusInColor 决定用赠金还是余额计算。
     */
    function walletView(row, prefs) {
      const wallet = row && row.wallet
      if (!wallet) {
        return row && row.kind === 'balance'
          ? { showBonus: false, main: row.amount, currency: row.currency, sub: null, colorValue: row.amount }
          : null
      }
      const total = Number(wallet.total)
      const topUp = Number(wallet.topUp)
      const bonus = Number(wallet.bonus ?? 0)
      const hasBonus = Number.isFinite(bonus) && bonus > 0
      const showBonus = prefs.bonusFirst && hasBonus
      // 「正常余额」= 非赠金部分（充值钱包）；没有这个字段才退回总额
      const normal = Number.isFinite(topUp) ? topUp : total
      return {
        showBonus,
        main: showBonus ? bonus : total,
        currency: wallet.currency,
        // 展示赠金时，正常余额以灰色小字挂在下面
        sub: showBonus && Number.isFinite(normal) ? { label: '余额', value: normal, currency: wallet.currency } : null,
        // 赠金参与颜色计算：有赠金按赠金，用完自然回落余额
        colorValue: prefs.bonusInColor && hasBonus ? bonus : total,
      }
    }

    /** 取某行用于「卡片摘要」的窗口：按偏好优先，其次 5 小时。 */
    function preferredWindow(row, prefs) {
      const windows = row?.windows
      if (!windows) return null
      const preferred = prefs?.quota?.preferred
      if (preferred && windows[preferred]) return windows[preferred]
      return windows.rolling || windows.weekly || windows.monthly || null
    }

    /** 一行的摘要（卡片与面板共用）：文本 + 语义色 + 赠金信息。 */
    function rowSummary(row, prefs) {
      if (!row) return { text: '—', tone: 'qh-dim' }
      if (row.status === 'unconfigured') return { text: '未配置凭据', tone: 'qh-dim' }
      if (row.status === 'error') return { text: '读取失败', tone: 'qh-bad' }
      if (row.status === 'loading') return { text: '读取中…', tone: 'qh-dim' }
      if (row.kind === 'balance') {
        const view = walletView(row, prefs)
        return {
          text: fmtAmount(view.main, view.currency),
          tone: balanceTone(view.colorValue, prefs),
          wallet: view,
        }
      }
      if (row.kind === 'unsupported' || row.kind === 'info') return { text: row.text || '—', tone: 'qh-strong' }
      const win = preferredWindow(row, prefs)
      const remaining = win ? windowRemaining(win) : null
      if (remaining !== null) {
        return { text: `剩余 ${remaining}%`, tone: quotaTone(remaining, prefs), windowKey: win.period || null }
      }
      return { text: '—', tone: 'qh-dim' }
    }

    /** 窗口剩余百分比：优先用宿主给的 remainingPercent，兼容旧的 usedPercent。 */
    function windowRemaining(win) {
      if (!win) return null
      if (typeof win.remainingPercent === 'number') return Math.round(win.remainingPercent)
      if (typeof win.usedPercent === 'number') return 100 - Math.round(win.usedPercent)
      return null
    }

    // ------------------------------------------------------------------
    // 当前对话的模型商（订阅式，切模型立刻反映）
    // ------------------------------------------------------------------

    /** 由 apply(ctx) 注入；这些辅助函数在组件里调用时用得到。 */
    let rootCtx = null

    /** 取客户端服务（拿不到就 null，绝不抛）。 */
    function service(name) {
      try {
        return rootCtx && rootCtx.get ? rootCtx.get(name) : null
      } catch {
        return null
      }
    }

    /**
     * 当前对话的会话 id：列表里 `retainedBy.mainView > 0` 的那个。
     * @param {object} listSnapshot - `sessions.list` 的快照。
     * @returns {string|null} 会话 id。
     */
    function activeSessionIdFrom(listSnapshot) {
      const byId = (listSnapshot && listSnapshot.byId) || {}
      for (const id of Object.keys(byId)) {
        const session = byId[id]
        if (session && session.retainedBy && session.retainedBy.mainView > 0) return id
      }
      return null
    }

    /**
     * 会话的「模型选择」投影 face：`{getSnapshot, subscribe}`。
     * 这是权威且最便宜的来源——不建目录、不拉模型目录、不联网。
     * @param {object} sessions - `ctx.sessions`。
     * @param {string|null} sessionId - 会话 id。
     * @returns {object|null} 投影 face。
     */
    function selectionFaceOf(sessions, sessionId) {
      if (!sessions || !sessionId || typeof sessions.binding !== 'function') return null
      try {
        const binding = sessions.binding(sessionId)
        const projections = binding && binding.session && binding.session.projections
        const face = projections && typeof projections.faceOf === 'function' ? projections.faceOf('modelSelection') : null
        return face && typeof face.getSnapshot === 'function' && typeof face.subscribe === 'function' ? face : null
      } catch {
        return null
      }
    }

    /** 每个会话的目录 store 只解析一次（首次会懒建目录，之后零成本）。 */
    const directoryStoreCache = new Map()

    /**
     * 退回路径：`modelDirectories.directoryFor(id).store`（带 per-session 缓存）。
     * 只在会话投影还没有选择时用得到（空白会话 = 跟随目录里的默认模型）。
     * @param {string|null} sessionId - 会话 id。
     * @returns {object|null} 目录 store。
     */
    function directoryStoreOf(sessionId) {
      if (!sessionId) return null
      if (directoryStoreCache.has(sessionId)) return directoryStoreCache.get(sessionId)
      let store = null
      try {
        const directories = service('modelDirectories')
        const directory = directories && typeof directories.directoryFor === 'function' ? directories.directoryFor(sessionId) : null
        store = directory && directory.store && typeof directory.store.getSnapshot === 'function' ? directory.store : null
      } catch {
        store = null
      }
      // 只缓存成功结果：服务可能比本插件晚就绪，缓存 null 会让退回路径永久失效
      if (store) directoryStoreCache.set(sessionId, store)
      return store
    }

    /** 从选择投影里取 provider 名。 */
    function providerFromProjection(projected) {
      const next = projected && projected.next
      if (next && typeof next.provider === 'string') return next.provider
      const current = projected && projected.current
      if (current && typeof current.provider === 'string') return current.provider
      return null
    }

    /**
     * 当前对话所用的模型商名（订阅式：切模型 / 切会话都会立刻反映）。
     *
     * 为什么不用 `useSyncExternalStore`：它按 `Object.is` 比较 getSnapshot
     * 的返回值，遇到「每次调用都返回新对象」的 store 实现会自激成无限渲染
     * （React #185）。这里改成订阅 + 只存**字符串**，值不变就不会重渲染。
     *
     * 优先级：会话模型选择投影（最便宜、权威）→ 目录 store 的 current → null。
     * @returns {string|null} provider 名（如 `opencode-go`）。
     */
    function useActiveProviderName() {
      const [provider, setProvider] = React.useState(null)

      React.useEffect(() => {
        let disposed = false
        const cleanups = []
        let unsubFace = null
        let unsubDirectory = null
        const sessions = service('sessions')

        /** 重新读一遍当前模型商，只有字符串变了才 setState。 */
        const compute = () => {
          if (disposed) return
          let next = null
          let sid = null
          try {
            const list = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
            sid = activeSessionIdFrom(list)
            const face = selectionFaceOf(sessions, sid)
            if (face) next = providerFromProjection(face.getSnapshot())
            if (!next) {
              const store = directoryStoreOf(sid)
              const state = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
              next = state && state.current ? state.current.provider : null
            }
          } catch {
            next = null
          }
          setProvider((prev) => (prev === next ? prev : next))
        }

        /** 会话切换时把投影订阅重挂到新会话上。 */
        const rebind = () => {
          if (disposed) return
          if (unsubFace) {
            unsubFace()
            unsubFace = null
          }
          if (unsubDirectory) {
            unsubDirectory()
            unsubDirectory = null
          }
          let sid = null
          try {
            const list = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
            sid = activeSessionIdFrom(list)
          } catch {
            sid = null
          }
          const face = selectionFaceOf(sessions, sid)
          if (face && typeof face.subscribe === 'function') {
            const off = face.subscribe(compute)
            if (typeof off === 'function') unsubFace = off
          }
          const store = directoryStoreOf(sid)
          if (store && typeof store.subscribe === 'function') {
            const off = store.subscribe(compute)
            if (typeof off === 'function') unsubDirectory = off
          }
          compute()
        }

        try {
          const handle = sessions && sessions.list
          if (handle && typeof handle.subscribe === 'function') {
            const off = handle.subscribe(rebind)
            if (typeof off === 'function') cleanups.push(off)
          }
        } catch {
          /* 会话服务不可用：保持 null，卡片回落 primary */
        }
        rebind()

        return () => {
          disposed = true
          if (unsubFace) unsubFace()
          if (unsubDirectory) unsubDirectory()
          for (const off of cleanups) {
            try {
              off()
            } catch {
              /* 忽略退订异常 */
            }
          }
        }
      }, [])

      return provider
    }

    /**
     * 把 provider 名映射到快照里的行。
     * @param {Array} providers - 快照行。
     * @param {string|null} provider - provider 名。
     * @returns {object|null} 命中的行。
     */
    function matchProviderRow(providers, provider) {
      if (!provider) return null
      return (
        providers.find((row) => Array.isArray(row.sessionProviders) && row.sessionProviders.includes(provider)) ||
        providers.find((row) => row.id === provider) ||
        null
      )
    }

    /**
     * 当前对话所用的模型商 → 本插件供应商行（非 hook 版本，供测试/兜底）。
     * @param {Array} providers - 快照里的行。
     * @returns {object|null} 命中的行。
     */
    function activeProviderRow(providers) {
      try {
        const sessions = service('sessions')
        const list = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null
        const sessionId = activeSessionIdFrom(list)
        if (!sessionId) return null
        const face = selectionFaceOf(sessions, sessionId)
        const fromProjection = face ? providerFromProjection(face.getSnapshot()) : null
        if (fromProjection) return matchProviderRow(providers, fromProjection)
        const store = directoryStoreOf(sessionId)
        const state = store && store.getSnapshot ? store.getSnapshot() : null
        return matchProviderRow(providers, state && state.current ? state.current.provider : null)
      } catch {
        return null
      }
    }

    // ------------------------------------------------------------------
    // 数据
    // ------------------------------------------------------------------

    /** 轮询宿主快照的 hook。 */
    function useQuota() {
      const [snap, setSnap] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(`${API}/summary`, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setSnap(await res.json())
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        }
      }, [])

      const refresh = React.useCallback(async () => {
        setBusy(true)
        try {
          const res = await fetch(`${API}/refresh`, { method: 'POST', cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setSnap(await res.json())
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) void load()
        }
        tick()
        const timer = setInterval(tick, 60000) // 与宿主 5 分钟刷新错开，保证读数新鲜
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      return { snap, error, busy, refresh }
    }

    /** 面板主体。 */
    function QuotaPanel(props) {
      const { snap, error, busy, refresh, style, onClose } = props
      const providers = (snap && snap.providers) || []
      const prefs = prefsOf(snap)
      const activeProvider = useActiveProviderName()
      const refreshMinutes = snap && snap.config && snap.config.refreshMs ? Math.max(1, Math.round(snap.config.refreshMs / 60000)) : 5

      const body = []
      body.push(
        h(
          'div',
          { className: 'qh-panel-head', key: 'head' },
          h('span', { className: 'qh-panel-title' }, '模型余额与额度'),
          h(
            'button',
            {
              type: 'button',
              className: `qh-icon-btn${busy ? ' qh-spin' : ''}`,
              title: '立即刷新',
              onClick: () => void refresh(),
            },
            '⟳',
          ),
        ),
      )

      if (providers.length === 0) {
        body.push(h('div', { className: 'qh-empty', key: 'empty' }, error ? `读取失败：${error}` : '没有可显示的供应商'))
      }

      providers.forEach((row) =>
        body.push(
          h(ProviderRow, {
            row,
            prefs,
            current: Boolean(activeProvider && Array.isArray(row.sessionProviders) && row.sessionProviders.includes(activeProvider)),
            key: row.id,
          }),
        ),
      )

      body.push(
        h(
          'div',
          { className: 'qh-panel-foot', key: 'foot' },
          h('span', null, `前台每 ${refreshMinutes} 分钟更新 · 设置 → 额度面板 管理显示`),
          h('span', null, snap && snap.updatedAt ? `更新于 ${fmtDateTime(snap.updatedAt)}` : ''),
        ),
      )

      return h('div', { className: 'qh-panel', style, onMouseDown: (e) => e.stopPropagation() }, body)
    }

    /** 面板中的一个供应商行。 */
    function ProviderRow({ row, prefs, current }) {
      const lines = []
      lines.push(
        h(
          'div',
          { className: 'qh-row-head', key: 'h' },
          h('span', { className: 'qh-row-name' }, row.label),
          h('span', { className: `qh-row-tag${current ? ' qh-row-tag-current' : ''}` }, current ? '当前模型' : row.tag || 'default'),
        ),
      )

      if (row.status === 'unconfigured') {
        lines.push(h('div', { className: 'qh-row-value qh-dim', key: 'v' }, '未配置凭据'))
        // 把「查过哪些名字、哪个名字是空的」直接摆出来——「已配置却显示未配置」
        // 绝大多数是凭据名不一致（同名 key 在不同工具里叫法不同），这里一眼可见。
        const tried = Array.isArray(row.refsTried) ? row.refsTried : []
        if (tried.length > 0) {
          lines.push(h('div', { className: 'qh-row-hint', key: 'tried' }, '查找过的凭据名：'))
          tried.forEach((item, index) => {
            lines.push(
              h(
                'div',
                { className: 'qh-kv qh-kv-small', key: `r${index}` },
                h('span', { className: 'qh-kv-k' }, item.ref + (item.source === 'env' ? '（环境变量）' : '')),
                h('span', { className: `qh-kv-v ${item.present ? 'qh-warn' : 'qh-dim'}` }, item.present ? '已设置' : '未设置'),
              ),
            )
          })
        } else if (row.refs && row.refs.length > 0) {
          lines.push(h('div', { className: 'qh-row-hint', key: 'refs' }, `需要 ${row.refs.join(' / ')}`))
        }
        lines.push(h('div', { className: 'qh-row-hint', key: 'set' }, '在 设置 → 模型 里添加密钥后自动生效'))
      } else if (row.status === 'error') {
        const label = ERROR_LABELS[row.errorCode]
        lines.push(h('div', { className: 'qh-row-value qh-bad', key: 'v' }, label ? `读取失败 · ${label}` : '读取失败'))
        lines.push(h('div', { className: 'qh-row-hint', key: 'e' }, row.error || '未知错误'))
        if (row.credentialRef) lines.push(h('div', { className: 'qh-row-hint', key: 'c' }, `凭据：${row.credentialRef}`))
      } else if (row.kind === 'balance') {
        const view = walletView(row, prefs)
        lines.push(
          h(
            'div',
            { className: 'qh-balance', key: 'b' },
            h('span', { className: `qh-balance-amount ${balanceTone(view.colorValue, prefs)}` }, fmtAmount(view.main, view.currency)),
            view.showBonus ? h('span', { className: 'qh-bonus-badge' }, '赠金') : null,
            h('span', { className: 'qh-balance-caption' }, row.caption || '账户余额'),
          ),
        )
        // 展示赠金时，正常余额以灰色小字挂在下面（此时明细行是重复信息，不再渲染）
        if (view.sub) {
          lines.push(
            h(
              'div',
              { className: 'qh-wallet-sub', key: 'sub' },
              `${view.sub.label} ${fmtAmount(view.sub.value, view.sub.currency)}`,
            ),
          )
        } else {
          ;(row.detail || []).forEach((pair, index) => {
            if (!pair || !pair[1]) return
            lines.push(
              h(
                'div',
                { className: 'qh-kv', key: `d${index}` },
                h('span', { className: 'qh-kv-k' }, pair[0]),
                h('span', { className: 'qh-kv-v' }, pair[1]),
              ),
            )
          })
        }
      } else if (row.kind === 'unsupported' || row.kind === 'info') {
        lines.push(h('div', { className: 'qh-balance', key: 'b' }, h('span', { className: 'qh-balance-amount' }, row.text || '—')))
        if (row.caption) lines.push(h('div', { className: 'qh-row-hint', key: 'cap' }, row.caption))
      } else {
        const windows = row.windows || {}
        // 优先项（默认 5 小时）排在最前
        const preferred = prefs?.quota?.preferred
        const order = ['rolling', 'weekly', 'monthly'].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0))
        let shown = 0
        order.forEach((key) => {
          const win = windows[key]
          if (!win) return
          shown += 1
          const remaining = windowRemaining(win)
          const tone = quotaTone(remaining, prefs)
          const label = win.label || (row.windowLabels && row.windowLabels[key]) || key
          lines.push(
            h(
              'div',
              { className: 'qh-window', key: `w${key}` },
              h(
                'div',
                { className: 'qh-window-head' },
                h('span', { className: 'qh-window-label' }, label),
                h('span', { className: `qh-window-value ${tone}` }, remaining === null ? '—' : `剩余 ${remaining}%`),
              ),
              h(
                'div',
                { className: 'qh-bar' },
                h('div', {
                  className: `qh-bar-fill ${tone}`,
                  style: { width: `${remaining === null || remaining <= 0 ? 0 : Math.max(2, Math.min(100, remaining))}%` },
                }),
              ),
              win.resetsAt ? h('div', { className: 'qh-window-reset' }, `${fmtDateTime(win.resetsAt)} 重置`) : null,
            ),
          )
        })
        if (shown === 0) lines.push(h('div', { className: 'qh-row-value qh-dim', key: 'none' }, '暂无额度窗口'))
      }

      if (row.updatedAt && row.status === 'ok') {
        lines.push(h('div', { className: 'qh-row-time', key: 't' }, `更新于 ${fmtDateTime(row.updatedAt)}`))
      }

      return h('div', { className: `qh-row qh-row-${row.status}` }, lines)
    }

    // ------------------------------------------------------------------
    // 侧栏卡片
    // ------------------------------------------------------------------

    /** 侧栏底部额度卡片（点击展开面板）。 */
    function QuotaCard(props) {
      const wide = props ? props.wide !== false : true
      const { snap, error, busy, refresh } = useQuota()
      const cardRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(null)

      const providers = (snap && snap.providers) || []
      const prefs = prefsOf(snap)
      // 摘要行：默认跟随「当前对话所选的模型商」（订阅式，切模型立刻更新）
      const activeProvider = useActiveProviderName()
      const followed = prefs.followModel ? matchProviderRow(providers, activeProvider) : null
      const primary =
        followed ||
        providers.find((row) => row.id === (snap && snap.config && snap.config.primary)) ||
        providers.find((row) => row.status === 'ok') ||
        providers[0] ||
        null
      const summary = primary ? rowSummary(primary, prefs) : { text: '读取中…', tone: 'qh-dim' }
      const isSubscription = primary && (primary.kind === 'subscription' || primary.kind === 'usage')
      const preferredKey = prefs.quota.preferred
      const subline = isSubscription
        ? ((primary.windows && primary.windows[preferredKey] && primary.windows[preferredKey].label) ||
           (primary.windows && primary.windows.rolling && primary.windows.rolling.label) ||
           (primary.windowLabels && primary.windowLabels[preferredKey]) ||
           '5 小时额度')
        : primary && primary.kind === 'balance'
          ? summary.wallet && summary.wallet.showBonus
            ? `余额 ${fmtAmount(summary.wallet.sub ? summary.wallet.sub.value : primary.amount, primary.currency)}`
            : (primary.caption || '账户余额')
          : primary && (primary.kind === 'unsupported' || primary.kind === 'info')
            ? (primary.caption || '配额概览')
            : primary && primary.status === 'unconfigured'
              ? '未配置凭据'
              : primary && primary.status === 'error'
                ? '读取失败'
                : error
                  ? '无法连接宿主接口'
                  : '正在读取额度…'

      // 面板定位：默认贴在卡片右侧，空间不够则翻到左侧 / 上移
      const place = React.useCallback(() => {
        const el = cardRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const height = Math.min(window.innerHeight * 0.7, 520)
        let left = rect.right + 10
        if (left + PANEL_WIDTH > window.innerWidth - 8) left = Math.max(8, rect.left - PANEL_WIDTH - 10)
        const top = Math.max(8, Math.min(rect.top - 40, window.innerHeight - height - 8))
        setPos({ left, top, maxHeight: height })
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        place()
        const onDown = (event) => {
          const el = cardRef.current
          if (el && el.contains(event.target)) return
          if (event.target && event.target.closest && event.target.closest('.qh-panel')) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', place)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', place)
        }
      }, [open, place])

      const bonus = summary.wallet && summary.wallet.showBonus
      const trigger = h(
        'button',
        {
          type: 'button',
          ref: cardRef,
          className: `qh-card${open ? ' qh-card-open' : ''}${wide ? '' : ' qh-card-rail'}`,
          title: primary ? `${primary.label} · ${summary.text}` : '模型余额与额度',
          onClick: () => setOpen((value) => !value),
        },
        wide
          ? [
              h(
                'span',
                { className: 'qh-card-top', key: 'top' },
                h('span', { className: 'qh-card-name' }, primary ? primary.label : '模型额度'),
                h('span', { className: 'qh-card-tag' }, followed ? '当前模型' : 'default'),
                h('span', { className: 'qh-card-caret', key: 'caret' }, open ? '▾' : '▸'),
              ),
              h(
                'span',
                { className: `qh-card-main ${summary.tone}`, key: 'main' },
                summary.text,
                bonus ? h('span', { className: 'qh-bonus-badge', key: 'bonus' }, '赠金') : null,
              ),
              h('span', { className: 'qh-card-sub', key: 'sub' }, subline),
            ]
          : h('span', { className: `qh-card-rail-text ${summary.tone}` }, summary.text.replace('剩余 ', '')),
      )

      const panelStyle = pos ? { left: `${pos.left}px`, top: `${pos.top}px`, maxHeight: `${pos.maxHeight}px` } : { display: 'none' }

      return h(
        React.Fragment,
        null,
        trigger,
        open && typeof document !== 'undefined'
          ? ReactDOM.createPortal(h(QuotaPanel, { snap, error, busy, refresh, style: panelStyle, onClose: () => setOpen(false) }), document.body)
          : null,
      )
    }

    // ------------------------------------------------------------------
    // 设置页（设置 → 额度面板）
    // ------------------------------------------------------------------

    /** 显示模式取值与文案。 */
    const MODES = [
      ['auto', '自动'],
      ['on', '显示'],
      ['off', '隐藏'],
    ]

    /** 读写显示设置。 */
    function useSettings() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(`${API}/settings`, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setData(await res.json())
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const setMode = React.useCallback(async (id, mode) => {
        setBusy(id)
        try {
          const res = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providers: { [id]: mode } }),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = await res.json()
          setData((prev) => ({ ...(prev || {}), providers: body.providers, prefs: body.prefs, statePath: body.statePath }))
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(null)
        }
      }, [])

      /** 改展示偏好（阈值 / 赠金 / 跟随模型 / 额度优先项）。 */
      const setPrefs = React.useCallback(async (patch) => {
        setBusy('prefs')
        try {
          const res = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prefs: patch }),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = await res.json()
          setData((prev) => ({ ...(prev || {}), prefs: body.prefs, providers: body.providers, statePath: body.statePath }))
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(null)
        }
      }, [])

      return { data, error, busy, setMode, setPrefs, reload: load }
    }

    /** 一行偏好开关。 */
    function PrefSwitch({ label, hint, checked, disabled, onChange }) {
      return h(
        'div',
        { className: 'qh-set-row qh-set-pref' },
        h('div', { className: 'qh-set-main' }, h('div', { className: 'qh-set-title' }, label), hint ? h('div', { className: 'qh-set-hint' }, hint) : null),
        h(
          'button',
          {
            type: 'button',
            className: `qh-switch${checked ? ' qh-switch-on' : ''}`,
            disabled,
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            onClick: () => onChange(!checked),
          },
          h('span', { className: 'qh-switch-knob' }),
        ),
      )
    }

    /** 一个数字输入。 */
    function PrefNumber({ label, value, suffix, onCommit }) {
      const [draft, setDraft] = React.useState(String(value))
      React.useEffect(() => setDraft(String(value)), [value])
      const commit = () => {
        const n = Number(draft)
        if (Number.isFinite(n) && n !== value) onCommit(n)
        else setDraft(String(value))
      }
      return h(
        'label',
        { className: 'qh-pref-num' },
        h('span', { className: 'qh-set-hint' }, label),
        h('input', {
          className: 'qh-input',
          value: draft,
          inputMode: 'decimal',
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => {
            if (e.key === 'Enter') commit()
          },
        }),
        suffix ? h('span', { className: 'qh-set-hint' }, suffix) : null,
      )
    }

    /** 展示偏好区。 */
    function PrefsBlock({ prefs, setPrefs, busy }) {
      const disabled = busy === 'prefs'
      return h(
        'div',
        { className: 'qh-prefs' },
        h('div', { className: 'qh-prefs-head' }, '显示偏好'),
        h(PrefSwitch, {
          label: '卡片跟随当前对话的模型商',
          hint: '开：卡片显示当前对话所选模型商（如 OpenCode Go）的额度；关：固定显示下面的默认项',
          checked: prefs.followModel,
          disabled,
          onChange: (v) => void setPrefs({ followModel: v }),
        }),
        h(PrefSwitch, {
          label: '赠金优先显示',
          hint: '有未用完的赠金时优先显示赠金（绿底「赠金」标），余额以灰字挂在下面',
          checked: prefs.bonusFirst,
          disabled,
          onChange: (v) => void setPrefs({ bonusFirst: v }),
        }),
        h(PrefSwitch, {
          label: '赠金参与告警颜色计算',
          hint: '开：有赠金就按赠金判色、赠金用完自动回落按余额；关：只看余额',
          checked: prefs.bonusInColor,
          disabled,
          onChange: (v) => void setPrefs({ bonusInColor: v }),
        }),
        h(
          'div',
          { className: 'qh-set-row qh-set-pref' },
          h(
            'div',
            { className: 'qh-set-main' },
            h('div', { className: 'qh-set-title' }, '余额告警阈值'),
            h('div', { className: 'qh-set-hint' }, '≥ 充足（绿）· ≥ 警告（黄）· 更低为严重不足（红）· ≤0 欠费或无余额（灰）'),
          ),
          h(
            'div',
            { className: 'qh-pref-nums' },
            h(PrefNumber, {
              label: '充足 ≥',
              value: prefs.balance.healthy,
              suffix: 'CNY',
              onCommit: (n) => void setPrefs({ balance: { ...prefs.balance, healthy: n } }),
            }),
            h(PrefNumber, {
              label: '警告 ≥',
              value: prefs.balance.warn,
              suffix: 'CNY',
              onCommit: (n) => void setPrefs({ balance: { ...prefs.balance, warn: n } }),
            }),
          ),
        ),
        h(
          'div',
          { className: 'qh-set-row qh-set-pref' },
          h(
            'div',
            { className: 'qh-set-main' },
            h('div', { className: 'qh-set-title' }, '额度优先显示'),
            h('div', { className: 'qh-set-hint' }, '卡片与面板优先展示哪个窗口（默认 5 小时额度）'),
          ),
          h(
            'div',
            { className: 'qh-seg' },
            [
              ['rolling', '5 小时'],
              ['weekly', '每周'],
              ['monthly', '每月'],
            ].map(([key, label]) =>
              h(
                'button',
                {
                  type: 'button',
                  key,
                  className: `qh-seg-btn${prefs.quota.preferred === key ? ' qh-seg-on' : ''}`,
                  disabled,
                  onClick: () => void setPrefs({ quota: { ...prefs.quota, preferred: key } }),
                },
                label,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'qh-set-row qh-set-pref' },
          h(
            'div',
            { className: 'qh-set-main' },
            h('div', { className: 'qh-set-title' }, '额度告警阈值'),
            h('div', { className: 'qh-set-hint' }, '剩余 ≥ 充足（绿）· ≥ 警告（黄）· 更低为红 · 0% 空条'),
          ),
          h(
            'div',
            { className: 'qh-pref-nums' },
            h(PrefNumber, {
              label: '充足 ≥',
              value: prefs.quota.healthy,
              suffix: '%',
              onCommit: (n) => void setPrefs({ quota: { ...prefs.quota, healthy: n } }),
            }),
            h(PrefNumber, {
              label: '警告 ≥',
              value: prefs.quota.warn,
              suffix: '%',
              onCommit: (n) => void setPrefs({ quota: { ...prefs.quota, warn: n } }),
            }),
          ),
        ),
      )
    }

    /** 设置页主体：展示偏好 + 逐个供应商的显示开关。 */
    function QuotaSettings() {
      const { data, error, busy, setMode, setPrefs, reload } = useSettings()
      const providers = (data && data.providers) || []
      const prefs = (data && data.prefs) || FALLBACK_PREFS

      const rows = providers.map((row) =>
        h(
          'div',
          { className: 'qh-set-row', key: row.id },
          h(
            'div',
            { className: 'qh-set-main' },
            h(
              'div',
              { className: 'qh-set-title' },
              row.label,
              row.account ? h('span', { className: 'qh-set-badge' }, '账号') : null,
            ),
            row.hint ? h('div', { className: 'qh-set-hint' }, row.hint) : null,
            h(
              'div',
              { className: 'qh-set-meta' },
              row.detected ? h('span', { className: 'qh-good' }, '已检测到') : h('span', { className: 'qh-dim' }, '未检测到'),
              row.account || !row.refs || row.refs.length === 0
                ? null
                : h('span', { className: 'qh-dim' }, ` · ${row.refs.join(' / ')}`),
            ),
          ),
          h(
            'div',
            { className: 'qh-seg' },
            MODES.map(([mode, label]) =>
              h(
                'button',
                {
                  type: 'button',
                  key: mode,
                  className: `qh-seg-btn${row.mode === mode ? ' qh-seg-on' : ''}`,
                  disabled: busy === row.id,
                  onClick: () => {
                    if (row.mode !== mode) void setMode(row.id, mode)
                  },
                },
                label,
              ),
            ),
          ),
        ),
      )

      return h(
        'div',
        { className: 'qh-set' },
        h(
          'div',
          { className: 'qh-set-head' },
          h(
            'div',
            null,
            h('div', { className: 'qh-set-title-lg' }, '模型余额与额度'),
            h(
              'div',
              { className: 'qh-set-hint' },
              '默认只显示「DeepSeek Account」；其它供应商一旦检测到已配置的凭据就自动出现。也可以在这里手动钉死「显示 / 隐藏」。',
            ),
          ),
          h('button', { type: 'button', className: 'qh-icon-btn', title: '重新检测', onClick: () => void reload() }, '⟳'),
        ),
        error ? h('div', { className: 'qh-row-hint qh-bad' }, `读取失败：${error}`) : null,
        h(PrefsBlock, { prefs, setPrefs, busy }),
        rows.length === 0 ? h('div', { className: 'qh-empty' }, '加载中…') : rows,
        h(
          'div',
          { className: 'qh-set-foot' },
          `开关与阈值保存在 ${(data && data.statePath) || '~/.dsh/quota-hud/state.json'}（人可读，可直接编辑或删除）`,
        ),
      )
    }

    // ------------------------------------------------------------------
    // 样式
    // ------------------------------------------------------------------

    const CSS = `
.qh-card{display:flex;flex-direction:column;gap:2px;width:100%;margin:0 8px 6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);cursor:pointer;text-align:left;font-size:12px;line-height:1.45;transition:background .12s ease,border-color .12s ease}
.qh-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.qh-card-open{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.qh-card-rail{width:auto;align-items:center;margin:0 4px 6px;padding:6px 4px}
.qh-card-rail-text{font-size:11px}
.qh-card-top{display:flex;align-items:center;gap:6px;min-width:0}
.qh-card-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qh-card-tag{flex:0 0 auto;padding:0 5px;border-radius:6px;background:rgba(127,127,127,.16);color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-size:10px}
.qh-card-caret{margin-left:auto;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
.qh-card-main{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px}
.qh-card-sub{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
.qh-bonus-badge{flex:0 0 auto;padding:0 6px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#12a150);color:#fff;font-size:10px;font-weight:600;line-height:16px}
.qh-wallet-sub{margin-top:3px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-size:11px}
.qh-strong{color:var(--dsw-alias-label-primary,inherit)}
.qh-good{color:var(--dsw-alias-state-success-primary,#1a9d5a)}
.qh-warn{color:var(--dsw-alias-state-warn-primary,#c98a00)}
.qh-bad{color:var(--dsw-alias-state-error-primary,#d9463f)}
.qh-dim{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
.qh-panel{position:fixed;z-index:4200;width:${PANEL_WIDTH}px;box-sizing:border-box;overflow:auto;padding:10px 10px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:14px;background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 12px 40px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.5;animation:qh-in .12s ease-out}
@keyframes qh-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.qh-panel-head{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 8px;font-size:13px;font-weight:600}
.qh-icon-btn{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:6px}
.qh-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}
.qh-spin{animation:qh-rot 1s linear infinite}
@keyframes qh-rot{to{transform:rotate(360deg)}}
.qh-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));padding:8px 2px 9px}
.qh-row-head{display:flex;align-items:center;gap:6px}
.qh-row-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qh-row-tag{margin-left:auto;flex:0 0 auto;padding:0 5px;border-radius:6px;background:rgba(127,127,127,.16);color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-size:10px}
.qh-row-tag-current{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.qh-row-value{margin-top:4px;font-weight:600}
.qh-row-hint{margin-top:3px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));word-break:break-word}
.qh-row-time{margin-top:4px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.4));font-size:11px}
.qh-balance{display:flex;align-items:baseline;gap:6px;margin-top:2px}
.qh-balance-amount{font-size:16px;font-weight:700}
.qh-balance-caption{margin-left:auto;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-size:11px}
.qh-kv{display:flex;align-items:baseline;gap:8px;margin-top:3px}
.qh-kv-k{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
.qh-kv-v{margin-left:auto;font-variant-numeric:tabular-nums}
.qh-kv-small{font-size:11px}
.qh-window{margin-top:8px}
.qh-window-head{display:flex;align-items:baseline;gap:8px}
.qh-window-label{color:var(--dsw-alias-label-secondary,rgba(0,0,0,.6))}
.qh-window-value{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums}
.qh-bar{margin-top:5px;height:5px;border-radius:999px;background:rgba(127,127,127,.22);overflow:hidden}
.qh-bar-fill{height:100%;border-radius:999px;background:currentColor;transition:width .25s ease}
.qh-bar-fill.qh-good{background:var(--dsw-alias-state-success-primary,#1a9d5a)}
.qh-bar-fill.qh-warn{background:var(--dsw-alias-state-warn-primary,#c98a00)}
.qh-bar-fill.qh-bad{background:var(--dsw-alias-state-error-primary,#d9463f)}
.qh-bar-fill.qh-empty{background:transparent}
.qh-window-reset{margin-top:3px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.4));font-size:11px}
.qh-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));padding:8px 2px 2px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-size:11px}
.qh-empty{padding:10px 2px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
.qh-set{display:flex;flex-direction:column;gap:2px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}
.qh-set-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:2px 0 10px}
.qh-set-title-lg{font-size:15px;font-weight:600;margin-bottom:2px}
.qh-set-hint{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-size:12px}
.qh-set-row{display:flex;align-items:center;gap:12px;padding:10px 2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}
.qh-set-main{min-width:0;flex:1}
.qh-set-title{display:flex;align-items:center;gap:6px;font-weight:600}
.qh-set-badge{padding:0 5px;border-radius:6px;background:rgba(127,127,127,.16);color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));font-size:10px;font-weight:400}
.qh-set-meta{margin-top:3px;font-size:12px}
.qh-set-foot{padding:10px 2px 2px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.4));font-size:11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}
.qh-seg{display:inline-flex;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:8px;overflow:hidden}
.qh-seg-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.6));padding:4px 10px;font-size:12px;cursor:pointer;line-height:1.4}
.qh-seg-btn+.qh-seg-btn{border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}
.qh-seg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.qh-seg-btn:disabled{opacity:.5;cursor:default}
.qh-seg-on{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.qh-seg-on:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d6bfe)}
.qh-prefs{margin:2px 0 6px;padding:6px 0 2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}
.qh-prefs-head{font-weight:600;font-size:13px;padding:4px 2px 2px}
.qh-set-pref{align-items:center}
.qh-switch{flex:0 0 auto;width:38px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));background:rgba(127,127,127,.22);cursor:pointer;padding:0;position:relative;transition:background .15s ease}
.qh-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.qh-switch-on{background:var(--dsw-alias-state-success-primary,#12a150);border-color:transparent}
.qh-switch-on .qh-switch-knob{transform:translateX(16px)}
.qh-switch:disabled{opacity:.5;cursor:default}
.qh-pref-nums{display:flex;gap:10px;flex:0 0 auto}
.qh-pref-num{display:flex;align-items:center;gap:4px}
.qh-input{width:56px;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.qh-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
`

    /** 常驻注入样式（插件卸载时移除）。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-dsh-model-quota-css]')
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.dataset.dshQuotaHudCss = '1'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    // ------------------------------------------------------------------
    // 插件入口
    // ------------------------------------------------------------------

    /** 本插件需要的客户端服务。 */
    const inject = ['slots', 'sessions']

    /**
     * 客户端插件主体：注入样式，把额度卡片挂到侧栏底部座位，并在设置里
     * 注册「额度面板」页（展示偏好 + 逐个供应商的显示开关）。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      rootCtx = ctx
      ctx.effect(() => installStyles(), 'dsh-model-quota: styles')
      ctx.effect(() => () => {
        rootCtx = null
        directoryStoreCache.clear()
      }, 'dsh-model-quota: teardown')
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'dsh-model-quota',
                order: 50,
              },
              QuotaCard,
            ),
          ),
        'dsh-model-quota: sidebar card',
      )
      // 设置页：与「模型设置」同级的一个 section（ui-settings 声明该槽）
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'quota-hud',
                order: 60,
                label: () => '额度面板',
              },
              QuotaSettings,
            ),
          ),
        'dsh-model-quota: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.QuotaCard = QuotaCard
    exports.QuotaPanel = QuotaPanel
    exports.QuotaSettings = QuotaSettings

    return module.exports
  },
})
