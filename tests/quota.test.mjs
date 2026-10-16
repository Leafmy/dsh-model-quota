/**
 * dsh-model-quota 自测：响应解析 + 宿主路由（用假 ctx 跑完整链路，真实网络不参与）。
 * 运行：node --test tests/
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CATALOG,
  KNOWN_FORMATS,
  REF_ALIASES,
  accountClientMetadata,
  classifyError,
  isDetected,
  isVisible,
  mergeRefs,
  modeOf,
  normalizePrefs,
  parseBody,
  readState,
} from '../lib/impl.js'
import { API_PREFIX, describeRef, install, normalizeConfig, resolveEntries, resolveRef } from '../lib/impl.js'

/** 每个用例独立的临时状态文件（避免污染真实的 ~/.dsh/quota-hud/state.json）。 */
function stateFile() {
  return join(mkdtempSync(join(tmpdir(), 'qh-test-')), 'state.json')
}

/** 假的 DeepSeek 账号服务（与 ctx.deepseekAccount 的真实形状对齐）。 */
function fakeAccount({ signedIn = true, balance, fail = null } = {}) {
  return {
    async getState() {
      return { status: signedIn ? 'credential-stored' : 'signed-out', links: {} }
    },
    async getBalance() {
      if (fail) throw fail
      if (!signedIn) return null
      return (
        balance ?? {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '23.06' }],
          bonusWallets: [{ currency: 'CNY', balance: '23.12' }],
        }
      )
    },
  }
}

// ---------------------------------------------------------------------------
// 假 cordis 上下文 / 假 req-res
// ---------------------------------------------------------------------------

function makeCtx({ credentials = {}, known = null, account = null } = {}) {
  const routes = []
  const disposers = []
  const make = (isWeb) => {
    const node = {
      credentials: {
        resolve: async (ref) => (credentials[ref] ? { value: credentials[ref], source: 'test' } : undefined),
        // describe 永不返回值：只报「配没配 + 来源」
        describe: async (ref) => {
          const present = known ? known.includes(ref) : Boolean(credentials[ref])
          return present ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }
        },
      },
      deepseekAccount: account ?? undefined,
      effect(fn) {
        const disposer = fn()
        if (typeof disposer === 'function') disposers.push(disposer)
        return disposer
      },
      inject(services, callback) {
        if (!Array.isArray(services)) return
        if (services.includes('webServer')) return callback(make(true))
        if (services.includes('deepseekAccount') && !node.deepseekAccount) return
        callback(node)
      },
      webServer: isWeb
        ? {
            register(route) {
              routes.push(route)
              return () => {
                const index = routes.indexOf(route)
                if (index >= 0) routes.splice(index, 1)
              }
            },
          }
        : undefined,
    }
    return node
  }
  const ctx = make(false)
  return { ctx, routes, disposeAll: () => disposers.forEach((dispose) => dispose()) }
}

function fakeReqRes(method, url, { headers = {}, body } = {}) {
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body)
    },
  }
  const res = {
    statusCode: 0,
    resHeaders: null,
    payload: '',
    writeHead(status, hdrs) {
      this.statusCode = status
      this.resHeaders = hdrs
    },
    end(text) {
      this.payload = text ?? ''
    },
  }
  return { req, res }
}

async function call(handler, method, url, options) {
  const { req, res } = fakeReqRes(method, url, options)
  await handler(req, res)
  return { status: res.statusCode, headers: res.resHeaders, body: res.payload ? JSON.parse(res.payload) : null }
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

test('deepseek-balance：读出总额与充值/赠送明细', () => {
  const parsed = parseBody(
    'deepseek-balance',
    {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '23.06', granted_balance: '23.12', topped_up_balance: '0.06' }],
    },
    { currency: '¥' },
  )
  assert.equal(parsed.kind, 'balance')
  assert.equal(parsed.amount, 23.06)
  assert.equal(parsed.currency, '¥')
  assert.deepEqual(parsed.detail, [
    ['充值余额', '¥0.06'],
    ['赠送余额', '¥23.12'],
  ])
})

