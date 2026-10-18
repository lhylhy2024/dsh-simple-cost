/**
 * dsh-simple-cost —— Host 半边。
 *
 * 为什么逻辑必须在 Host 侧：
 *   - 逐轮 token 用量只存在于 Host 的会话日志里（`ctx.sessions.get(id).snapshotEvents()`，
 *     不在内存的会话则回落到 `ctx.sessionPersistence.readRaw(id)` 的落盘 JSONL），
 *     浏览器半边只能看到「已经分页/被压缩改写过的窗口」；
 *   - 账户钱包的凭据只能经 credentials 缝（`ctx.credentials`）或 `ctx.deepseekAccount` 拿到
 *     （「only Host consumers can obtain a request credential」）；
 *   - AI 分析要跑 `ctx.llm.stream`，而客户端 Remote 面里的 `llm` namespace
 *     只暴露 discoverModels / listProviders / listConfigurableProviders，没有任何生成接口。
 *
 * 客户端半边拿不到新能力，所以这里自己注册两条回环 HTTP 路由（127.0.0.1 上的 webServer），
 * 浏览器侧用同源 fetch 调。这与 dsh-client-modules 把自己的 bundle 挂在 webServer 上是同一条路。
 *
 * 计费口径（依据官方价目表，抓取日期 2026-10-13）：
 *   cost = 命中输入/1e6*P_hit + 未命中输入/1e6*P_miss + 输出/1e6*P_out
 *   P_* 由 (模型, 高峰|空闲) 决定；空闲价 = 高峰价 × 50%。
 *   高峰 = 北京时间周一至周五 09:00-12:00、14:00-18:00（不含中国法定节假日）。
 *   缓存写入（cacheWriteTokens）没有独立单价，按未命中输入计价。
 *
 * 加固原则：
 *   - 所有 Host 可选服务一律 `ctx.get(name)` + undefined / 方法存在性检查，没有服务就降级而不是抛穿；
 *     **本文件没有任何静态 import**：`@deepseek-ai/*` 只存在于 app.asar 里，从工作区目录静态导入
 *     会有解析失败（ERR_MODULE_NOT_FOUND）从而拖垮整个插件激活，所以依赖一律走 `ctx` 取；
 *     `webServer` 是唯一的硬依赖（写进 `inject`），其余（credentials / deepseekAccount / sessions /
 *     sessionPersistence / llm）都是可选服务，缺了只是对应功能降级；
 *   - 两条路由都限回环、限方法，任何异常都变成结构化 JSON（HTTP 200/403/405/500，用 `ok` 表达成败）；
 *   - 时段判定与价格表都可被 `config` 覆盖（见 DEFAULT_OPTIONS 的 holidays / priceOverrides）。
 */

/** 路由前缀。两条路由都是 exact，不会和随附的组合撞名。 */
const ROUTE_BASE = '/dsh-simple-cost'
/** 余额接口的默认 base url；实际使用的地址见 `apiBaseUrl()`（可被同名环境变量覆盖）。 */
const API_BASE = 'https://api.deepseek.com'
/** 覆盖余额接口 base url 的环境变量名，与 llm-deepseek 适配器保持一致。 */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
/**
 * 推理用的 API Key 引用 —— 就是环境变量名本身，不导入 `credentialRef`。
 * 依据：`credentialRef(value)` 的实现是 `brandString(value)`，而 `@deepseek-ai/dsh-brand`
 * 的 `brandString` 是恒等函数（「Apply a compile-time string brand without changing the value」），
 * 所以运行时它就是一个普通字符串，直接写字面量等价且零依赖。
 * 这是 llm-deepseek 适配器用的同一个引用名：设置里填过一次，这里就能直接用。
 */
const API_KEY_REF = 'DEEPSEEK_API_KEY'
const PRICE_VERSION = '2026-09-10'

/**
 * 单位：每 1,000,000 tokens。CNY 与 USD 是两套独立价目表，不要用汇率互算。
 * `hit` = 缓存命中输入（官方表里的「缓存命中 / cache hit」），
 * `miss` = 缓存未命中输入（官方表里的「缓存未命中 / cache miss」，缓存写入按它计价），
 * `out` = 输出。
 *
 * 交叉验证（2026-10-13 记）：与同类生产插件 dsh-deepseek-quota v0.5.2 的 lib/pricing.js
 * （其 2026-08-17 起生效的峰谷表）逐项对过账：
 *   - deepseek-v4-pro：peak CNY {miss 9, hit 0.3, out 27} / offPeak {4.5, 0.15, 13.5} —— 两份表完全一致；
 *   - deepseek-flash：它记的是 V4 时代的旧价 peak {3, 0.1, 9} / offPeak {1.5, 0.05, 4.5}；我们用的是
 *     2026-09-10 降价后的 V4.1-Flash 价 peak {2, 0.04, 8} / offPeak {1, 0.02, 4}（官方页面中英两版一致）。
 * 所以这里**故意不与它对齐 flash**：我们的是更新的一版。以后对账若发现官方再次调价，改这张表并同步
 * PRICE_VERSION，`config.priceOverrides` 也能在不改代码的情况下临时覆盖。
 */
const BASE_PRICES = {
  CNY: {
    'deepseek-flash': {
      hit: { peak: 0.04, off: 0.02 },
      miss: { peak: 2, off: 1 },
      out: { peak: 8, off: 4 },
    },
    'deepseek-v4-pro': {
      hit: { peak: 0.3, off: 0.15 },
      miss: { peak: 9, off: 4.5 },
      out: { peak: 27, off: 13.5 },
    },
  },
  USD: {
    'deepseek-flash': {
      hit: { peak: 0.006, off: 0.003 },
      miss: { peak: 0.3, off: 0.15 },
      out: { peak: 1.2, off: 0.6 },
    },
    'deepseek-v4-pro': {
      hit: { peak: 0.044, off: 0.022 },
      miss: { peak: 1.32, off: 0.66 },
      out: { peak: 3.96, off: 1.98 },
    },
  },
}

const SYMBOL = { CNY: '¥', USD: '$' }

