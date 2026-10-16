/**
 * dsh-model-quota — 实现（目录 + 解析 + 状态仓库 + HTTP 路由 + 周期刷新）。
 *
 * 本文件由入口 `lib/index.js` 以带缓存击穿的动态导入加载：
 * 端口建成 `import('./impl.js?v=<stamp>')`，因此每次 profile 重组（改
 * cordis.patch.yml / package.json）都会重新求值本模块——本机 HMR 默认
 * `root: []` 只监听配置文件不监听模块源码，这是让改代码无需重启应用
 * 即可生效的办法。
 *
 * @module dsh-model-quota/impl
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'


// ==========================================================================
// 供应商目录与额度解析（原 lib/providers.js）
// ==========================================================================


/** 请求超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 15000

/**
 * 内置供应商目录。顺序即面板默认展示顺序（已配置的会排到前面）。
 * refs 按优先级排列：命中第一个可解析的凭据引用即用。
 */
export const CATALOG = [
  {
    id: 'deepseek-account',
    // 账户型：余额来自 DSH 的 DeepSeek 账号登录态（ctx.deepseekAccount），不是 API Key。
    // 默认常驻显示（即使其它供应商都没配）。
    source: 'account',
    defaultMode: 'on',
    label: 'DeepSeek Account',
    hint: 'DSH 以账号身份接入（充值余额 / 赠金余额）',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek API',
    hint: '独立 API Key 的账户余额',
    refs: ['DEEPSEEK_API_KEY'],
    endpoint: 'https://api.deepseek.com/user/balance',
    format: 'deepseek-balance',
  },
  {
    id: 'moonshot',
    label: 'Moonshot 开放平台',
    hint: 'Kimi 开放平台余额',
    refs: ['MOONSHOT_API_KEY'],
    endpoint: 'https://api.moonshot.cn/v1/users/me/balance',
    format: 'moonshot-balance',
    currency: '¥',
  },
  {
    id: 'kimi-coding',
    label: 'Moonshot Kimi Code 订阅',
    hint: 'Kimi Code 套餐窗口',
    refs: ['KIMI_API_KEY', 'KIMI_CODE_API_KEY'],
    endpoint: 'https://api.kimi.com/coding/v1/usages',
    format: 'kimi-coding-usage',
    windowLabels: { rolling: '5 小时额度', weekly: '每周额度' },
  },
  {
    id: 'glm',
    label: 'GLM 开放平台',
    hint: '智谱开放平台配额',
    refs: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    format: 'zhipu-quota',
  },
  {
    id: 'glm-coding-cn',
    label: 'GLM Coding 套餐（国内）',
    hint: '智谱 Coding Plan 5 小时 / 每周窗口',
    refs: ['GLM_CODING_API_KEY', 'ZAI_CODING_CN_API_KEY'],
    endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    format: 'zai-coding-quota',
    windowLabels: { rolling: '5 小时额度', weekly: '每周额度', monthly: '每月额度' },
  },
  {
    id: 'zai-coding',
    label: 'Z.AI GLM Coding（国际）',
    hint: 'Z.AI Coding Plan 窗口',
    refs: ['ZAI_API_KEY'],
    endpoint: 'https://api.z.ai/api/monitor/usage/quota/limit',
    format: 'zai-coding-quota',
    windowLabels: { rolling: '5 小时额度', weekly: '每周额度', monthly: '每月额度' },
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    hint: '订阅额度：5 小时滚动 / 每周 / 每月',
    refs: ['OPENCODE_GO_API_KEY'],
    endpoint: 'https://opencode.ai/zen/go/v1/usage',
    format: 'opencode-usage',
    windowLabels: { rolling: '5 小时额度', weekly: '每周额度', monthly: '每月额度' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: '按量计费余额',
    refs: ['OPENROUTER_API_KEY'],
    endpoint: 'https://openrouter.ai/api/v1/credits',
    format: 'openrouter-credits',
    currency: '$',
  },
  {
    id: 'siliconflow-cn',
    label: 'SiliconFlow（国内）',
    hint: '按量计费余额',
    refs: ['SILICONFLOW_CN_API_KEY', 'SILICONFLOW_API_KEY'],
    endpoint: 'https://api.siliconflow.cn/v1/user/info',
    format: 'siliconflow-balance',
    currency: '¥',
  },
  {
    id: 'minimax',
    label: 'MiniMax Coding（国际）',
    hint: 'Coding 套餐窗口',
    refs: ['MINIMAX_API_KEY'],
    endpoint: 'https://www.minimax.io/v1/token_plan/remains',
    format: 'minimax-remains',
    windowLabels: { rolling: '5 小时额度', weekly: '每周额度' },
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax Coding（国内）',
    hint: 'Coding 套餐窗口',
    refs: ['MINIMAX_CN_API_KEY'],
    endpoint: 'https://api.minimaxi.com/v1/token_plan/remains',
    format: 'minimax-remains',
    windowLabels: { rolling: '5 小时额度', weekly: '每周额度' },
  },
  {
    id: 'stepfun',
    label: 'StepFun 阶跃星辰',
    hint: '账户余额',
    refs: ['STEPFUN_API_KEY', 'STEP_API_KEY'],
    endpoint: 'https://api.stepfun.com/v1/accounts',
    format: 'stepfun-accounts',
    currency: '¥',
  },
  {
    id: 'xai',
    label: 'xAI',
    hint: '按量计费余额',
    refs: ['XAI_API_KEY'],
    endpoint: 'https://api.x.ai/v1/billing/credits',
    format: 'xai-credits',
    currency: '$',
  },
]

/** 目录索引：id → 条目。 */
export const CATALOG_BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]))

/**
 * 各供应商的候选凭据引用别名。
 *
 * 「已配置却显示未配置凭据」几乎都出在这里：同一家的 key 在不同工具里
 * 名字不一样，只认一个名字就会误判。例如 OpenCode Go——
 *   DSH（llm-pi-ai 的 apiKeyEnv）用 `OPENCODE_GO_API_KEY`，
 *   天枢（Tianshu-harness `provider-presets.ts`）用 `OPENCODE_GO_KEY`。
 * 因此每个供应商都按「自己的名字 → 常见别名」依次尝试，并把逐个尝试的
 * 结果放进快照诊断，面板会直接告诉你哪个名字命中、哪个是空的。
 *
 * 只列**同一把 key 的不同写法**；语义不同的 key 不互相别名
 * （例如 Moonshot 开放平台的按量 key 与 Kimi Code 订阅 key 是两个体系）。
 */
export const REF_ALIASES = {
  deepseek: ['DEEPSEEK_KEY'],
  moonshot: ['MOONSHOT_KEY'],
  'kimi-coding': ['KIMI_CODE_API_KEY', 'KIMI_CODING_API_KEY'],
  glm: ['ZHIPU_KEY'],
  'glm-coding-cn': ['GLM_CODING_CN_API_KEY', 'ZHIPU_CODING_API_KEY'],
  'zai-coding': ['Z_AI_API_KEY'],
  'opencode-go': ['OPENCODE_GO_KEY'],
  openrouter: ['OPENROUTER_KEY'],
  'siliconflow-cn': ['SILICONFLOW_KEY', 'SILICONFLOW_CN_KEY'],
  minimax: ['MINIMAX_CODING_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_KEY', 'MINIMAXI_API_KEY'],
  stepfun: ['STEP_API_KEY'],
  xai: ['GROK_API_KEY', 'X_API_KEY'],
}