test('opencode-usage：percent 是「已用」，resetsAt 原样保留', () => {
  const parsed = parseBody(
    'opencode-usage',
    {
      usage: {
        rolling: { status: 'ok', percent: 8, resetsAt: '2026-10-15T14:45:00.000Z' },
        weekly: { status: 'ok', percent: 5, resetsAt: '2026-10-19T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 2, resetsAt: '2026-11-15T03:43:15.000Z' },
      },
    },
    {},
  )
  assert.equal(parsed.kind, 'usage')
  assert.equal(parsed.windows.rolling.usedPercent, 8)
  assert.equal(parsed.windows.weekly.usedPercent, 5)
  assert.equal(parsed.windows.monthly.usedPercent, 2)
  assert.equal(parsed.windows.rolling.resetsAt, '2026-10-15T14:45:00.000Z')
})

test('zai-coding-quota：unit 3=5 小时、6=周，TIME_LIMIT=月', () => {
  const parsed = parseBody(
    'zai-coding-quota',
    {
      code: 200,
      data: {
        planName: 'GLM Coding Pro',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: 1760539500000 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 12, nextResetTime: 1760841600000 },
          { type: 'TIME_LIMIT', currentValue: 3, usage: 100, nextResetTime: 1762000000000 },
        ],
      },
    },
    {},
  )
  assert.equal(parsed.windows.rolling.usedPercent, 42)
  assert.equal(parsed.windows.weekly.usedPercent, 12)
  assert.equal(parsed.windows.monthly.usedPercent, 3)
  assert.equal(parsed.plan, 'GLM Coding Pro')
})

test('kimi-coding-usage：按 window.duration 归位（300=5h / 10080=周）', () => {
  const parsed = parseBody(
    'kimi-coding-usage',
    {
      limits: [
        { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, remaining: 75, resetTime: '2026-10-15T14:45:00Z' } },
        { window: { duration: 10080, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 1000, remaining: 400 } },
      ],
    },
    {},
  )
  assert.equal(parsed.windows.rolling.usedPercent, 25)
  assert.equal(parsed.windows.weekly.usedPercent, 60)
})

test('minimax-remains：remaining_percent 语义换算成已用', () => {
  const parsed = parseBody(
    'minimax-remains',
    {
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: 'MiniMax-M2', current_interval_remaining_percent: 94, end_time: 1760539500000 }],
    },
    {},
  )
  assert.equal(parsed.windows.rolling.usedPercent, 6)
})

test('上游错误响应会让该行抛错（不静默当 0）', () => {
  assert.throws(() => parseBody('deepseek-balance', { balance_infos: [] }, {}))
  assert.throws(() => parseBody('zai-coding-quota', { code: 401, msg: 'unauthorized' }, {}))
  assert.throws(() => parseBody('opencode-usage', { usage: {} }, {}))
})