/**
 * 中国法定节假日（北京时间日期）。官方原文：国务院办公厅关于 2026 年部分节假日安排的通知
 * （国办发明电〔2025〕7 号）。只做减法：周末一律空闲，调休上班的周末**仍然空闲**，
 * 因为官方规则只说「周一至周五（不含中国法定节假日）」。
 * 这里只是基线；config.holidays 可以在它之上追加（不会删减）。
 */
const BASE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

const BANDS = ['hit', 'miss', 'out']
const LEVELS = ['peak', 'off']

const DEFAULT_OPTIONS = {
  /** 单轮总 token 超过它就点亮「AI 分析」按钮。 */
  thresholdTokens: 40000,
  /** 客户端轮询间隔（毫秒），仅作为下发值。 */
  pollMs: 5000,
  /**
   * AI 分析单次最多输出多少 token。
   * 注意：deepseek-flash / v4-pro **默认开思考模式**，思考 token 也计入这个上限
   * （2026-10-13 实测：1200 时整份预算被思考吃光，`finish.reason.kind === 'max-tokens'`，
   * 只回思考不回正文）。所以这里给的是「思考 + 正文」的总量，别按正文长度设。
   */
  analysisMaxTokens: 6000,
  /** 分析用哪套路由；留空表示沿用会话自己的 provider/model。 */
  analysisProvider: null,
  analysisModel: null,
  /** 额外节假日（`YYYY-MM-DD`，北京时间），叠加在内置法定节假日表之上。 */
  holidays: [],
  /**
   * 价格覆盖：`{ CNY|USD: { <模型键>: { hit|miss|out: { peak|off: number } } } }`。
   * 只做深合并，非法（非有限正数）的值会被忽略，其余沿用内置价目表。
   */
  priceOverrides: null,
}

/** 日期键格式校验：既看形状也看是不是真实存在的日期（挡掉 2026-02-30 这种）。 */
function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

const holidaySetOf = (extra) => {
  const set = new Set(BASE_HOLIDAYS)
  if (Array.isArray(extra)) {
    for (const item of extra) {
      const key = String(item || '').trim()
      if (isDateKey(key)) set.add(key)
    }
  }
  return set
}

/** 深合并价格覆盖，逐项校验；坏值静默忽略，绝不把 NaN 带进计费。 */
function buildPriceTables(overrides) {
  const tables = {}
  for (const currency of Object.keys(BASE_PRICES)) {
    const base = BASE_PRICES[currency]
    const rows = {}
    for (const model of Object.keys(base)) {
      rows[model] = {
        hit: { ...base[model].hit },
        miss: { ...base[model].miss },
        out: { ...base[model].out },
      }
    }
    tables[currency] = rows
  }
  if (overrides !== null && typeof overrides === 'object') {
    for (const currency of Object.keys(overrides)) {
      if (tables[currency] === undefined) continue
      const patch = overrides[currency]
      if (patch === null || typeof patch !== 'object') continue
      for (const model of Object.keys(patch)) {
        const row = tables[currency][model] || (tables[currency][model] = {
          hit: { peak: NaN, off: NaN },
          miss: { peak: NaN, off: NaN },
          out: { peak: NaN, off: NaN },
        })
        const next = patch[model]
        if (next === null || typeof next !== 'object') continue
        for (const band of BANDS) {
          const values = next[band]
          if (values === null || typeof values !== 'object') continue
          for (const level of LEVELS) {
            const value = values[level]
            if (Number.isFinite(value) && value >= 0) row[band][level] = value
          }
        }
      }
    }
  }
  return tables
}

/** 把 config 规范化成一份完整、可用的选项快照（并驱动下面的派生表）。 */
function normalizeOptions(config) {
  const merged = { ...DEFAULT_OPTIONS, ...(config && typeof config === 'object' ? config : {}) }
  const threshold = Number(merged.thresholdTokens)
  const poll = Number(merged.pollMs)
  const maxTokens = Number(merged.analysisMaxTokens)
  return {
    thresholdTokens: Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_OPTIONS.thresholdTokens,
    pollMs: Number.isFinite(poll) && poll > 0 ? poll : DEFAULT_OPTIONS.pollMs,
    analysisMaxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_OPTIONS.analysisMaxTokens,
    analysisProvider: typeof merged.analysisProvider === 'string' && merged.analysisProvider.length > 0 ? merged.analysisProvider : null,
    analysisModel: typeof merged.analysisModel === 'string' && merged.analysisModel.length > 0 ? merged.analysisModel : null,
    // 额外节假日只保留合法的 `YYYY-MM-DD`（挡掉 2026-02-30 这种不存在的日期与其它脏值）。
    holidays: Array.isArray(merged.holidays) ? merged.holidays.filter(isDateKey) : [],
    priceOverrides: merged.priceOverrides !== null && typeof merged.priceOverrides === 'object' ? merged.priceOverrides : null,
  }
}

/**
 * 当前生效的规则快照。cordis 里一个 Host 半边只会 apply 一次，所以用模块级单例即可；
 * 这样 `isPeak` / `costOf` 这类纯函数不必把 options 一路透传。
 */
let ACTIVE_OPTIONS = normalizeOptions()
let HOLIDAYS = holidaySetOf(ACTIVE_OPTIONS.holidays)
let PRICE_TABLES = buildPriceTables(ACTIVE_OPTIONS.priceOverrides)

function activateOptions(config) {
  ACTIVE_OPTIONS = normalizeOptions(config)
  HOLIDAYS = holidaySetOf(ACTIVE_OPTIONS.holidays)
  PRICE_TABLES = buildPriceTables(ACTIVE_OPTIONS.priceOverrides)
  return ACTIVE_OPTIONS
}

/** 生效中的价目表（响应里的 `prices` 用它，因此 config 覆盖会对前端可见）。 */
function priceTableOf(currency) {
  return PRICE_TABLES[currency] || PRICE_TABLES.CNY
}

// ---------------------------------------------------------------- 时段判定

const pad = (n) => String(n).padStart(2, '0')

/**
 * 北京时间字段（不依赖宿主进程的 TZ）。
 * 做法：先给时间戳加 8 小时，再读 UTC 字段 —— 于是 `new Date('...Z')` 在任何 TZ 下都判定一致。
 */