/**
 * 会话里的「模型商名」（`modelDirectories` 给出的 provider id）→ 本插件的供应商 id。
 *
 * 侧栏卡片要跟随当前对话所选模型商，靠的就是这张映射表：会话里的 provider
 * 叫 `deepseek-official` / `deepseek-account` / `opencode-go`…… 与本插件的
 * 目录 id 不是一一对应（`deepseek-official` 对应 API Key 那条）。
 */
export const SESSION_PROVIDERS = {
  'deepseek-account': ['deepseek-account'],
  deepseek: ['deepseek-official', 'deepseek'],
  moonshot: ['moonshot'],
  'kimi-coding': ['kimi', 'kimi-coding'],
  glm: ['glm', 'zhipu', 'bigmodel'],
  'glm-coding-cn': ['glm-coding', 'zai-coding-cn', 'glm-coding-cn'],
  'zai-coding': ['zai', 'zai-coding'],
  'opencode-go': ['opencode-go'],
  openrouter: ['openrouter'],
  'siliconflow-cn': ['siliconflow', 'siliconflow-cn'],
  minimax: ['minimax'],
  'minimax-cn': ['minimax-cn'],
  stepfun: ['stepfun'],
  xai: ['xai', 'grok'],
}

/**
 * 把任意数值格式化成展示文本。
 * @param {unknown} value - 原始值（可能是字符串）。
 * @param {string} currency - 货币符号，可为空。
 * @param {number} [digits] - 小数位。
 * @returns {string} 展示文本；不可解析时返回空串。
 */
export function money(value, currency = '', digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  const sign = n < 0 ? '-' : ''
  const body = Math.abs(n).toFixed(digits)
  return `${sign}${currency}${body}`
}