test('目录里每个条目的 format 都有解析器', () => {
  for (const entry of CATALOG) {
    if (entry.source === 'account') {
      // 账户型供应商不走 HTTP 适配器，余额来自宿主账号服务
      assert.equal(entry.id, 'deepseek-account')
      assert.equal(entry.defaultMode, 'on', 'DeepSeek Account 默认常驻显示')
      continue
    }
    assert.ok(KNOWN_FORMATS.includes(entry.format), `${entry.id} 的 format ${entry.format} 未注册`)
    assert.ok(Array.isArray(entry.refs) && entry.refs.length > 0, `${entry.id} 缺少凭据引用`)
    assert.match(entry.endpoint, /^https:\/\//, `${entry.id} 的 endpoint 非法`)
  }
  // DeepSeek API 与 DeepSeek Account 是两个独立的供应商
  const ids = CATALOG.map((entry) => entry.id)
  assert.ok(ids.includes('deepseek') && ids.includes('deepseek-account'))
  assert.equal(CATALOG.find((entry) => entry.id === 'deepseek').label, 'DeepSeek API')
  assert.equal(CATALOG.find((entry) => entry.id === 'deepseek-account').label, 'DeepSeek Account')
})

// ---------------------------------------------------------------------------
// 凭据名别名 —— 「已配置却显示未配置凭据」的根因回归
// ---------------------------------------------------------------------------

test('opencode-go 同时接受 DSH 与天枢两种凭据名', () => {
  // DSH 的 llm-pi-ai 用 OPENCODE_GO_API_KEY；天枢 provider-presets 用 OPENCODE_GO_KEY
  assert.deepEqual(REF_ALIASES['opencode-go'], ['OPENCODE_GO_KEY'])
  const entry = resolveEntries(normalizeConfig({})).find((item) => item.id === 'opencode-go')
  assert.deepEqual(entry.refs, ['OPENCODE_GO_API_KEY', 'OPENCODE_GO_KEY'])
})

test('mergeRefs：去重且保留声明顺序', () => {
  assert.deepEqual(mergeRefs(['A', 'B'], ['B', 'C', 'A']), ['A', 'B', 'C'])
  assert.deepEqual(mergeRefs(undefined, ['X']), ['X'])
})

test('describeRef：报「配没配」而不返回值', async () => {
  const hit = makeCtx({ credentials: { MY_KEY: 'secret-value' } })
  const info = await describeRef(hit.ctx, 'MY_KEY', {})
  assert.deepEqual(info, { present: true, source: 'file', writable: true })
  assert.ok(!JSON.stringify(info).includes('secret-value'), 'describe 结果不得含密钥值')

  const miss = makeCtx({})
  const absent = await describeRef(miss.ctx, 'NOPE', {})
  assert.equal(absent.present, false)

  // 服务没有 describe 实现时返回 present=null（表示「无法判定」，调用方应继续尝试解析）
  const bare = makeCtx({})
  delete bare.ctx.credentials.describe
  const unknown = await describeRef(bare.ctx, 'NOPE', {})
  assert.equal(unknown.present, null)
})

test('classifyError：稳定错误码', () => {
  assert.equal(classifyError(new Error('HTTP 401 · Authentication Fails')), 'auth')
  assert.equal(classifyError(new Error('HTTP 429 too many requests')), 'rate-limit')
  assert.equal(classifyError(new Error('请求超时（15000 ms）')), 'timeout')
  assert.equal(classifyError(new Error('fetch failed')), 'network')
  assert.equal(classifyError(new Error('响应不是合法 JSON')), 'invalid-response')
  assert.equal(classifyError(new Error('HTTP 502 Bad Gateway')), 'unavailable')
})

test('宿主路由：只有天枢命名的凭据时也能认出来（别名生效）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ usage: { rolling: { status: 'ok', percent: 8, resetsAt: null } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  // 只有 OPENCODE_GO_KEY（天枢叫法），没有 OPENCODE_GO_API_KEY（DSH 叫法）
  const { ctx, routes, disposeAll } = makeCtx({ credentials: { OPENCODE_GO_KEY: 'tianshu-style-key' } })
  try {
    await install(ctx, { refreshMs: 60000, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const row = summary.body.providers.find((item) => item.id === 'opencode-go')
    assert.equal(row.status, 'ok', '用别名里的名字也要能读到')
    assert.equal(row.credentialRef, 'OPENCODE_GO_KEY')
    const second = row.refsTried.find((item) => item.ref === 'OPENCODE_GO_KEY')
    assert.equal(second.present, true)
    assert.equal(second.used, true)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('宿主路由：未配置时逐个候选名给出「已设置/未设置」，并汇总进 probe.refs', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('should not fetch without credential')
  }
  // 凭据库里存在 OPENCODE_GO_KEY，但 resolve 故意拿不到（模拟「describe 说配了、解析为空」）
  const { ctx, routes, disposeAll } = makeCtx({ credentials: {}, known: ['OPENCODE_GO_KEY'] })
  try {
    await install(ctx, { refreshMs: 60000, showUnconfigured: true, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const row = summary.body.providers.find((item) => item.id === 'opencode-go')
    assert.equal(row.status, 'unconfigured')
    const api = row.refsTried.find((item) => item.ref === 'OPENCODE_GO_API_KEY')
    const key = row.refsTried.find((item) => item.ref === 'OPENCODE_GO_KEY')
    assert.equal(api.present, false, 'DSH 名字没配 → 未设置')
    assert.equal(key.present, true, '天枢名字配了 → 已设置')
    assert.equal(key.used, undefined)
    assert.equal(summary.body.probe.refs['OPENCODE_GO_KEY'].present, true)
    assert.equal(summary.body.probe.refs['OPENCODE_GO_API_KEY'].present, false)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('宿主路由：窗口带 period / remainingPercent / label（对齐天枢词表）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent: 8, resetsAt: '2026-10-15T14:45:00.000Z' },
          weekly: { status: 'ok', percent: 5, resetsAt: null },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  const { ctx, routes, disposeAll } = makeCtx({ credentials: { OPENCODE_GO_API_KEY: 'k' } })
  try {
    await install(ctx, { refreshMs: 60000, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const row = summary.body.providers.find((item) => item.id === 'opencode-go')
    assert.equal(row.kind, 'subscription', "'usage' 应归一成 'subscription'")
    assert.equal(row.provider, 'opencode-go', '应带 ProviderUsageAccount.provider 字段')
    assert.equal(row.providerLabel, 'OpenCode Go')
    assert.equal(row.windows.rolling.period, '5h')
    assert.equal(row.windows.rolling.remainingPercent, 92)
    assert.equal(row.windows.rolling.label, '5 小时额度')
    assert.equal(row.windows.weekly.period, '7d')
    assert.equal(row.errorCode, null)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('宿主路由：错误行带 errorCode', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('Authentication Fails', { status: 401 })
  const { ctx, routes, disposeAll } = makeCtx({ credentials: { OPENCODE_GO_API_KEY: 'bad' } })
  try {
    await install(ctx, { refreshMs: 60000, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const row = summary.body.providers.find((item) => item.id === 'opencode-go')
    assert.equal(row.status, 'error')
    assert.equal(row.errorCode, 'auth')
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// 配置归一化
// ---------------------------------------------------------------------------

test('normalizeConfig：坏值回退默认，refreshMs 有 60s 下限', () => {
  const cfg = normalizeConfig({ refreshMs: 100, timeoutMs: 'x', hide: 'nope', providers: [] })
  assert.equal(cfg.refreshMs, 5 * 60 * 1000)
  assert.equal(cfg.timeoutMs, 15000)
  assert.deepEqual(cfg.hide, [])
  assert.deepEqual(cfg.providers, {})
  assert.equal(cfg.enabled, true)
})

test('resolveEntries：可以隐藏目录条目，也可以新增自定义供应商', () => {
  const entries = resolveEntries(
    normalizeConfig({
      hide: ['xai'],
      providers: {
        'my-gateway': { label: '自建网关', endpoint: 'https://gw.example/v1/credits', format: 'openrouter-credits', refs: ['MY_KEY'] },
      },
    }),
  )
  assert.ok(!entries.some((entry) => entry.id === 'xai'))
  const custom = entries.find((entry) => entry.id === 'my-gateway')
  assert.ok(custom, '自定义供应商应被合入')
  assert.equal(custom.label, '自建网关')
})

test('resolveEntries：缺少 endpoint/format 的自定义条目被忽略', () => {
  const entries = resolveEntries(normalizeConfig({ providers: { broken: { label: 'x' } } }))
  assert.ok(!entries.some((entry) => entry.id === 'broken'))
})

// ---------------------------------------------------------------------------
// 宿主路由端到端（假 fetch）
// ---------------------------------------------------------------------------

test('宿主路由：/summary 返回真实解析结果，未配置的供应商标为 unconfigured', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, auth: options?.headers?.Authorization })
    if (String(url).includes('opencode.ai')) {
      return new Response(
        JSON.stringify({
          usage: {
            rolling: { status: 'ok', percent: 8, resetsAt: '2026-10-15T14:45:00.000Z' },
            weekly: { status: 'ok', percent: 5, resetsAt: '2026-10-19T00:00:00.000Z' },
            monthly: { status: 'ok', percent: 2, resetsAt: '2026-11-15T03:43:15.000Z' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  }

  const { ctx, routes, disposeAll } = makeCtx({ credentials: { OPENCODE_GO_API_KEY: 'test-key' }, account: fakeAccount() })
  try {
    await install(ctx, { refreshMs: 60000, showUnconfigured: true, statePath: stateFile() })
    assert.equal(routes.length, 1, '应注册一条 prefix 路由')
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, API_PREFIX)

    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    assert.equal(summary.status, 200)

    const ocgo = summary.body.providers.find((row) => row.id === 'opencode-go')
    assert.equal(ocgo.status, 'ok')
    assert.equal(ocgo.credentialRef, 'OPENCODE_GO_API_KEY')
    assert.equal(ocgo.windows.rolling.usedPercent, 8)
    assert.equal(ocgo.windowLabels.rolling, '5 小时额度')

    // 已配置的排在未配置之前
    const firstUnconfigured = summary.body.providers.findIndex((row) => row.status !== 'ok')
    const lastOk = summary.body.providers.map((row) => row.status).lastIndexOf('ok')
    assert.ok(firstUnconfigured > lastOk, '已配置的行应排在前面')

    const deepseek = summary.body.providers.find((row) => row.id === 'deepseek')
    assert.equal(deepseek.status, 'unconfigured')
    assert.ok(deepseek.refs.includes('DEEPSEEK_API_KEY'), '应带上 DSH 的凭据名')
    assert.ok(deepseek.refs.includes('DEEPSEEK_KEY'), '应带上别名，供面板提示逐个候选')

    // 只应该打到已配置凭据的那个供应商
    assert.equal(calls.length, 1)
    assert.equal(calls[0].auth, 'Bearer test-key')

    const refreshed = await call(routes[0].handler, 'POST', `${API_PREFIX}/refresh`)
    assert.equal(refreshed.status, 200)

    const crossOrigin = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`, {
      headers: { origin: 'http://evil.test', host: '127.0.0.1:19387' },
    })
    assert.equal(crossOrigin.status, 403)

    const sameOrigin = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`, {
      headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' },
    })
    assert.equal(sameOrigin.status, 200)

    const missing = await call(routes[0].handler, 'GET', `${API_PREFIX}/nope`)
    assert.equal(missing.status, 404)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('默认可见性：只下发「DeepSeek Account + 检测到的供应商」', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ usage: { rolling: { status: 'ok', percent: 1, resetsAt: null } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const { ctx, routes, disposeAll } = makeCtx({ credentials: { OPENCODE_GO_API_KEY: 'k' }, account: fakeAccount() })
  try {
    // 默认 showUnconfigured=false：没配密钥的供应商不该出现
    await install(ctx, { refreshMs: 60000, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    assert.equal(summary.status, 200)
    const ids = summary.body.providers.map((row) => row.id)
    assert.deepEqual(ids, ['deepseek-account', 'opencode-go'], '只应有 Account 与被检测到的 OpenCode Go')
    assert.ok(!ids.includes('deepseek'), '没配 DEEPSEEK_API_KEY 就不该出现')
    assert.ok(!ids.includes('moonshot'))

    // 设置页数据里仍然能看到全部候选（含未检测到的）
    const settings = summary.body.settings.providers
    assert.ok(settings.length >= 14, '设置页要列出全部供应商')
    const ds = settings.find((row) => row.id === 'deepseek')
    assert.equal(ds.detected, false)
    assert.equal(ds.visible, false)
    assert.equal(ds.mode, 'auto')
    const account = settings.find((row) => row.id === 'deepseek-account')
    assert.equal(account.mode, 'on')
    assert.equal(account.detected, true)
    assert.equal(account.visible, true)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('设置页：off 隐藏、on 强制显示、落盘后可重读', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('no fetch expected')
  }
  const statePath = stateFile()
  const { ctx, routes, disposeAll } = makeCtx({ credentials: { OPENCODE_GO_API_KEY: 'k' }, account: fakeAccount() })
  try {
    await install(ctx, { refreshMs: 60000, statePath })
    // 1) 关掉 Account（默认 on）
    const off = await call(routes[0].handler, 'POST', `${API_PREFIX}/settings`, {
      body: JSON.stringify({ providers: { 'deepseek-account': 'off', deepseek: 'on' } }),
    })
    assert.equal(off.status, 200)
    const after = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const ids = after.body.providers.map((row) => row.id)
    assert.ok(!ids.includes('deepseek-account'), 'off 应隐藏')
    assert.ok(ids.includes('deepseek'), 'on 应强制显示（即使没配密钥）')
    assert.ok(ids.includes('opencode-go'))

    // 2) 落盘内容可被下一轮读取
    const saved = readState(statePath)
    assert.equal(saved.providers['deepseek-account'], 'off')
    assert.equal(saved.providers.deepseek, 'on')

    // 3) 非法模式被拒绝
    const bad = await call(routes[0].handler, 'POST', `${API_PREFIX}/settings`, {
      body: JSON.stringify({ providers: { deepseek: 'maybe' } }),
    })
    assert.equal(bad.status, 500)
    assert.match(bad.body.error, /未知显示模式/)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('DeepSeek Account：走账号服务取充值/赠金余额，与 API Key 行互不干扰', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.deepseek.com')) {
      return new Response(
        JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '9.99', granted_balance: '0.99', topped_up_balance: '9.00' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const { ctx, routes, disposeAll } = makeCtx({
    credentials: { DEEPSEEK_API_KEY: 'api-key-value' },
    account: fakeAccount(),
  })
  try {
    await install(ctx, { refreshMs: 60000, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const account = summary.body.providers.find((row) => row.id === 'deepseek-account')
    const api = summary.body.providers.find((row) => row.id === 'deepseek')

    assert.equal(account.status, 'ok')
    assert.equal(account.account, true)
    assert.equal(account.amount, 23.06)
    assert.equal(account.currency, '¥')
    assert.deepEqual(account.detail, [
      ['充值余额', '¥23.06'],
      ['赠金余额', '¥23.12'],
    ])

    assert.equal(api.status, 'ok')
    assert.equal(api.amount, 9.99, 'API Key 行取自己的 /user/balance')
    assert.equal(api.account, undefined)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('DeepSeek Account：未登录 / 查询失败 / 登出都是不同状态', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('no fetch expected')
  }
  const statePath = stateFile()

  // 未登录
  {
    const { ctx, routes, disposeAll } = makeCtx({ account: fakeAccount({ signedIn: false }) })
    try {
      await install(ctx, { refreshMs: 60000, statePath })
      const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
      const row = summary.body.providers.find((item) => item.id === 'deepseek-account')
      assert.equal(row.status, 'unconfigured')
      assert.match(row.error, /未登录/)
    } finally {
      disposeAll()
    }
  }

  // 查询失败（账号服务返回 failed）
  {
    const { ctx, routes, disposeAll } = makeCtx({ account: fakeAccount({ balance: { status: 'failed' } }) })
    try {
      await install(ctx, { refreshMs: 60000, statePath })
      const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
      const row = summary.body.providers.find((item) => item.id === 'deepseek-account')
      assert.equal(row.status, 'error')
      assert.equal(row.errorCode, 'auth')
    } finally {
      disposeAll()
    }
  }

  // 抛错（网络/协议）
  {
    const { ctx, routes, disposeAll } = makeCtx({ account: fakeAccount({ fail: new Error('fetch failed') }) })
    try {
      await install(ctx, { refreshMs: 60000, statePath })
      const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
      const row = summary.body.providers.find((item) => item.id === 'deepseek-account')
      assert.equal(row.status, 'error')
      assert.equal(row.errorCode, 'network')
    } finally {
      disposeAll()
    }
  }

  // 没有账号服务（非 Desktop 组合）
  {
    const { ctx, routes, disposeAll } = makeCtx({})
    try {
      await install(ctx, { refreshMs: 60000, statePath })
      const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
      const row = summary.body.providers.find((item) => item.id === 'deepseek-account')
      assert.equal(row.status, 'unconfigured')
      assert.match(row.error, /账号服务未就绪/)
      assert.equal(summary.body.probe.accountSeam, 'none')
    } finally {
      disposeAll()
    }
  }

  globalThis.fetch = originalFetch
})

test('可见性判定：mode/检测/兜底的组合', () => {
  const config = normalizeConfig({})
  const entry = { id: 'x', defaultMode: 'auto' }
  const detected = { configured: true }
  assert.equal(modeOf(entry, {}), 'auto')
  assert.equal(modeOf({ id: 'y', defaultMode: 'on' }, {}), 'on')
  assert.equal(modeOf(entry, { x: 'off' }), 'off')
  assert.equal(isDetected(detected), true)
  assert.equal(isDetected({ refsTried: [{ ref: 'A', present: true }] }), true)
  assert.equal(isDetected({ refsTried: [{ ref: 'A', present: false }] }), false)
  assert.equal(isVisible(entry, { configured: false }, config, {}), false)
  assert.equal(isVisible(entry, { configured: true }, config, {}), true)
  assert.equal(isVisible(entry, { configured: false }, config, { x: 'on' }), true)
  assert.equal(isVisible(entry, { configured: true }, config, { x: 'off' }), false)
  assert.equal(isVisible(entry, { configured: false }, normalizeConfig({ showUnconfigured: true }), {}), true)
})

test('accountClientMetadata：版本可配置，语言与时区偏移合法', () => {
  const meta = accountClientMetadata({ accountClientVersion: '9.9.9' })
  assert.equal(meta.version, '9.9.9')
  assert.equal(meta.locale, 'zh-CN')
  assert.equal(typeof meta.timezoneOffsetSeconds, 'number')
  assert.ok(Number.isInteger(meta.timezoneOffsetSeconds))
  const fallback = accountClientMetadata({})
  assert.ok(typeof fallback.version === 'string' && fallback.version.length > 0)
})

test('宿主路由：上游报错时该行是 error 而不是崩溃', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('Authentication Fails', { status: 401 })
  const { ctx, routes, disposeAll } = makeCtx({ credentials: { OPENCODE_GO_API_KEY: 'bad' } })
  try {
    await install(ctx, { refreshMs: 60000, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const row = summary.body.providers.find((item) => item.id === 'opencode-go')
    assert.equal(row.status, 'error')
    assert.match(row.error, /HTTP 401/)
    assert.equal(row.configured, true)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// 钱包（赠金）与展示偏好
// ---------------------------------------------------------------------------

test('余额解析都给出结构化钱包：total / topUp / bonus', () => {
  const ds = parseBody(
    'deepseek-balance',
    { balance_infos: [{ currency: 'CNY', total_balance: '23.06', granted_balance: '23.12', topped_up_balance: '0.06' }] },
    {},
  )
  assert.deepEqual(ds.wallet, { currency: '¥', total: 23.06, topUp: 0.06, bonus: 23.12 })

  const or = parseBody('openrouter-credits', { data: { total_credits: 30, total_usage: 4.5 } }, {})
  assert.equal(or.wallet.total, 25.5)
  assert.equal(or.wallet.bonus, 0, '没有赠金的供应商 bonus=0')

  const step = parseBody('stepfun-accounts', { balance: 8, total_cash_balance: 3, total_voucher_balance: 5 }, {})
  assert.equal(step.wallet.bonus, 5)
  assert.equal(step.wallet.topUp, 3)
})

test('DeepSeek Account 行带 wallet（充值钱包是 total，赠金单独累加）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('no fetch expected')
  }
  const { ctx, routes, disposeAll } = makeCtx({
    account: fakeAccount({
      balance: {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '-0.06' }],
        bonusWallets: [
          { currency: 'CNY', balance: '10.31' },
          { currency: 'CNY', balance: '1.00' },
        ],
      },
    }),
  })
  try {
    await install(ctx, { refreshMs: 60000, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const row = summary.body.providers.find((item) => item.id === 'deepseek-account')
    assert.equal(row.wallet.total, -0.06)
    assert.equal(row.wallet.bonus, 11.31, '多笔赠金要累加')
    assert.equal(row.amount, -0.06)
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('normalizePrefs：阈值上下界钳制，坏值退回默认', () => {
  const defaults = normalizePrefs(null)
  assert.equal(defaults.followModel, true)
  assert.equal(defaults.bonusFirst, true)
  assert.equal(defaults.bonusInColor, true)
  assert.deepEqual(defaults.balance, { healthy: 20, warn: 5 })
  assert.deepEqual(defaults.quota, { preferred: 'rolling', healthy: 20, warn: 5 })
  // 警告线不得高于充足线
  const clamped = normalizePrefs({ balance: { healthy: 10, warn: 99 }, quota: { healthy: 30, warn: -5 } })
  assert.equal(clamped.balance.warn, 10)
  assert.equal(clamped.quota.warn, 0)
  // 非法窗口退回 rolling；开关 false 生效
  const bad = normalizePrefs({ quota: { preferred: 'yearly' }, followModel: false, bonusFirst: false, bonusInColor: false })
  assert.equal(bad.quota.preferred, 'rolling')
  assert.equal(bad.followModel, false)
  assert.equal(bad.bonusFirst, false)
  assert.equal(bad.bonusInColor, false)
})

test('设置页：prefs 部分更新 + 落盘重读', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('no fetch expected')
  }
  const statePath = stateFile()
  const { ctx, routes, disposeAll } = makeCtx({ credentials: { OPENCODE_GO_API_KEY: 'k' }, account: fakeAccount() })
  try {
    await install(ctx, { refreshMs: 60000, statePath })

    const res = await call(routes[0].handler, 'POST', `${API_PREFIX}/settings`, {
      body: JSON.stringify({ prefs: { bonusFirst: false, quota: { preferred: 'weekly', healthy: 30, warn: 10 } } }),
    })
    assert.equal(res.status, 200)
    // 未提到的字段保持原值
    assert.equal(res.body.prefs.bonusFirst, false)
    assert.equal(res.body.prefs.bonusInColor, true)
    assert.equal(res.body.prefs.followModel, true)
    assert.equal(res.body.prefs.balance.healthy, 20)
    assert.equal(res.body.prefs.quota.preferred, 'weekly')
    assert.equal(res.body.prefs.quota.healthy, 30)

    const saved = readState(statePath)
    assert.equal(saved.prefs.quota.preferred, 'weekly')
    assert.equal(saved.prefs.bonusFirst, false)

    const got = await call(routes[0].handler, 'GET', `${API_PREFIX}/settings`)
    assert.equal(got.body.prefs.quota.warn, 10)
    assert.ok(got.body.providers.length >= 14, '设置页仍要列出全部供应商')
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})

test('行里带 sessionProviders，供卡片跟随当前对话的模型商', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('no fetch expected')
  }
  const { ctx, routes, disposeAll } = makeCtx({ account: fakeAccount() })
  try {
    await install(ctx, { refreshMs: 60000, statePath: stateFile() })
    const summary = await call(routes[0].handler, 'GET', `${API_PREFIX}/summary`)
    const byId = Object.fromEntries(summary.body.settings.providers.map((row) => [row.id, row]))
    assert.ok(byId.deepseek.sessionProviders.includes('deepseek-official'), 'API Key 路由对应 deepseek-official')
    assert.ok(byId['deepseek-account'].sessionProviders.includes('deepseek-account'))
    assert.ok(byId['opencode-go'].sessionProviders.includes('opencode-go'))
    assert.ok(byId['kimi-coding'].sessionProviders.includes('kimi'))
  } finally {
    disposeAll()
    globalThis.fetch = originalFetch
  }
})