function beijing(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000)
  return {
    key: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    dow: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}

/** 高峰：周一至周五（不含法定节假日）09:00-12:00 与 14:00-18:00（北京时间，左闭右开）。 */
function isPeak(date) {
  const p = beijing(date)
  if (p.dow === 0 || p.dow === 6) return false
  if (HOLIDAYS.has(p.key)) return false
  return (p.minutes >= 540 && p.minutes < 720) || (p.minutes >= 840 && p.minutes < 1080)
}

/** 下一次时段切换的绝对时间（毫秒），用于倒计时与提醒。 */
function nextSwitch(date) {
  const step = 60 * 1000
  const from = date.getTime()
  const start = Math.floor(from / step) * step
  const limit = start + 10 * 24 * 60 * step
  const now = isPeak(date)
  for (let t = start + step; t <= limit; t += step) {
    if (isPeak(new Date(t)) !== now) return t
  }
  return null
}

/**
 * 切换倒计时文案：剩余超过 1 小时按「x 小时 y 分钟」显示（整小时省掉分钟段），
 * 进入最后一小时才只说分钟。
 */
function countdownLabel(deltaMs, target) {
  const minutes = Math.max(1, Math.round(deltaMs / 60000))
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0
      ? `${hours} 小时后转为${target}时段`
      : `${hours} 小时 ${rest} 分钟后转为${target}时段`
  }
  return `${minutes} 分钟后转为${target}时段`
}

/**
 * 时段快照。
 * 只回「高峰时段 / 空闲时段」四个字 + 下一次切换的倒计时：
 * 倍数、北京时间这些字眼按用户要求（m00867）不再下发到界面上 ——
 * 时段时刻由后台每次算 `isPeak(date)` 现算，不依赖前端时钟。
 */
function phaseInfo(date) {
  const peak = isPeak(date)
  const switchAt = nextSwitch(date)
  return {
    peak,
    band: peak ? 'peak' : 'off',
    label: peak ? '高峰时段' : '空闲时段',
    hint: peak ? '高峰价，空闲时段便宜一半' : '空闲价，是高峰价的一半',
    nextSwitchAt: switchAt,
    nextSwitchLabel: switchAt === null
      ? ''
      : countdownLabel(switchAt - date.getTime(), isPeak(new Date(switchAt)) ? '高峰' : '空闲'),
  }
}

// ---------------------------------------------------------------- 计价

/**
 * 把任意模型名归一到价目表键。
 * `raw` 是仅仅小写化的原名，用于命中 config.priceOverrides 里的自定义键。
 */
function normalizeModel(model) {
  const raw = String(model || '').toLowerCase().trim()
  if (raw.includes('flash')) return { key: 'deepseek-flash', raw }
  if (raw.includes('pro')) return { key: 'deepseek-v4-pro', raw }
  // `deepseek-v4` / `v4` 是 V4 系列不带后缀的写法，按最高档（pro）计价，
  // 宁可高估也不低估；纯 chat/reasoner 才是老 flash 档。
  if (/(^|[-_/])v4($|[-_/])/.test(raw) || raw === 'v4') return { key: 'deepseek-v4-pro', raw }
  if (raw.includes('reasoner') || raw.includes('chat')) return { key: 'deepseek-flash', raw }
  return { key: 'deepseek-flash', raw }
}

const int = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/**
 * 把任意时间输入归一成 epoch 毫秒。
 * 会话事件里的 `time` 可能是数字、ISO 字符串或缺失（落盘 JSONL 回放尤其如此），
 * 而时段判定依赖真实时刻，所以这里统一收口：认不出来就退化成 `Date.now()`，
 * 绝不让 NaN 流进 `isPeak`（NaN 会让高峰判定静默变成 false，计费直接算错）。
 */
function normalizeTime(value, fallback = Date.now()) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

/** 从事件对象上取时间戳（数字或 ISO 字符串都认）。 */
function eventTimeOf(event) {
  return normalizeTime(event && event.time, null)
}

function costOf(tokens, model, currency, at) {
  const table = priceTableOf(currency)
  const { key, raw } = normalizeModel(model)
  // 先按内置键查，再按原始模型名查（config.priceOverrides 可以挂自定义键），最后退回 flash。
  const matched = table[key] || table[raw] || table['deepseek-flash']
  const modelKey = table[key] !== undefined ? key : table[raw] !== undefined ? raw : 'deepseek-flash'
  // 调用方可能传 Date、epoch 毫秒或 ISO 字符串（折叠结果里是毫秒），统一在这里归一。
  const band = isPeak(new Date(normalizeTime(at))) ? 'peak' : 'off'
  const hit = int(tokens.cacheReadTokens)
  // 缓存写入没有独立单价，与未命中输入同价。
  const miss = int(tokens.uncachedInputTokens) + int(tokens.cacheWriteTokens)
  const out = int(tokens.outputTokens)
  const inputCost = (hit / 1e6) * matched.hit[band] + (miss / 1e6) * matched.miss[band]
  const outputCost = (out / 1e6) * matched.out[band]
  return {
    currency,
    model: modelKey,
    band,
    hit,
    miss,
    out,
    inputCost,
    outputCost,
    total: inputCost + outputCost,
  }
}

// ---------------------------------------------------------------- 会话折叠

/** 与 `lastAssistantStreamChunk(stream, 'usage')` 同口径：取流里最后一条 usage 块。 */
function lastUsageInStream(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
      return record.chunk.usage
    }
  }
  return undefined
}

const zeroTokens = () => ({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
})

/** 增量累加 / 回退一份用量。`totalTokens` 永远由四分量重算，不信任上游给的总数。 */
function addTokens(target, source, sign) {
  for (const key of Object.keys(target)) {
    if (key === 'totalTokens') continue
    target[key] += sign * int(source[key])
  }
  target.totalTokens =
    target.uncachedInputTokens + target.cacheReadTokens + target.cacheWriteTokens + target.outputTokens
}