/** 把上游时间值（ISO 字符串、秒或毫秒时间戳）归一成 ISO 字符串。 */
export function toIso(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') {
    const direct = new Date(value)
    if (!Number.isNaN(direct.getTime())) return direct.toISOString()
    const n = Number(value)
    if (!Number.isFinite(n)) return undefined
    return new Date(n > 1e12 ? n : n * 1000).toISOString()
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

/** 归一化窗口：上游「已用百分比」语义。 */
function windowFromUsed(usedPercent, resetsAt, extra = {}) {
  const n = Number(usedPercent)
  return {
    usedPercent: Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null,
    resetsAt: toIso(resetsAt),
    ...extra,
  }
}

/** 归一化窗口：上游「剩余百分比」语义。 */
function windowFromRemaining(remainingPercent, resetsAt, extra = {}) {
  const n = Number(remainingPercent)
  return {
    usedPercent: Number.isFinite(n) ? Math.min(100, Math.max(0, 100 - Math.round(n))) : null,
    resetsAt: toIso(resetsAt),
    ...extra,
  }
}

/** 计数窗口：limit/used（used 缺失时用 limit-remaining 反推）。 */
function windowFromCounts(limit, used, remaining, resetsAt) {
  const l = Number(limit)
  let u = Number(used)
  if (!Number.isFinite(u)) {
    const r = Number(remaining)
    if (Number.isFinite(r)) u = l - r
  }
  if (!(l > 0) || !Number.isFinite(u)) return undefined
  return windowFromUsed((u / l) * 100, resetsAt)
}

// ---------------------------------------------------------------------------
// 各上游响应解析器：抛出 Error 即视为该行失败（面板显示错误态，不影响其他行）
// ---------------------------------------------------------------------------

const PARSERS = {
  /** DeepSeek 官方：{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] } */
  'deepseek-balance'(body) {
    const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : undefined
    if (!info) throw new Error('响应中没有 balance_infos')
    const amount = Number(info.total_balance)
    if (!Number.isFinite(amount)) throw new Error('balance_infos[0].total_balance 不是数字')
    const currency = String(info.currency ?? '').toUpperCase() === 'USD' ? '$' : '¥'
    const toppedUp = Number(info.topped_up_balance)
    const granted = Number(info.granted_balance)
    return {
      kind: 'balance',
      amount,
      currency,
      caption: '账户余额',
      // wallet 是结构化钱包：total=总余额、topUp=充值、bonus=赠金
      wallet: {
        currency,
        total: amount,
        topUp: Number.isFinite(toppedUp) ? toppedUp : null,
        bonus: Number.isFinite(granted) ? granted : 0,
      },
      detail: [
        ['充值余额', money(info.topped_up_balance, currency)],
        ['赠送余额', money(info.granted_balance, currency)],
      ],
      windows: {},
    }
  },

  /** Moonshot 开放平台：{ code, data: { available_balance | total_balance, voucher_balance, cash_balance } } */
  'moonshot-balance'(body) {
    const data = body?.data ?? body
    const amount = Number(data?.total_balance ?? data?.available_balance)
    if (!Number.isFinite(amount)) throw new Error('响应中没有 total_balance / available_balance')
    const currency = '$'
    const cash = Number(data?.cash_balance)
    const voucher = Number(data?.voucher_balance)
    const detail = []
    if (data?.cash_balance !== undefined) detail.push(['现金余额', money(data.cash_balance, currency)])
    if (data?.voucher_balance !== undefined) detail.push(['代金券', money(data.voucher_balance, currency)])
    return {
      kind: 'balance',
      amount,
      currency,
      caption: '账户余额',
      wallet: {
        currency,
        total: amount,
        topUp: Number.isFinite(cash) ? cash : null,
        bonus: Number.isFinite(voucher) ? voucher : 0,
      },
      detail,
      windows: {},
    }
  },

  /** OpenRouter：{ data: { total_credits, total_usage } } */
  'openrouter-credits'(body) {
    const credits = Number(body?.data?.total_credits)
    const usage = Number(body?.data?.total_usage)
    if (!Number.isFinite(credits) || !Number.isFinite(usage)) throw new Error('响应中没有 data.total_credits / total_usage')
    return {
      kind: 'balance',
      amount: credits - usage,
      currency: '$',
      caption: '剩余额度',
      wallet: { currency: '$', total: credits - usage, topUp: credits, bonus: 0 },
      detail: [
        ['已购额度', money(credits, '$')],
        ['已用额度', money(usage, '$')],
      ],
      windows: {},
    }
  },

  /** SiliconFlow：{ data: { balance, chargeBalance, totalUsage } } */
  'siliconflow-balance'(body, entry) {
    const amount = Number(body?.data?.balance)
    if (!Number.isFinite(amount)) throw new Error('响应中没有 data.balance')
    const currency = entry?.currency ?? '¥'
    const charge = Number(body?.data?.chargeBalance)
    return {
      kind: 'balance',
      amount,
      currency,
      caption: '账户余额',
      wallet: { currency, total: amount, topUp: Number.isFinite(charge) ? charge : null, bonus: 0 },
      detail: [
        ['充值余额', money(body?.data?.chargeBalance, currency)],
        ['累计消费', money(body?.data?.totalUsage, currency)],
      ],
      windows: {},
    }
  },

  /** StepFun：{ balance, total_cash_balance, total_voucher_balance } */
  'stepfun-accounts'(body) {
    const amount = Number(body?.balance)
    if (!Number.isFinite(amount)) throw new Error('响应中没有 balance')
    const cash = Number(body?.total_cash_balance)
    const voucher = Number(body?.total_voucher_balance)
    return {
      kind: 'balance',
      amount,
      currency: '¥',
      caption: '账户余额',
      wallet: {
        currency: '¥',
        total: amount,
        topUp: Number.isFinite(cash) ? cash : null,
        bonus: Number.isFinite(voucher) ? voucher : 0,
      },
      detail: [
        ['现金余额', money(body?.total_cash_balance, '¥')],
        ['赠金余额', money(body?.total_voucher_balance, '¥')],
      ],
      windows: {},
    }
  },

  /** xAI：{ total: { val } }（单位：美分） */
  'xai-credits'(body) {
    const cents = Number(body?.total?.val)
    if (!Number.isFinite(cents)) throw new Error('响应中没有 total.val')
    return {
      kind: 'balance',
      amount: Math.abs(cents) / 100,
      currency: '$',
      caption: '剩余额度',
      wallet: { currency: '$', total: Math.abs(cents) / 100, topUp: Math.abs(cents) / 100, bonus: 0 },
      detail: [],
      windows: {},
    }
  },

  /** 智谱开放平台：{ code: 200, data: { limits: [{ remaining, number, percentage }] } } — 无余额接口，只报配额 */
  'zhipu-quota'(body) {
    if (body?.code !== 200) throw new Error(`上游返回 code=${body?.code}：${body?.msg ?? '未知'}`)
    const limits = Array.isArray(body?.data?.limits) ? body.data.limits : []
    if (limits.length === 0) throw new Error('data.limits 为空')
    const text = limits
      .map((l) => {
        if (l?.remaining !== undefined && l?.remaining !== null) return `${l.remaining}/${l.number ?? '?'}`
        if (l?.percentage !== undefined && l?.percentage !== null) return `${l.percentage}%`
        return '?'
      })
      .join(' · ')
    return { kind: 'info', text, caption: '配额剩余/总数', detail: [], windows: {} }
  },

  /** Z.AI / 智谱 Coding：TOKENS_LIMIT(unit 3=5h, 6=周) + CREDIT_LIMIT + TIME_LIMIT(月) */
  'zai-coding-quota'(body) {
    if (body?.code !== 200) throw new Error(`上游返回 code=${body?.code}：${body?.msg ?? '未知'}`)
    const limits = Array.isArray(body?.data?.limits) ? body.data.limits : []
    if (limits.length === 0) throw new Error('data.limits 为空')
    const percentOf = (l) => {
      const p = Number(l?.percentage)
      if (Number.isFinite(p)) return Math.min(100, Math.max(0, Math.round(p)))
      return undefined
    }
    const countPercentOf = (l) => {
      const used = Number(l?.currentValue)
      const total = Number(l?.usage)
      if (Number.isFinite(used) && Number.isFinite(total) && total > 0) return Math.round((used / total) * 100)
      return undefined
    }
    const tokens = limits.filter((l) => l?.type === 'TOKENS_LIMIT')
    const credits = limits.filter((l) => l?.type === 'CREDIT_LIMIT')
    const time = limits.find((l) => l?.type === 'TIME_LIMIT')
    const byUnit = (unit) => tokens.find((l) => Number(l?.unit) === unit) ?? credits.find((l) => Number(l?.unit) === unit)
    let rolling = byUnit(3)
    let weekly = byUnit(6)
    if (!rolling && !weekly) {
      const pool = tokens.length > 0 ? tokens : credits
      const sorted = [...pool].sort((a, b) => Number(a?.nextResetTime ?? Infinity) - Number(b?.nextResetTime ?? Infinity))
      rolling = sorted[0]
      weekly = sorted.length > 1 ? sorted[sorted.length - 1] : undefined
    }
    const mk = (l) => {
      if (!l) return undefined
      const p = percentOf(l) ?? countPercentOf(l)
      return { usedPercent: p === undefined ? null : p, resetsAt: toIso(l?.nextResetTime) }
    }
    const windows = {}
    const w1 = mk(rolling)
    const w2 = weekly && weekly !== rolling ? mk(weekly) : undefined
    const w3 = time ? mk(time) : undefined
    if (w1) windows.rolling = w1
    if (w2) windows.weekly = w2
    if (w3) windows.monthly = w3
    if (Object.keys(windows).length === 0) throw new Error('响应中没有可用的额度窗口')
    const plan = body?.data?.planName ?? body?.data?.plan ?? body?.data?.packageName
    return { kind: 'usage', plan, caption: '', detail: [], windows }
  },

  /** Kimi Code 订阅：limits[].window.duration(300=5h,10080=周) + detail{limit,used,remaining} */
  'kimi-coding-usage'(body) {
    const limits = Array.isArray(body?.limits) ? body.limits : []
    const byDuration = (minutes) =>
      limits.find(
        (l) => Number(l?.window?.duration) === minutes && String(l?.window?.timeUnit ?? 'TIME_UNIT_MINUTE') === 'TIME_UNIT_MINUTE',
      )
    const fromDetail = (detail) => {
      if (!detail) return undefined
      return windowFromCounts(detail.limit, detail.used, detail.remaining, detail.resetTime)
    }
    const windows = {}
    const rolling = fromDetail(byDuration(300)?.detail)
    if (rolling) windows.rolling = rolling
    let weekly = fromDetail(byDuration(10080)?.detail)
    if (!weekly && body?.usage) {
      weekly = windowFromCounts(body.usage.limit, body.usage.used, body.usage.remaining, body.usage.resetTime)
    }
    if (weekly) windows.weekly = weekly
    if (Object.keys(windows).length === 0) throw new Error('响应中没有可用的额度窗口')
    return { kind: 'usage', caption: '', detail: [], windows }
  },

  /** MiniMax Coding：{ base_resp, model_remains: [{ current_interval_remaining_percent, ... }] } */
  'minimax-remains'(body) {
    const status = Number(body?.base_resp?.status_code)
    if (Number.isFinite(status) && status !== 0) throw new Error(`上游返回 ${status}：${body?.base_resp?.status_msg ?? '未知'}`)
    const remains = Array.isArray(body?.model_remains) ? body.model_remains : []
    if (remains.length === 0) throw new Error('model_remains 为空')
    const nameOf = (m) => String(m?.model_name ?? m?.model ?? '')
    const coding = remains.find((m) => nameOf(m).startsWith('MiniMax-M')) ?? remains[0]
    const pick = (m) => {
      const pctRemaining = Number(m?.current_interval_remaining_percent)
      if (Number.isFinite(pctRemaining)) return windowFromRemaining(pctRemaining, m?.end_time ?? m?.remains_time)
      return windowFromCounts(
        m?.current_interval_total_count,
        undefined,
        m?.current_interval_remaining_count ?? m?.current_interval_usage_count,
        m?.end_time ?? m?.remains_time,
      )
    }
    const rolling = pick(coding) ?? remains.map(pick).find(Boolean)
    if (!rolling) throw new Error('model_remains 中没有可解析的窗口')
    const windows = { rolling }
    const weeklyTotal = Number(coding?.current_weekly_total_count)
    const weeklyRemaining = Number(coding?.current_weekly_usage_count)
    if (weeklyTotal > 0 && Number.isFinite(weeklyRemaining)) {
      windows.weekly = windowFromCounts(weeklyTotal, undefined, weeklyRemaining, coding?.weekly_end_time)
    }
    const plan = body?.current_subscribe_title ?? body?.plan_name ?? body?.plan
    return { kind: 'usage', plan, caption: '', detail: [], windows }
  },

  /** OpenCode Go：{ usage: { rolling|weekly|monthly: { status, percent(已用), resetsAt } } } */
  'opencode-usage'(body) {
    const usage = body?.usage
    if (!usage || typeof usage !== 'object') throw new Error('响应中没有 usage')
    const windows = {}
    for (const key of ['rolling', 'weekly', 'monthly']) {
      const cell = usage[key]
      if (!cell) continue
      const p = Number(cell.percent)
      if (!Number.isFinite(p)) continue
      windows[key] = windowFromUsed(p, cell.resetsAt, { status: cell.status })
    }
    if (Object.keys(windows).length === 0) throw new Error('usage 中没有可解析的窗口')
    return { kind: 'usage', caption: '', detail: [], windows }
  },
}

/**
 * 按 format 解析上游响应体。
 * @param {string} format - 解析器名。
 * @param {unknown} body - JSON 响应体。
 * @param {object} entry - 目录条目（提供 currency / windowLabels 等）。
 * @returns {object} 归一化结果。
 */
export function parseBody(format, body, entry) {
  const parser = PARSERS[format]
  if (!parser) throw new Error(`未知的响应格式：${format}`)
  const parsed = parser(body, entry)
  return {
    kind: 'balance',
    amount: null,
    currency: entry?.currency ?? '',
    caption: '',
    detail: [],
    windows: {},
    wallet: null,
    ...parsed,
  }
}

/** 已注册的响应格式名（供配置校验）。 */
export const KNOWN_FORMATS = Object.keys(PARSERS)

/**
 * 请求一个供应商的额度接口并解析。
 * @param {object} entry - 目录条目（可被配置覆盖）。
 * @param {string} credential - 已解析出的密钥明文（仅存在于宿主进程内）。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<object>} 归一化结果。
 */
export async function fetchProvider(entry, credential, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(entry.endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: 'application/json',
        'User-Agent': 'dsh-model-quota/1.0',
        ...(entry.headers ?? {}),
      },
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const snippet = text.replace(/\s+/g, ' ').slice(0, 160)
      throw new Error(`HTTP ${res.status}${snippet ? ` · ${snippet}` : ''}`)
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('响应不是合法 JSON')
    }
    return parseBody(entry.format, body, entry)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`请求超时（${timeoutMs} ms）`)
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
}