/**
 * 把一个会话的持久事件流折叠成「逐轮」用量。
 * 口径与 dsh-token-meter 的 deriveTurnTokenUsage 一致：同一 (turn, step) 的用量以最后一条为准
 * （assistant/attempt 先落，assistant/message 覆盖它），因此重试/重放不会重复计费 ——
 * 每次覆盖前先把旧的那份按 -1 回退掉。
 */
function foldTurns(events) {
  const turns = []
  const byTurn = new Map()
  const list = Array.isArray(events) ? events : []

  /** `time` 必须是已经归一化过的 epoch 毫秒（或 null）；没有时间信息就用当前时刻兜底。 */
  const ensureTurn = (turnNo, time) => {
    let t = byTurn.get(turnNo)
    if (t === undefined) {
      t = {
        turn: turnNo,
        startTime: time === null ? Date.now() : time,
        endTime: null,
        reason: null,
        steps: 0,
        steps_: new Map(),
        // 这一轮里出现过的 assistant 消息 id（去重、按出现顺序）。
        // 浏览器半边的逐轮条目只拿得到 messageId，靠它反查轮号。
        messageIds: [],
        ids_: new Set(),
        tokens: zeroTokens(),
        provider: null,
        model: null,
      }
      byTurn.set(turnNo, t)
      turns.push(t)
      turns.sort((a, b) => a.turn - b.turn)
    }
    return t
  }

  /**
   * 记下一条 assistant 消息 id。
   * 只在「这一轮已经存在」时记（`turn/start` 一定排在 `assistant/message` 前面），
   * 因此不会因为一条没有用量的消息而凭空造出一轮空记录。
   */
  const noteMessageId = (turnNo, data) => {
    const t = byTurn.get(turnNo)
    if (t === undefined) return
    const message = data.message
    const id = message !== null && typeof message === 'object' && typeof message.id === 'string' ? message.id : null
    if (id === null || id.length === 0 || t.ids_.has(id)) return
    t.ids_.add(id)
    t.messageIds.push(id)
  }

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data || {}
    // 落盘 JSONL 里的 time 可能是 ISO 字符串，这里先归一成 epoch 毫秒，避免 startTime 变成 NaN。
    const at = eventTimeOf(event)
    switch (event.type) {
      case 'turn/start': {
        const t = ensureTurn(data.turn, at)
        if (at !== null) t.startTime = at
        break
      }
      // step/start 与 step/end 都算一步；重复的 (turn,step) 靠 key 去重，不会多算。
      case 'step/start':
      case 'step/end': {
        const t = byTurn.get(data.turn)
        if (t === undefined) break
        const key = `${data.turn}/${data.step}`
        if (t.steps_.has(key)) break
        t.steps_.set(key, null)
        t.steps += 1
        break
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const usage = data.usage || lastUsageInStream(data.stream)
        // 没有用量的消息（例如被中断）也要把 id 记下来：同一轮里后续步骤可能带用量。
        if (usage === undefined || usage === null) {
          noteMessageId(data.turn, data)
          break
        }
        const t = ensureTurn(data.turn, at)
        noteMessageId(data.turn, data)
        const source = data.message && data.message.source
        const record = {
          uncachedInputTokens: int(usage.inputTokens),
          cacheReadTokens: int(usage.cacheReadTokens),
          cacheWriteTokens: int(usage.cacheWriteTokens),
          outputTokens: int(usage.outputTokens),
          reasoningTokens: int(usage.reasoningTokens),
          totalTokens: 0,
        }
        record.totalTokens =
          record.uncachedInputTokens + record.cacheReadTokens + record.cacheWriteTokens + record.outputTokens
        /** usage 账本与步数账本分开：没有 usage 的步骤仍然要计步。 */
        const key = `${data.turn}/${data.step}`
        const hadKey = t.steps_.has(key)
        const previous = t.steps_.get(key)
        if (previous !== undefined && previous !== null) addTokens(t.tokens, previous, -1)
        addTokens(t.tokens, record, 1)
        t.steps_.set(key, record)
        // 一条 usage 记录本身就说明这一步跑过：没有 step/start、step/end 时也要计一步；
        // 但那条边界事件已经记过步（key 已存在）时不能重复加，重试覆盖同理。
        if (!hadKey) t.steps += 1
        if (source && source.provider) t.provider = source.provider
        if (source && source.model) t.model = source.model
        break
      }
      case 'turn/end': {
        const t = byTurn.get(data.turn)
        if (t !== undefined) {
          if (at !== null) t.endTime = at
          t.reason = data.reason && data.reason.kind ? data.reason.kind : String(data.reason || '')
        }
        break
      }
      default:
        break
    }
  }

  return turns
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 一个会话的展示用标签：首条用户消息的前 24 个字。 */
function labelOfEvents(events) {
  for (const event of events || []) {
    if (event.type === 'user/message') {
      const text = textOfContent((event.data && event.data.message && event.data.message.content) || (event.data && event.data.content))
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat.length > 0) return flat.slice(0, 24)
    }
  }
  return ''
}

// ---------------------------------------------------------------- 余额