// hmr-probe


// ==========================================================================
// 宿主半：状态仓库 / HTTP 路由 / 周期刷新（原 lib/index.js）
// ==========================================================================



/** 稳定的插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'dsh-model-quota'

/** HTTP 路由前缀。 */
export const API_PREFIX = '/dsh-model-quota/api'

/** 默认刷新周期：5 分钟（与面板页脚「前台每 5 分钟更新」一致）。 */
export const DEFAULT_REFRESH_MS = 5 * 60 * 1000

/** 手动刷新的最小间隔，避免连点打爆上游。 */
export const MANUAL_COOLDOWN_MS = 2000

/** 请求体上限（读取 POST body 用）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 配置默认值。 */
export const DEFAULTS = {
  enabled: true,
  refreshMs: DEFAULT_REFRESH_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  // 默认「只显示检测到的」：DeepSeek Account 常驻，其余配了才出现
  showUnconfigured: false,
  primary: 'deepseek-account',
  hide: [],
  providers: {},
  accountClientVersion: null,
  statePath: null,
}

/**
 * 归一化插件配置（宽容：坏值退回默认，不阻断加载）。
 * @param {object} raw - cordis 传入的原始配置。
 * @returns {object} 归一化配置。
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const refreshMs = Number(src.refreshMs)
  const timeoutMs = Number(src.timeoutMs)
  return {
    enabled: src.enabled !== false,
    // 下限 60s：面板是「看额度」而不是监控，没必要更密
    refreshMs: Number.isFinite(refreshMs) && refreshMs >= 60000 ? Math.round(refreshMs) : DEFAULTS.refreshMs,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? Math.round(timeoutMs) : DEFAULTS.timeoutMs,
    showUnconfigured: src.showUnconfigured === true,
    primary: typeof src.primary === 'string' && src.primary ? src.primary : DEFAULTS.primary,
    hide: Array.isArray(src.hide) ? src.hide.filter((id) => typeof id === 'string') : [],
    providers: src.providers && typeof src.providers === 'object' && !Array.isArray(src.providers) ? src.providers : {},
    accountClientVersion: typeof src.accountClientVersion === 'string' && src.accountClientVersion ? src.accountClientVersion : null,
    statePath: typeof src.statePath === 'string' && src.statePath ? src.statePath : null,
  }
}

/** 显示模式取值。 */
export const MODES = ['auto', 'on', 'off']

/** 状态文件默认位置（`$DSH_HOME/dsh-model-quota/state.json`，人可读可删）。 */
export function defaultStatePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-model-quota', 'state.json')
}

/**
 * 展示偏好默认值（可在设置页改，存进状态文件的 prefs 段）。
 *   followModel   卡片跟随当前对话所选的模型商（关掉则用 primary）
 *   bonusFirst    有未用完的赠金时优先显示赠金
 *   bonusInColor  告警颜色是否按「赠金优先、用完回落余额」计算
 *   balance      余额告警阈值（货币单位）：>=healthy 绿、>=warn 黄、其余红、<=0 灰
 *   quota        额度阈值（百分比）与优先展示的窗口
 */
export const DEFAULT_PREFS = {
  followModel: true,
  bonusFirst: true,
  bonusInColor: true,
  balance: { healthy: 20, warn: 5 },
  quota: { preferred: 'rolling', healthy: 20, warn: 5 },
}

/** 可选的额度窗口键。 */
export const QUOTA_PERIODS = ['rolling', 'weekly', 'monthly']

/** 取有限数字，否则退回默认。 */
function numOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 归一化展示偏好（坏值退回默认，绝不抛）。
 * @param {object} raw - 原始偏好。
 * @returns {object} 归一化偏好。
 */
export function normalizePrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const balance = src.balance && typeof src.balance === 'object' ? src.balance : {}
  const quota = src.quota && typeof src.quota === 'object' ? src.quota : {}
  const healthy = numOr(balance.healthy, DEFAULT_PREFS.balance.healthy)
  const warn = numOr(balance.warn, DEFAULT_PREFS.balance.warn)
  const qHealthy = numOr(quota.healthy, DEFAULT_PREFS.quota.healthy)
  const qWarn = numOr(quota.warn, DEFAULT_PREFS.quota.warn)
  return {
    followModel: src.followModel !== false,
    bonusFirst: src.bonusFirst !== false,
    bonusInColor: src.bonusInColor !== false,
    balance: {
      healthy: Math.max(0, healthy),
      // 警告线不得高于充足线，否则颜色判定会自相矛盾
      warn: Math.min(Math.max(0, warn), Math.max(0, healthy)),
    },
    quota: {
      preferred: QUOTA_PERIODS.includes(quota.preferred) ? quota.preferred : DEFAULT_PREFS.quota.preferred,
      healthy: Math.min(100, Math.max(0, qHealthy)),
      warn: Math.min(Math.max(0, qWarn), Math.min(100, Math.max(0, qHealthy))),
    },
  }
}