function clientMeta() {
  return {
    version: '0.1.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 余额接口的实际地址：默认官方地址，`DEEPSEEK_BASE_URL` 覆盖；尾斜杠归一化，避免出现 `//user/balance`。 */
function apiBaseUrl() {
  const raw = process.env[BASE_URL_ENV]
  const base = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : API_BASE
  return base.replace(/\/+$/, '')
}

/**
 * 官方公开接口：GET https://api.deepseek.com/user/balance（Bearer 推理 token）。
 * 凭据解析顺序（前面的拿不到才退到后面），每一步都是「可选服务 + undefined / 方法存在性检查」：
 *   1. credentials 缝的 `DEEPSEEK_API_KEY` 引用 —— 与 llm-deepseek 适配器同源，设置里填过就能用；
 *   2. 可选服务 `ctx.deepseekAccount.resolveToken()` —— 老路径，兼容没有凭据缝的组合；
 *   3. 都拿不到就返回 null，交给上层回落到平台钱包，最差也只是 `unavailable`。
 * 任何异常都只让本函数返回 null / failed，不会抛穿到 handler。
 */
async function readApiBalance(ctx) {
  // ---- 1) credentials 缝（首选，可选服务） ----
  let token = null
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(API_KEY_REF)
      if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.length > 0) {
        token = hit.value
      }
    } catch {
      token = null
    }
  }
  // ---- 2) 可选的 deepseekAccount 服务（旧路径） ----
  if (token === null) {
    const account = ctx.get('deepseekAccount')
    if (account !== undefined && account !== null && typeof account.resolveToken === 'function') {
      try {
        const resolved = await account.resolveToken(apiBaseUrl())
        if (typeof resolved === 'string' && resolved.length > 0) token = resolved
      } catch {
        token = null
      }
    }
  }
  if (token === null) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(`${apiBaseUrl()}/user/balance`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return { status: 'failed', source: 'api', error: `HTTP ${response.status}` }
    const body = await response.json()
    const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : []
    if (infos.length === 0) return { status: 'failed', source: 'api', error: '余额列表为空' }
    return {
      status: 'ready',
      source: 'api',
      isAvailable: body.is_available !== false,
      wallets: infos.map((wallet) => ({
        currency: wallet.currency === 'USD' ? 'USD' : 'CNY',
        total: num(wallet.total_balance),
        granted: num(wallet.granted_balance),
        toppedUp: num(wallet.topped_up_balance),
      })),
    }
  } catch (error) {
    return { status: 'failed', source: 'api', error: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 平台钱包（网页端会话凭据）。 */
async function readPlatformBalance(ctx) {
  const account = ctx.get('deepseekAccount')
  if (account === undefined || account === null || typeof account.getBalance !== 'function') return null
  try {
    const details = await account.getBalance(clientMeta())
    if (details === null || details === undefined) {
      return { status: 'signed-out', source: 'account' }
    }
    if (details.status === 'failed') return { status: 'failed', source: 'account', error: '平台读取失败' }
    const wallets = (details.value || []).map((wallet) => ({
      currency: wallet.currency === 'USD' ? 'USD' : 'CNY',
      total: num(wallet.balance),
      granted: null,
      toppedUp: null,
    }))
    const bonusWallets = (details.bonusWallets || []).map((wallet) => ({
      currency: wallet.currency === 'USD' ? 'USD' : 'CNY',
      total: num(wallet.balance),
      granted: null,
      toppedUp: null,
    }))
    return { status: 'ready', source: 'account', wallets, bonusWallets }
  } catch (error) {
    return { status: 'failed', source: 'account', error: String((error && error.message) || error) }
  }
}

async function readBalance(ctx) {
  const api = await readApiBalance(ctx)
  if (api !== null && api.status === 'ready') return api
  const platform = await readPlatformBalance(ctx)
  if (platform !== null) {
    if (api !== null && platform.status !== 'ready') platform.note = api.error
    return platform
  }
  return api || { status: 'unavailable', source: 'none', error: '没有可用的账户凭据' }
}

// ---------------------------------------------------------------- AI 分析

async function resolveAnalysisRoute(ctx, session, turn, options) {
  if (options.analysisProvider && options.analysisModel) {
    return { provider: options.analysisProvider, model: options.analysisModel }
  }
  // 会话对象在「只看得到落盘日志」时为 null，所以优先用这一轮自己的 provider/model。
  if (turn !== undefined && turn !== null && turn.provider && turn.model) {
    return { provider: String(turn.provider), model: String(turn.model) }
  }
  if (session !== undefined && session !== null && typeof session.requestContext === 'function') {
    try {
      const context = session.requestContext()
      if (context && context.provider && context.model) {
        return { provider: context.provider, model: context.model }
      }
    } catch {
      // 会话还没写 request/context 事件时可能抛，忽略并往下走。
    }
  }
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null) return null
  if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return null
  const providers = llm.listProviders()
  if (!Array.isArray(providers) || providers.length === 0) return null
  const provider = providers[0] && providers[0].id
  if (!provider) return null
  const models = await llm.listModels(provider)
  if (!Array.isArray(models) || models.length === 0) return null
  const preferred = models.find((m) => m && typeof m.id === 'string' && /flash/i.test(m.id)) || models[0]
  if (!preferred || !preferred.id) return null
  return { provider, model: preferred.id }
}

function renderTranscript(events, turnNo, budget = 6000) {
  const lines = []
  let used = 0
  const push = (line) => {
    if (used >= budget) return
    const cut = line.length > 400 ? `${line.slice(0, 400)}…` : line
    used += cut.length
    lines.push(cut)
  }
  for (const event of events || []) {
    const data = event.data || {}
    switch (event.type) {
      case 'user/message': {
        if (data.turn !== undefined && data.turn !== turnNo) break
        push(`[用户] ${textOfContent((data.message && data.message.content) || data.content)}`)
        break
      }
      case 'assistant/message': {
        if (data.turn !== turnNo) break
        const text = textOfContent(data.message && data.message.content)
        if (text.trim().length > 0) push(`[助手] ${text}`)
        break
      }
      case 'tool/call': {
        if (data.turn !== undefined && data.turn !== turnNo) break
        push(`[工具调用] ${data.name}(${String(data.arguments || '').slice(0, 200)})`)
        break
      }
      case 'tool/result': {
        if (data.turn !== undefined && data.turn !== turnNo) break
        push(`[工具结果] ${data.error ? `错误 ${JSON.stringify(data.error).slice(0, 160)}` : 'ok'}`)
        break
      }
      default:
        break
    }
  }
  return lines.join('\n')
}

function analysisPrompt(turn, transcript, threshold) {
  const t = turn.tokens
  return [
    '下面是一轮 DeepSeek Harness 对话的 Token 用量与内容摘要。请分析这一轮为什么消耗偏高。',
    '',
    `- 模型：${turn.model || '未知'}（计价档 ${turn.cost.model}）`,
    `- 时段：${turn.cost.band === 'peak' ? '高峰' : '空闲'}`,
    `- 缓存命中输入：${t.cacheReadTokens} tokens`,
    `- 缓存未命中输入：${t.uncachedInputTokens} tokens`,
    `- 缓存写入：${t.cacheWriteTokens} tokens`,
    `- 输出：${t.outputTokens} tokens（其中思考 ${t.reasoningTokens}）`,
    `- 合计：${t.totalTokens} tokens（阈值 ${threshold}）`,
    '',
    '该轮的对话内容摘要：',
    '"""',
    transcript.length > 0 ? transcript : '（没有可用的内容摘要）',
    '"""',
    '',
    '请用简体中文输出，控制在 400 字以内，严格按以下三段，不要客套、不要复述我给的数据：',
    '1. **结论**：一句话说清这一轮贵在哪里。',
    '2. **拆解**：说明四部分 token 各由什么造成（例如重复读文件、长工具输出、思考过长、缓存未命中等）。',
    '3. **建议**：2-3 条具体可执行的降本做法。',
  ].join('\n')
}

/**
 * 跑一次分析。`session` 只用于取事件；只看得到落盘日志时它可以为 null，此时事件由调用方传入。
 * 任何失败都以 `{ok:false,error}` 返回，不抛穿。
 */
async function runAnalysis(ctx, session, turn, options, providedEvents) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    return { ok: false, error: 'Host 没有可用的 llm 服务' }
  }
  const route = await resolveAnalysisRoute(ctx, session, turn, options)
  if (route === null) return { ok: false, error: '找不到可用的模型路由' }
  const events = Array.isArray(providedEvents) ? providedEvents : snapshotOf(session)
  const transcript = renderTranscript(events, turn.turn)
  const prompt = analysisPrompt(turn, transcript, options.thresholdTokens)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180000)
  let text = ''
  let reasoning = ''
  let failure = null
  let finishKind = null
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: '你是 LLM 成本优化分析员，回答必须具体、可执行、不废话。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: options.analysisMaxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'finish' && chunk.reason) {
        finishKind = chunk.reason.kind
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          failure = (chunk.reason.failure && chunk.reason.failure.message) || chunk.reason.kind
        }
      }
    }
  } catch (error) {
    failure = String((error && error.message) || error)
  } finally {
    clearTimeout(timer)
  }
  if (text.trim().length === 0) {
    // 只有思考没有正文：思考预算被 maxTokens 截断是常见情形，但思考内容本身
    // 已经是对这一轮开销的分析，丢掉可惜 —— 退化成用它作答，并标明来源。
    if (reasoning.trim().length > 0 && failure === null) {
      return {
        ok: true,
        text: reasoning.trim(),
        reasoning: reasoning.trim(),
        route,
        degraded: finishKind === 'max-tokens' ? 'reasoning-only-truncated' : 'reasoning-only',
      }
    }
    return { ok: false, error: failure || '模型没有返回内容', reasoning }
  }
  return { ok: true, text: text.trim(), reasoning: reasoning.trim(), route }
}

// ---------------------------------------------------------------- 会话选择

/** 会话对象上取事件快照；可选服务缺失、会话异常都退化成空数组。 */
function snapshotOf(session) {
  if (session === undefined || session === null) return []
  if (typeof session.snapshotEvents !== 'function') return []
  try {
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/** 从落盘 JSONL 文本解析出的事件数组（坏行跳过，单行坏不让整段日志报废）。 */
function parseRawEvents(content) {
  if (typeof content !== 'string' || content.length === 0) return []
  const events = []
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const event = JSON.parse(line)
      if (event !== null && typeof event === 'object') events.push(event)
    } catch {
      // 半行写入（进程被杀）或格式变化，跳过即可。
    }
  }
  return events
}

/**
 * 不在内存里的会话：读 `ctx.sessionPersistence` 的落盘日志，用**同一个 foldTurns** 折叠。
 * 这样重启前/已归档的会话也能算出逐轮费用，而不是只认当前进程里活着的会话。
 * 兼容三种可能的口径：`readRaw(id)`（JSONL 原文）、`readEvents(id)` / `loadEvents(id)`（事件数组）。
 * 任何失败都返回 undefined，由上层决定降级。
 */
async function sessionFromPersistence(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
  if (persistence === undefined || persistence === null) return undefined
  // ① 首选 readRaw（拿到 JSONL 原文，由我们解析）；② 退化到 readEvents / loadEvents（已经是事件数组）。
  const raw = await callFirst(persistence, ['readRaw'], sessionId)
  if (raw !== undefined && raw !== null && typeof raw.content === 'string') {
    return describeFromEvents(sessionId, parseRawEvents(raw.content))
  }
  const events = await callFirst(persistence, ['readEvents', 'loadEvents'], sessionId)
  if (Array.isArray(events)) return describeFromEvents(sessionId, events)
  return undefined
}

/** 从内存会话对象直接造描述子（已经有对象时不要再按 id 去查一次，查不到就白丢会话）。 */
function describeFromSession(session) {
  const events = snapshotOf(session)
  return {
    session,
    id: session.id !== undefined && session.id !== null ? String(session.id) : '',
    turns: foldTurns(events),
    rawEvents: events,
    label: labelOfEvents(events),
    eventCount: events.length,
  }
}

/** 依次尝试若干候选方法名，返回第一个成功且非 null 的结果（失败只当作「这条路走不通」）。 */
async function callFirst(target, names, argument) {
  for (const name of names) {
    if (typeof target[name] !== 'function') continue
    try {
      const value = await target[name](argument)
      if (value !== undefined && value !== null) return value
    } catch {
      // 换下一个候选方法。
    }
  }
  return undefined
}

/** 把「落盘事件数组」包成统一描述子（含原始事件，供 analyze 渲染转录）。 */
function describeFromEvents(sessionId, events) {
  return {
    session: null,
    id: sessionId,
    turns: foldTurns(events),
    rawEvents: events,
    label: labelOfEvents(events),
    eventCount: events.length,
  }
}

/**
 * 解析一个会话，返回统一的描述子；拿不到就返回 undefined。
 * 链子：内存里的实时会话（首选）→ 落盘日志兜底（非活跃会话也能算）。
 * 描述子形状：`{ session, turns, label, eventCount, id, rawEvents }`，`session` 只在内存里存在时非 null。
 */