/**
 * 读取持久化状态（不存在/损坏都退回默认，不影响插件启动）。
 * @param {string} statePath - 状态文件路径。
 * @returns {{providers: Record<string, string>, prefs: object}} 状态。
 */
export function readState(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    const providers = parsed && typeof parsed.providers === 'object' && parsed.providers ? parsed.providers : {}
    const clean = {}
    for (const [id, mode] of Object.entries(providers)) {
      if (typeof id === 'string' && MODES.includes(mode)) clean[id] = mode
    }
    return { providers: clean, prefs: normalizePrefs(parsed?.prefs) }
  } catch {
    return { providers: {}, prefs: normalizePrefs(null) }
  }
}

/**
 * 原子写入显示开关与偏好（先写临时文件再改名）。
 * @param {string} statePath - 状态文件路径。
 * @param {object} state - 状态。
 */
export function writeState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ version: 2, ...state }, null, 2)}\n`, 'utf8')
  renameSync(tmp, statePath)
}

/**
 * 该条目当前应有的显示模式：状态文件 → 目录默认 → auto。
 * @param {object} entry - 目录条目。
 * @param {Record<string, string>} modes - 持久化的模式表。
 * @returns {'auto'|'on'|'off'} 模式。
 */
export function modeOf(entry, modes) {
  const stored = modes[entry.id]
  if (MODES.includes(stored)) return stored
  return entry.defaultMode === 'on' ? 'on' : 'auto'
}

/**
 * 条目是否被检测为「已配置」。
 * @param {object} row - 探测结果行。
 * @returns {boolean} 已配置。
 */
export function isDetected(row) {
  if (!row) return false
  if (row.configured) return true
  if (row.accountSignedIn) return true
  return Array.isArray(row.refsTried) && row.refsTried.some((item) => item.present === true)
}

/**
 * 行是否展示：显式 on 一定显示、off 一定隐藏、auto 看检测结果；
 * showUnconfigured=true 时退回「全部列出」。
 * @param {object} entry - 目录条目。
 * @param {object} row - 探测结果行。
 * @param {object} config - 归一化配置。
 * @param {Record<string, string>} modes - 模式表。
 * @returns {boolean} 是否展示。
 */
export function isVisible(entry, row, config, modes) {
  const mode = modeOf(entry, modes)
  if (mode === 'off') return false
  if (mode === 'on') return true
  if (isDetected(row)) return true
  return config.showUnconfigured === true
}

/**
 * 合成生效的供应商行：目录 + 配置覆盖（配置可新增目录之外的供应商）。
 * @param {object} config - 归一化配置。
 * @returns {object[]} 条目列表。
 */
export function resolveEntries(config) {
  const hidden = new Set(config.hide)
  const entries = []
  const seen = new Set()

  for (const base of CATALOG) {
    if (hidden.has(base.id)) continue
    const override = config.providers[base.id]
    const merged = { ...base, ...(override && typeof override === 'object' ? override : {}) }
    merged.refs = mergeRefs(merged.refs, REF_ALIASES[base.id])
    merged.sessionProviders = mergeRefs(merged.sessionProviders, SESSION_PROVIDERS[base.id])
    entries.push(merged)
    seen.add(base.id)
  }
  for (const [id, override] of Object.entries(config.providers)) {
    if (seen.has(id) || hidden.has(id)) continue
    const merged = { ...override, id }
    if (!merged.endpoint || !merged.format || !Array.isArray(merged.refs)) continue
    if (!KNOWN_FORMATS.includes(merged.format)) continue
    merged.refs = mergeRefs(merged.refs, REF_ALIASES[id])
    merged.sessionProviders = mergeRefs(merged.sessionProviders, SESSION_PROVIDERS[id])
    entries.push(merged)
  }
  return entries
}

/**
 * 合并候选凭据引用并去重（保持声明顺序：配置里写在前面的优先）。
 * @param {string[]} [primary] - 条目自己的 refs。
 * @param {string[]} [aliases] - 等价别名。
 * @returns {string[]} 去重后的引用列表。
 */
export function mergeRefs(primary, aliases) {
  const out = []
  for (const ref of [...(primary ?? []), ...(aliases ?? [])]) {
    if (typeof ref !== 'string' || !ref || out.includes(ref)) continue
    out.push(ref)
  }
  return out
}

/**
 * 经凭据缝解析一个引用；缝不可用时退回进程环境变量。
 *
 * cordis 的服务访问受「注入门禁」保护：没声明过依赖的上下文直接读
 * `ctx.credentials` 会抛错，所以这里优先使用 {@link createRuntime} 通过
 * `ctx.inject(['credentials'])` 捕获到的服务实例。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {string} ref - 凭据引用名（形如 DEEPSEEK_API_KEY）。
 * @param {object} [runtime] - 运行时探测状态（记录诊断信息）。
 * @returns {Promise<{ref: string, value: string, source: string}|null>} 命中的凭据（值仅留在宿主内存）。
 */
export async function resolveRef(ctx, ref, runtime) {
  const service = credentialService(ctx, runtime)
  if (service && typeof service.resolve === 'function') {
    try {
      const hit = await service.resolve(ref)
      const value = typeof hit?.value === 'string' ? hit.value : ''
      if (value) return { ref, value, source: hit?.source ?? 'credentials' }
    } catch (error) {
      if (runtime) runtime.lastResolveError = error instanceof Error ? error.message : String(error)
    }
  }
  const env = process.env?.[ref]
  if (typeof env === 'string' && env) return { ref, value: env, source: 'env' }
  return null
}

/**
 * 取凭据服务实例。cordis 的门禁意味着只有 `ctx.inject(['credentials'])`
 * 捕获到的实例可用，直接读 `ctx.credentials` 会抛
 * `cannot get property "credentials" without inject`（已实测）。
 * @param {object} ctx - cordis 上下文。
 * @param {object} [runtime] - 运行时状态。
 * @returns {object|null} 凭据服务。
 */
function credentialService(ctx, runtime) {
  if (runtime?.credentials) return runtime.credentials
  try {
    const direct = ctx?.credentials
    if (direct && typeof direct.resolve === 'function') {
      if (runtime) runtime.source = 'direct'
      return direct
    }
  } catch (error) {
    if (runtime) runtime.seamError = error instanceof Error ? error.message : String(error)
  }
  return null
}

/**
 * 只问「这个引用配没配」而不取值（凭据缝的 `describe` 永不返回值）。
 * 用于把「已配置却显示未配置」变成可诊断的事实：逐个候选引用给出
 * 存在性与来源，面板直接展示。
 * @param {object} ctx - cordis 上下文。
 * @param {string} ref - 凭据引用名。
 * @param {object} [runtime] - 运行时状态。
 * @returns {Promise<{present: boolean|null, source: string|null, writable?: boolean|null}>} present=null 表示无法判定（应继续尝试解析）。
 */
export async function describeRef(ctx, ref, runtime) {
  const service = credentialService(ctx, runtime)
  if (service && typeof service.describe === 'function') {
    try {
      const info = await service.describe(ref)
      return {
        present: info?.configured === true,
        source: typeof info?.source === 'string' ? info.source : null,
        writable: typeof info?.writable === 'boolean' ? info.writable : null,
      }
    } catch (error) {
      if (runtime) runtime.lastDescribeError = error instanceof Error ? error.message : String(error)
      // describe 不可用 / 实现缺失 → 不阻断，交给 resolve 判定
      return { present: null, source: null }
    }
  }
  if (process.env?.[ref]) return { present: true, source: 'env', writable: false }
  return { present: null, source: null }
}

/**
 * 建立运行时探测状态：异步捕获凭据缝（服务可能在插件挂载之后才就绪）。
 * @param {object} ctx - cordis 上下文。
 * @returns {object} 状态对象（含诊断字段，不含任何密钥值）。
 */
export function createRuntime(ctx) {
  const runtime = {
    credentials: null,
    account: null,
    source: 'none',
    seamError: null,
    lastResolveError: null,
    lastDescribeError: null,
    lastAccountError: null,
  }
  try {
    ctx.inject(['credentials'], (credentialCtx) => {
      runtime.credentials = credentialCtx.credentials
      runtime.source = 'inject'
    })
  } catch (error) {
    runtime.seamError = error instanceof Error ? error.message : String(error)
  }
  // DeepSeek 账号（DSH 登录身份）服务：可能比本插件晚挂载，故同样用 inject 捕获
  try {
    ctx.inject(['deepseekAccount'], (accountCtx) => {
      runtime.account = accountCtx.deepseekAccount
    })
  } catch (error) {
    runtime.lastAccountError = error instanceof Error ? error.message : String(error)
  }
  return runtime
}

/**
 * 账户余额请求的客户端身份元数据（Platform `x-client-*` 头由宿主据此推导）。
 * 官方 UI 也是传一个构建版本常量，因此这里允许配置覆盖 + 环境变量兜底。
 * @param {object} config - 归一化配置。
 * @returns {{version: string, locale: string, timezoneOffsetSeconds: number}} 元数据。
 */
export function accountClientMetadata(config) {
  return {
    version: config?.accountClientVersion || process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '0.2.0-rc.2',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * 探测 DeepSeek 账号余额（账户型供应商，不走 API Key）。
 * 数据来自 DSH 自己的账号服务：`getState()` 判断登录态，`getBalance()` 取
 * 充值钱包与赠金钱包；`null` 表示已登出，`status:'failed'` 表示查询失败
 * ——两者都与「余额为 0」严格区分。
 * @param {object} entry - 目录条目。
 * @param {object} runtime - 运行时状态。
 * @param {object} config - 归一化配置。
 * @returns {Promise<object>} 探测结果行。
 */
async function probeAccount(entry, runtime, config) {
  const base = {
    id: entry.id,
    provider: entry.id,
    label: entry.label ?? entry.id,
    providerLabel: entry.label ?? entry.id,
    hint: entry.hint ?? '',
    refs: [],
    refsTried: [],
    windowLabels: {},
    account: true,
  }
  const service = runtime.account
  if (!service) {
    return {
      ...base,
      configured: false,
      accountSignedIn: false,
      credentialRef: null,
      status: 'unconfigured',
      error: runtime.lastAccountError ?? '账号服务未就绪（deepseekAccount 未挂载）',
      errorCode: 'unavailable',
      updatedAt: Date.now(),
    }
  }
  let state
  try {
    state = await service.getState()
  } catch (error) {
    return {
      ...base,
      configured: false,
      accountSignedIn: false,
      credentialRef: null,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      errorCode: classifyError(error),
      updatedAt: Date.now(),
    }
  }
  const credentialRef = 'deepseek-account-platform/default'
  if (state?.status !== 'credential-stored') {
    return {
      ...base,
      configured: false,
      accountSignedIn: false,
      credentialRef,
      status: 'unconfigured',
      error: '未登录 DeepSeek 账号（设置 → 账号与余额 里登录）',
      errorCode: null,
      updatedAt: Date.now(),
    }
  }
  let result
  try {
    result = await service.getBalance(accountClientMetadata(config))
  } catch (error) {
    return {
      ...base,
      configured: true,
      accountSignedIn: true,
      credentialRef,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      errorCode: classifyError(error),
      updatedAt: Date.now(),
    }
  }
  if (result === null || result === undefined) {
    return {
      ...base,
      configured: false,
      accountSignedIn: false,
      credentialRef,
      status: 'unconfigured',
      error: '账号已登出',
      errorCode: null,
      updatedAt: Date.now(),
    }
  }
  if (result.status !== 'ready') {
    return {
      ...base,
      configured: true,
      accountSignedIn: true,
      credentialRef,
      status: 'error',
      error: '账号余额查询失败（登录态可能已失效）',
      errorCode: 'auth',
      updatedAt: Date.now(),
    }
  }
  const wallets = Array.isArray(result.value) ? result.value : []
  const bonuses = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
  const main = wallets[0]
  const amount = Number(main?.balance)
  const currency = String(main?.currency ?? '').toUpperCase() === 'USD' ? '$' : '¥'
  const bonusTotal = bonuses.reduce((sum, wallet) => {
    const n = Number(wallet?.balance)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)
  const detail = []
  for (const wallet of wallets) detail.push(['充值余额', money(wallet.balance, wallet.currency === 'USD' ? '$' : '¥')])
  bonuses.forEach((wallet, index) => {
    const symbol = wallet.currency === 'USD' ? '$' : '¥'
    detail.push([bonuses.length > 1 ? `赠金余额 ${index + 1}` : '赠金余额', money(wallet.balance, symbol)])
  })
  return {
    ...base,
    configured: true,
    accountSignedIn: true,
    credentialRef,
    status: 'ok',
    error: null,
    errorCode: null,
    updatedAt: Date.now(),
    kind: 'balance',
    amount: Number.isFinite(amount) ? amount : null,
    currency,
    caption: '账户余额',
    // 充值钱包是 total（法律意义上的余额），赠金单独记
    wallet: {
      currency,
      total: Number.isFinite(amount) ? amount : null,
      topUp: Number.isFinite(amount) ? amount : null,
      bonus: bonusTotal,
    },
    detail,
    windows: {},
  }
}

/**
 * 按候选顺序找一个可用凭据，同时记录每个候选的存在性诊断。
 * @param {object} ctx - cordis 上下文。
 * @param {string[]} refs - 候选引用。
 * @param {object} [runtime] - 运行时状态。
 * @returns {Promise<{ref: string, value: string, source: string}|null>} 命中的凭据。
 */
async function firstRef(ctx, refs, runtime) {
  for (const ref of refs ?? []) {
    if (typeof ref !== 'string' || !ref) continue
    const hit = await resolveRef(ctx, ref, runtime)
    if (hit) return hit
  }
  return null
}

/**
 * 逐个候选引用做「配没配」体检（纯诊断，不阻断探测）。
 * @param {object} ctx - cordis 上下文。
 * @param {string[]} refs - 候选引用。
 * @param {object} [runtime] - 运行时状态。
 * @returns {Promise<object[]>} 每个候选的存在性与来源。
 */
async function inspectRefs(ctx, refs, runtime) {
  const attempts = []
  for (const ref of refs ?? []) {
    if (typeof ref !== 'string' || !ref) continue
    const info = await describeRef(ctx, ref, runtime)
    const envPresent = Boolean(process.env?.[ref])
    attempts.push({
      ref,
      present: info.present === null ? envPresent || null : info.present,
      source: info.source ?? (envPresent ? 'env' : null),
    })
  }
  return attempts
}

/**
 * 把上游错误归类成稳定错误码（对齐 Tianshu-harness `ProviderUsageError`）。
 * @param {Error} error - 上游错误。
 * @returns {string} auth | rate-limit | timeout | network | invalid-response | unavailable | unknown
 */
export function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/HTTP 401|HTTP 403|unauthor|invalid.*token|token.*invalid|authentication/i.test(message)) return 'auth'
  if (/HTTP 429|rate.?limit/i.test(message)) return 'rate-limit'
  if (/超时|timeout|abort/i.test(message)) return 'timeout'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(message)) return 'network'
  if (/不是合法 JSON|invalid.*json|Unexpected token/i.test(message)) return 'invalid-response'
  if (/HTTP 5\d\d|上游返回 code/i.test(message)) return 'unavailable'
  if (/响应中|为空|不是数字|缺少/.test(message)) return 'invalid-response'
  return 'unknown'
}

/**
 * 创建额度状态仓库：串行刷新 + 快照读取 + 单行刷新。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 归一化配置。
 * @param {object} [runtime] - 凭据缝探测状态。
 * @returns {object} 仓库。
 */
export function createStore(ctx, config, runtime) {
  const entries = resolveEntries(config)
  const statePath = config.statePath ?? defaultStatePath()
  /** @type {Map<string, object>} id → 已探测行 */
  const rows = new Map()
  const persisted = readState(statePath)
  /** @type {Record<string, 'auto'|'on'|'off'>} 持久化的显示模式 */
  let modes = persisted.providers
  /** 展示偏好（阈值 / 赠金优先 / 跟随模型 / 额度优先项） */
  let prefs = persisted.prefs
  let updatedAt = 0
  let lastError = null
  let inflight = null
  let lastManualAt = 0

  /** 未配置凭据时的占位行。 */
  /** 窗口键 → 周期 id（对齐 Tianshu-harness 的 `ProviderQuotaPeriod` 词表）。 */
  const PERIODS = { rolling: '5h', weekly: '7d', monthly: 'monthly' }

  /** 窗口默认显示名。 */
  const PERIOD_LABELS = { rolling: '5 小时额度', weekly: '每周额度', monthly: '每月额度' }

  /** 行的公共字段（含对齐 Tianshu `ProviderUsageAccount` 的 provider/providerLabel）。 */
  function baseRow(entry) {
    return {
      id: entry.id,
      provider: entry.id,
      label: entry.label ?? entry.id,
      providerLabel: entry.label ?? entry.id,
      hint: entry.hint ?? '',
      // 只下发凭据「名字」提示去哪配，绝不下发值
      refs: Array.isArray(entry.refs) ? entry.refs : [],
      // 会话里该模型商的 provider 名（卡片跟随当前对话时用来配对）
      sessionProviders: Array.isArray(entry.sessionProviders) ? entry.sessionProviders : [],
      windowLabels: { ...PERIOD_LABELS, ...(entry.windowLabels && typeof entry.windowLabels === 'object' ? entry.windowLabels : {}) },
    }
  }

  /** 把解析出的窗口补上周期 id / 剩余百分比 / 显示名。 */
  function serializeWindows(parsed, entry) {
    const labels = { ...PERIOD_LABELS, ...(entry.windowLabels && typeof entry.windowLabels === 'object' ? entry.windowLabels : {}) }
    const out = {}
    for (const [key, win] of Object.entries(parsed.windows ?? {})) {
      if (!win) continue
      const used = win.usedPercent
      out[key] = {
        ...win,
        period: PERIODS[key] ?? 'quota',
        remainingPercent: used === null || used === undefined ? null : 100 - used,
        label: labels[key] ?? key,
      }
    }
    return out
  }

  /** 未配置凭据时的占位行（带逐个候选引用的体检结果）。 */
  function unconfiguredRow(entry, refsTried = []) {
    return {
      ...baseRow(entry),
      configured: false,
      credentialRef: null,
      status: 'unconfigured',
      error: null,
      errorCode: null,
      refsTried,
      updatedAt: 0,
    }
  }

  /** 探测单个条目：账户型走账号服务；其余先做凭据体检，再打上游接口。 */
  async function probe(entry) {
    if (entry.source === 'account') return probeAccount(entry, runtime, config)
    const refsTried = await inspectRefs(ctx, entry.refs, runtime)
    const hit = await firstRef(ctx, entry.refs, runtime)
    if (!hit) return unconfiguredRow(entry, refsTried)

    const used = refsTried.find((item) => item.ref === hit.ref)
    if (used) {
      used.present = true
      used.source = hit.source
      used.used = true
    }

    const common = { ...baseRow(entry), configured: true, credentialRef: hit.ref, credentialSource: hit.source, refsTried }
    try {
      const parsed = await fetchProvider(entry, hit.value, config.timeoutMs)
      return {
        ...common,
        status: 'ok',
        error: null,
        errorCode: null,
        updatedAt: Date.now(),
        // 'usage' → 'subscription'、'info' → 'unsupported'：对齐 Tianshu 的 kind 词表
        kind: parsed.kind === 'usage' ? 'subscription' : parsed.kind === 'info' ? 'unsupported' : parsed.kind,
        amount: parsed.amount,
        currency: parsed.currency,
        caption: parsed.caption,
        wallet: parsed.wallet ?? null,
        detail: parsed.detail,
        windows: serializeWindows(parsed, entry),
        plan: parsed.plan,
        text: parsed.text,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...common,
        status: 'error',
        error: message,
        errorCode: classifyError(error),
        updatedAt: Date.now(),
      }
    }
  }

  /** 全量刷新（并发探测，逐行独立失败）。 */
  async function refreshAll() {
    const results = await Promise.all(entries.map((entry) => probe(entry).catch((error) => ({
      ...unconfiguredRow(entry),
      status: 'error',
      configured: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: classifyError(error),
    }))))
    rows.clear()
    for (const row of results) rows.set(row.id, row)
    updatedAt = Date.now()
    lastError = results.some((row) => row.status === 'error') ? '部分供应商读取失败' : null
    return snapshot()
  }

  /** 启动一次刷新（并发去重）。 */
  function refresh() {
    if (inflight) return inflight
    inflight = refreshAll().finally(() => {
      inflight = null
    })
    return inflight
  }

  /** 手动刷新：带冷却，冷却中直接返回当前快照。 */
  function refreshManual() {
    const now = Date.now()
    if (now - lastManualAt < MANUAL_COOLDOWN_MS) return Promise.resolve(snapshot())
    lastManualAt = now
    return refresh()
  }

  /** 顺序：已配置(ok) → 报错 → 未配置；primary 置顶。 */
  function orderedRows() {
    const list = entries.map((entry) => rows.get(entry.id) ?? { ...unconfiguredRow(entry), status: 'loading' })
    const rank = (row) => (row.status === 'ok' ? 0 : row.status === 'error' ? 1 : row.status === 'loading' ? 2 : 3)
    list.sort((a, b) => rank(a) - rank(b))
    if (config.primary) {
      const index = list.findIndex((row) => row.id === config.primary)
      if (index > 0) list.unshift(list.splice(index, 1)[0])
    }
    return list
  }

  /** 每个条目的显示设置（设置页与诊断共用）。 */
  function settingsRows() {
    return entries.map((entry) => {
      const row = rows.get(entry.id)
      const mode = modeOf(entry, modes)
      const detected = isDetected(row)
      return {
        id: entry.id,
        label: entry.label ?? entry.id,
        hint: entry.hint ?? '',
        refs: Array.isArray(entry.refs) ? entry.refs : [],
        sessionProviders: Array.isArray(entry.sessionProviders) ? entry.sessionProviders : [],
        account: entry.source === 'account',
        mode,
        detected,
        visible: isVisible(entry, row, config, modes),
        status: row?.status ?? 'loading',
        credentialRef: row?.credentialRef ?? null,
      }
    })
  }

  /**
   * 改设置并落盘：显示模式（providers）与展示偏好（prefs）都可部分更新。
   * @param {object} patch - `{ providers?: {...}, prefs?: {...} }`。
   * @returns {object[]} 最新设置行。
   */
  function setSettings(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('请求体缺少设置内容')
    const known = new Set(entries.map((entry) => entry.id))
    const nextModes = { ...modes }
    if (patch.providers !== undefined) {
      if (!patch.providers || typeof patch.providers !== 'object') throw new Error('providers 必须是对象')
      for (const [id, mode] of Object.entries(patch.providers)) {
        if (!known.has(id)) continue
        if (!MODES.includes(mode)) throw new Error(`未知显示模式：${id}=${String(mode)}`)
        nextModes[id] = mode
      }
    }
    const nextPrefs = patch.prefs === undefined ? prefs : { ...prefs, ...patch.prefs }
    modes = nextModes
    prefs = normalizePrefs(nextPrefs)
    writeState(statePath, { providers: modes, prefs })
    return settingsRows()
  }

  /** 汇总所有候选凭据引用的存在性（诊断用，不含值）。 */
  function refStatus() {
    const out = {}
    for (const row of rows.values()) {
      for (const item of row.refsTried ?? []) {
        if (!out[item.ref]) out[item.ref] = { present: item.present, source: item.source, usedBy: [] }
        if (item.used && !out[item.ref].usedBy.includes(row.id)) out[item.ref].usedBy.push(row.id)
      }
    }
    return out
  }

  /** 当前快照（下发给浏览器）。 */
  function snapshot() {
    const providers = orderedRows().filter((row) => {
      const entry = entries.find((item) => item.id === row.id)
      return entry ? isVisible(entry, row, config, modes) : true
    })
    return {
      updatedAt,
      refreshing: inflight !== null,
      lastError,
      config: {
        refreshMs: config.refreshMs,
        showUnconfigured: config.showUnconfigured,
        primary: config.primary,
      },
      // 诊断信息（不含任何密钥值）：凭据缝怎么拿到的、每个候选引用配没配、
      // 上次解析/体检报错。这一块就是「已配置却显示未配置」的取证入口。
      probe: {
        seam: runtime?.source ?? 'none',
        seamError: runtime?.seamError ?? null,
        lastResolveError: runtime?.lastResolveError ?? null,
        lastDescribeError: runtime?.lastDescribeError ?? null,
        accountSeam: runtime?.account ? 'inject' : 'none',
        lastAccountError: runtime?.lastAccountError ?? null,
        envRefs: entries.flatMap((entry) => (entry.refs ?? []).filter((ref) => Boolean(process.env?.[ref]))),
        refs: refStatus(),
      },
      // 显示设置：设置页读这一份；providers 里是「当前实际展示」的行
      settings: { statePath, prefs, providers: settingsRows() },
      providers,
    }
  }

  /** 首次快照就绪（客户端首屏等待）。 */
  function ready() {
    return updatedAt > 0 ? Promise.resolve(snapshot()) : refresh().then(() => snapshot())
  }

  return { entries, refresh, refreshManual, refreshAll, snapshot, ready, probe, settingsRows, setSettings, statePath }
}

/** 读取请求体（带上限），返回解析后的 JSON 或 undefined。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 统一 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 同源校验：带 Origin 的跨站请求一律拒绝（本路由只服务本机 Web GUI）。 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  const host = req.headers?.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 插件主体：注册状态仓库、HTTP 路由与周期刷新。
 * @param {object} ctx - cordis 上下文。
 * @param {object} [rawConfig] - 插件配置。
 */
export function install(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  const runtime = createRuntime(ctx)
  const store = createStore(ctx, config, runtime)

  // HTTP 路由：webServer 只在 Web 宿主存在，故动态注入。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const path = url.pathname
            try {
              if (!sameOrigin(req)) return sendJson(res, 403, { error: '跨站请求被拒绝' })
              if (req.method === 'GET' && path === `${API_PREFIX}/summary`) {
                const snapshot = await store.ready()
                return sendJson(res, 200, snapshot)
              }
              if (req.method === 'POST' && path === `${API_PREFIX}/refresh`) {
                await readJsonBody(req).catch(() => undefined)
                const snapshot = await store.refreshManual()
                return sendJson(res, 200, snapshot)
              }
              // 显示设置：设置页读
              if (req.method === 'GET' && path === `${API_PREFIX}/settings`) {
                await store.ready()
                const snapshot = store.snapshot()
                return sendJson(res, 200, {
                  statePath: store.statePath,
                  prefs: snapshot.settings.prefs,
                  providers: snapshot.settings.providers,
                })
              }
              // 显示设置：改显示模式（auto/on/off）与展示偏好（阈值/赠金/跟随模型）
              if (req.method === 'POST' && path === `${API_PREFIX}/settings`) {
                const body = await readJsonBody(req)
                if (!body || typeof body !== 'object') return sendJson(res, 400, { error: '请求体必须是 JSON 对象' })
                const providers = store.setSettings({
                  providers: body.providers,
                  prefs: body.prefs,
                })
                await store.refresh()
                return sendJson(res, 200, { statePath: store.statePath, prefs: store.snapshot().settings.prefs, providers })
              }
              if (req.method === 'GET' && path === `${API_PREFIX}/providers`) {
                return sendJson(res, 200, {
                  providers: store.entries.map((entry) => ({ id: entry.id, label: entry.label ?? entry.id, refs: entry.refs ?? [] })),
                })
              }
              return sendJson(res, 404, { error: `未知端点：${req.method} ${path}` })
            } catch (error) {
              return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      'dsh-model-quota: routes',
    )
  })

  // 周期刷新：前台每 N 分钟更新（与客户端页脚文案同源）。
  ctx.effect(
    () => {
      let disposed = false
      const tick = () => {
        if (disposed) return
        void store.refresh().catch((error) => {
          console.error('[dsh-model-quota] 刷新失败：', error)
        })
      }
      // 首刷延后 3s，避开宿主启动高峰
      const first = setTimeout(tick, 3000)
      const timer = setInterval(tick, config.refreshMs)
      return () => {
        disposed = true
        clearTimeout(first)
        clearInterval(timer)
      }
    },
    'dsh-model-quota: poll',
  )
}