async function sessionOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
    let session
    try {
      session = sessions.get(sessionId) || undefined
    } catch {
      session = undefined
    }
    if (session !== undefined && session !== null) return describeFromSession(session)
  }
  return sessionFromPersistence(ctx, sessionId)
}

/**
 * 会话是否「顶层」：子 Agent（分身）会话会不停写事件，如果不加区分，`sessions.list()` 里
 * 最新的一条往往根本不是用户在看的那条。带 `parentSession`（或 `delegationDepth` 非 0、
 * `origin === 'subagent'`）的会话一律降权，只有当列表里**没有任何顶层会话**时才用它们。
 */
function isTopLevelSession(session) {
  if (session === undefined || session === null) return false
  const header = session.header !== undefined && session.header !== null ? session.header : session
  if (header.parentSession !== undefined && header.parentSession !== null) return false
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
  if (header.origin === 'subagent') return false
  return true
}

/**
 * 兜底：最近有事件写入的会话。优先顶层会话（排除子 Agent 分身），
 * 没有任何顶层会话时才退回全量里最新的一条。比较依据是 `seq`，缺省按 0 处理。
 */
function mostRecentSession(ctx) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return undefined
  let list
  try {
    list = sessions.list()
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  let best = null
  let bestSeq = -1
  let bestAny = null
  let bestAnySeq = -1
  for (const session of list) {
    if (session === null || session === undefined) continue
    const seq = typeof session.seq === 'number' && Number.isFinite(session.seq) ? session.seq : 0
    if (seq > bestAnySeq) {
      bestAnySeq = seq
      bestAny = session
    }
    if (!isTopLevelSession(session)) continue
    if (seq > bestSeq) {
      bestSeq = seq
      best = session
    }
  }
  return (best || bestAny) || undefined
}

/**
 * 解析「这次请求该看哪个会话」：显式 sessionId 优先（内存 → 落盘），否则退回最近会话。
 * 返回 `{ picked, source, session, id }`：`source` 就是响应里的 `sessionResolved` 三态；
 * `session` 只在内存里存在时非 null（analyze 的路由推断会用，落盘会话则为 null）。
 */
async function resolveSession(ctx, requested) {
  const wanted = typeof requested === 'string' ? requested.trim() : ''
  if (wanted.length > 0) {
    const picked = await sessionOf(ctx, wanted)
    if (picked !== undefined) {
      return { picked, source: 'requested', session: picked.session || null, id: wanted }
    }
  }
  const recent = mostRecentSession(ctx)
  if (recent !== undefined && recent !== null) {
    // 已经有会话对象了就直接用，不要按 id 再查一次 —— 查不到会把「recent」白降级成 none。
    const picked = describeFromSession(recent)
    return { picked, source: 'recent', session: recent, id: picked.id }
  }
  return { picked: undefined, source: 'none', session: null, id: wanted }
}

// ---------------------------------------------------------------- 组装响应

/** 把折叠结果转成对外的 TurnView（契约字段一个不少）。 */
function turnViewOf(turn, currency, options) {
  // costOf 查的是当前生效的价目表，所以 config.priceOverrides 会直接反映到每一轮的费用里。
  const cost = costOf(turn.tokens, turn.model, currency, turn.startTime || Date.now())
  return {
    turn: turn.turn,
    startTime: turn.startTime,
    endTime: turn.endTime,
    reason: turn.reason,
    steps: turn.steps,
    model: turn.model,
    provider: turn.provider,
    // 这一轮出现过的 assistant 消息 id：浏览器半边在
    // `conversation.chat.assistant-actions` 里只拿得到 messageId，靠它反查轮号。
    messageIds: Array.isArray(turn.messageIds) ? turn.messageIds.slice() : [],
    tokens: {
      uncachedInputTokens: turn.tokens.uncachedInputTokens,
      cacheReadTokens: turn.tokens.cacheReadTokens,
      cacheWriteTokens: turn.tokens.cacheWriteTokens,
      outputTokens: turn.tokens.outputTokens,
      reasoningTokens: turn.tokens.reasoningTokens,
      totalTokens: turn.tokens.totalTokens,
    },
    cost,
    overThreshold: turn.tokens.totalTokens >= options.thresholdTokens,
  }
}

/**
 * 把「会话描述子」转成响应里的 session 视图。
 * 描述子可能是内存会话（`{session}`）也可能是落盘日志（`{turns,label,eventCount}`），
 * 两条路都收敛成同一个形状，因此重启后翻旧会话也能看到逐轮费用。
 */
function buildSessionView(picked, currency, options) {
  if (picked === undefined || picked === null) return null
  const inMemory = picked.session !== undefined && picked.session !== null
  const events = inMemory ? snapshotOf(picked.session) : []
  const turns = inMemory ? foldTurns(events) : Array.isArray(picked.turns) ? picked.turns : []
  if (turns.length === 0 && !inMemory) return null
  const totals = zeroTokens()
  let totalCost = 0
  const views = []
  for (const turn of turns) {
    const view = turnViewOf(turn, currency, options)
    totalCost += view.cost.total
    addTokens(totals, turn.tokens, 1)
    views.push(view)
  }
  const last = views.length > 0 ? views[views.length - 1] : null
  const id = inMemory
    ? picked.session.id !== undefined && picked.session.id !== null ? String(picked.session.id) : ''
    : typeof picked.id === 'string' ? picked.id : ''
  return {
    id,
    label: inMemory ? labelOfEvents(events) : typeof picked.label === 'string' ? picked.label : '',
    eventCount: inMemory ? events.length : Number.isFinite(picked.eventCount) ? picked.eventCount : 0,
    totals: { tokens: totals, cost: totalCost, currency },
    lastTurn: last,
    turns: views.slice(-40),
  }
}

/** 视图里最后一轮用的完整折叠结果（analyze 需要没被截到 40 条的那份）。 */
function foldedTurnsOf(picked) {
  if (picked === undefined || picked === null) return []
  if (picked.session !== undefined && picked.session !== null) return foldTurns(snapshotOf(picked.session))
  return Array.isArray(picked.turns) ? picked.turns : []
}

/** 视图对应的事件数组（内存会话直接取，落盘会话用 `rawEvents` 存下的那份）。 */
function eventsOf(picked) {
  if (picked === undefined || picked === null) return []
  if (picked.session !== undefined && picked.session !== null) return snapshotOf(picked.session)
  return Array.isArray(picked.rawEvents) ? picked.rawEvents : []
}

function pickCurrency(balance) {
  if (balance && balance.status === 'ready' && Array.isArray(balance.wallets)) {
    const cny = balance.wallets.find((w) => w.currency === 'CNY')
    if (cny) return 'CNY'
    const usd = balance.wallets.find((w) => w.currency === 'USD')
    if (usd) return 'USD'
  }
  if (balance && balance.status === 'ready' && Array.isArray(balance.bonusWallets)) {
    const bonus = balance.bonusWallets.find((w) => w.currency === 'CNY' || w.currency === 'USD')
    if (bonus) return bonus.currency
  }
  return 'CNY'
}

// ---------------------------------------------------------------- HTTP 小工具

function json(res, status, payload, extraHeaders) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = JSON.stringify({ ok: false, error: `响应无法序列化：${String((error && error.message) || error)}` })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  })
  res.end(body)
}

/** 方法不对就回 405（带 Allow），调用方负责 return。 */
function methodNotAllowed(res, allow) {
  res.setHeader?.('allow', allow)
  // Allow 要一起交给 writeHead，否则会被 json() 里的头覆盖掉。
  json(res, 405, { ok: false, error: `只支持 ${allow}` }, { allow })
}

function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 读 JSON 请求体。
 * 假 req（或没有 body 的可迭代对象的 req）会因为没有 `Symbol.asyncIterator` 而直接返回 `{}`，
 * 不会在 `for await` 上挂死；超过 limit 立即抛错，不会把整个 body 收完。
 */
async function readJsonBody(req, limit = 256 * 1024) {
  if (req === null || typeof req !== 'object' || typeof req[Symbol.asyncIterator] !== 'function') return {}
  const declared = Number(req.headers && req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new Error('请求体过大')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buf.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

// ---------------------------------------------------------------- 入口

export const inject = ['webServer']

/**
 * 纯函数面（只增不改）：cordis 只认 `apply` / `inject`，多出来的具名导出对宿主无害，
 * 但让时段判定、计价与折叠可以被离线断言（计费正确性不该只能靠肉眼看 UI 验证）。
 * 依赖派生表的函数（isPeak / nextSwitch / costOf / priceTableOf）读的是最近一次 apply 的规则快照，
 * 不传 config 时就是 DEFAULT_OPTIONS + 内置价目表。
 */
function defaultOptions() {
  return { ...DEFAULT_OPTIONS }
}

export { isPeak, nextSwitch, phaseInfo, costOf, normalizeModel, foldTurns, priceTableOf, defaultOptions }

export function apply(ctx, config) {
  const options = activateOptions(config)

  ctx.effect(() => {
    if (ctx.webServer === undefined || ctx.webServer === null || typeof ctx.webServer.register !== 'function') {
      ctx.logger?.warn?.('dsh-simple-cost: webServer 服务不可用，已跳过路由注册')
      return () => {}
    }
    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/state`,
      handler: async (req, res) => {
        try {
          if (!isLoopback(req)) {
            json(res, 403, { ok: false, error: '只接受回环请求' })
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            methodNotAllowed(res, 'GET')
            return
          }
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const requested = url.searchParams.get('sessionId')
          const now = new Date()
          const balance = await readBalance(ctx)
          const currency = pickCurrency(balance)
          const resolved = await resolveSession(ctx, requested)
          const view = buildSessionView(resolved.picked, currency, options)
          json(res, 200, {
            ok: true,
            now: now.getTime(),
            priceVersion: PRICE_VERSION,
            prices: priceTableOf(currency),
            symbol: SYMBOL[currency] || '¥',
            currency,
            thresholdTokens: options.thresholdTokens,
            pollMs: options.pollMs,
            phase: phaseInfo(now),
            balance,
            session: view,
            sessionResolved: resolved.source,
          })
        } catch (error) {
          json(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    })

    const disposeAnalyze = ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/analyze`,
      handler: async (req, res) => {
        try {
          if (!isLoopback(req)) {
            json(res, 403, { ok: false, error: '只接受回环请求' })
            return
          }
          if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST')
            return
          }
          const body = await readJsonBody(req)
          const resolved = await resolveSession(ctx, body.sessionId)
          if (resolved.picked === undefined) {
            json(res, 200, { ok: false, error: '找不到会话' })
            return
          }
          const currency = pickCurrency(await readBalance(ctx))
          const turns = foldedTurnsOf(resolved.picked)
          if (turns.length === 0) {
            json(res, 200, { ok: false, error: '这个会话还没有可分析的轮次' })
            return
          }
          // 这里用完整折叠结果而不是响应里被截到 40 条的 turns，避免请求历史轮次时被静默换成最后一轮。
          const wanted = Number.isFinite(body.turn) ? body.turn : turns[turns.length - 1].turn
          const target = turns.find((t) => t.turn === wanted) || turns[turns.length - 1]
          const turnView = turnViewOf(target, currency, options)
          // 落盘会话没有 session 对象，事件由描述子带过来。
          json(res, 200, await runAnalysis(ctx, resolved.session, turnView, options, eventsOf(resolved.picked)))
        } catch (error) {
          // analyze 一律 200，用 ok 表达成败。
          json(res, 200, { ok: false, error: String((error && error.message) || error) })
        }
      },
    })

    return () => {
      try {
        disposeState()
      } catch {
        // 卸载时重复 dispose 不该影响插件退出。
      }
      try {
        disposeAnalyze()
      } catch {
        // 同上。
      }
    }
  }, 'dsh-simple-cost: loopback routes')

  ctx.logger?.info?.(`dsh-simple-cost ready on ${ROUTE_BASE}/state`)
  // 把生效后的选项返回出去：cordis 会忽略返回值，但自检/调试能直接断言 config 覆盖结果。
  return options
}
