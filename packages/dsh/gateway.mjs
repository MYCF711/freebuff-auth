#!/usr/bin/env node
// direct-gateway.mjs — Freebuff 直连网关（支持 tool calling）
//
// 基于 2026-10-24 的原版改造，新增：
//   1. 请求侧：OpenAI tools / tool_choice 透传到 freebuff
//   2. 响应侧：SSE 里 delta.tool_calls 的聚合
//   3. 非流式 / 流式两种响应都支持 tool_calls
//   4. 多轮：assistant.tool_calls + role:'tool' 的正确处理
//   5. /freebuff/usage 端点（查看 freebucks 消耗，验证扣费）
//
// 依据：抓包证实 freebuff 的 tools 入参和 tool_calls 出参都是标准 OpenAI 格式。
//
//   POST /v1/chat/completions
//   GET  /v1/models
//   GET  /healthz
//   GET  /freebuff/usage     ← 新增
//
// 风险红线（沿用原版）：
//   - 单会话互斥、请求串行排队，绝不并发轰炸
//   - 失败进长冷却（120s）
//   - 全部协议头/签名/指纹由官方格式复刻
//   - 一个会话窗口用满，不做 admit/release 循环
//   - 唯一通道：运行期间不得再用 Desktop / 网页 / 官方 CLI 开同账号会话
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

import {
  parseFreebuffSSE,
  applyTools,
  serializeMessages,
  buildNonStreamResponse,
  writeSSEResponse,
} from 'freebuff-core'

const PORT = Number(process.env.GATEWAY_PORT ?? 8937)
const HOST = '127.0.0.1'
// ⚠ 工作目录：默认用脚本所在目录，可用 FREEBUFF_HOME 覆盖（跨平台）
const BASE = process.env.FREEBUFF_HOME ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const API = 'https://www.codebuff.com'
const LOG = path.join(BASE, 'direct-gateway.log')

// 模型映射（TUI 名 → 网关 id）
const MODELS = {
  'solar-pro4': { tui: 'Solar Pro 4', tier: 'unlimited', note: '0fb UNLIMITED', key: 'm-9a7e098cc1', slow: false },
  'nemotron-3.5-lightning': { tui: 'Nemotron 3.5 Lightning', tier: 'unlimited', note: '0fb UNLIMITED', key: 'm-ddc687c50f', slow: false },
  'glyph-cluster': { tui: 'Glyph Cluster', tier: 'unlimited', note: '0fb UNLIMITED · 响应可达数分钟', key: 'm-02244092cb', slow: true },
  'mimo-v2.6-slow': { tui: 'MiMo v2.6 Flash Slow', tier: 'optimized', note: '5fb', key: 'm-61c26317cc', slow: false },
  'deepseek-v4.1-flash': { tui: 'DeepSeek V4.1 Flash 10/17', tier: 'optimized', note: '15fb · 3x', key: 'm-096e75164d', slow: false },
}
const DEFAULT_MODEL = 'solar-pro4'

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`
  console.log(line)
  try { fs.appendFileSync(LOG, line + '\n') } catch {}
}

// ══════════════════════════════════════════════════════════════
// 凭据
// ══════════════════════════════════════════════════════════════
const DEVICE_PATH = path.join(os.homedir(), '.config', 'manicode', 'device-key.json')
const CRED_PATH = path.join(os.homedir(), '.config', 'manicode', 'credentials.json')

let DEVICE, DEVICE_KEY_ID, PRIVATE_KEY
try {
  DEVICE = JSON.parse(fs.readFileSync(DEVICE_PATH, 'utf8'))
  DEVICE_KEY_ID = Object.values(DEVICE.registrations ?? {})[0]
  PRIVATE_KEY = crypto.createPrivateKey({
    key: Buffer.from(DEVICE.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
} catch (e) {
  console.error(`❌ 读不到设备密钥 (${DEVICE_PATH}): ${e.message}`)
  console.error('   请先用官方 CLI 登录一次，生成 device-key.json')
  process.exit(1)
}

function readToken() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'))
    const t = c?.default?.authToken
    if (!t) throw new Error('credentials.json 里没有 default.authToken')
    return t
  } catch (e) {
    console.error(`❌ 读不到 token (${CRED_PATH}): ${e.message}`)
    process.exit(1)
  }
}
const TOKEN = readToken()

// 本机账号 userId（从 credentials 里读，读不到就报错，不再硬编码）
function readActingUser() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'))
    return c?.default?.userId ?? c?.default?.id ?? ''
  } catch {
    return ''
  }
}
const ACTING_USER = process.env.FREEBUFF_USER_ID || readActingUser()

// ══════════════════════════════════════════════════════════════
// 传输层（node:https，复刻 bun 的隐式头集合）
// ══════════════════════════════════════════════════════════════
const BUN_IMPLICIT = {
  'accept': '*/*',
  'accept-encoding': 'gzip, deflate, br, zstd',
}

function decompress(buf, encoding) {
  const enc = String(encoding ?? '').toLowerCase()
  try {
    if (enc.includes('zstd') && typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(buf)
    }
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf)
    if (enc.includes('gzip')) return zlib.gunzipSync(buf)
    if (enc.includes('deflate')) return zlib.inflateSync(buf)
  } catch {
    // 压缩头与实际内容不符时，按原始字节返回
  }
  return buf
}

function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const allHeaders = { ...BUN_IMPLICIT, ...headers }
    if (body != null) allHeaders['content-length'] = Buffer.byteLength(body)

    // ★ 按协议选模块：真实上游是 https，但本地 mock / 自建代理可能是 http。
    //   早先硬编码 https 会让 http:// 的地址报 EPROTO（SSL wrong version number）。
    const isHttps = u.protocol === 'https:'
    const mod = isHttps ? https : http

    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: allHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          const text = decompress(raw, res.headers['content-encoding']).toString('utf8')
          resolve({ status: res.statusCode, headers: res.headers, text })
        })
      },
    )
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

// ══════════════════════════════════════════════════════════════
// 设备签名（6 行载荷，Ed25519）
// ══════════════════════════════════════════════════════════════
function signDevice(method, pathname, bodyStr, fetchId) {
  const ts = Date.now()
  const bodySha = crypto.createHash('sha256').update(bodyStr ?? '').digest('hex')
  const payload = [
    'freebuff-device-v1',
    method.toUpperCase(),
    pathname,
    String(ts),
    bodySha,
    fetchId ?? '',
  ].join('\n')
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), PRIVATE_KEY)
  return {
    'x-freebuff-device-key': DEVICE_KEY_ID,
    'x-freebuff-device-ts': String(ts),
    'x-freebuff-device-sig': sig.toString('base64url'),
  }
}

// ══════════════════════════════════════════════════════════════
// 协议常量
// ══════════════════════════════════════════════════════════════
const ENV_HEADER =
  'v1;in=1;out=1;tp=none;term=1;ct=0;sz=0x0;ci=0;ssh=0;l=0;p=other;g=node;osc=0;tzo=0;px=none;tls=1;ca=0;cde=none'
const CLIENT_VERSION = '0.2.34'
const UA_CHAT =
  'ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser'

const BUFFY_TEMPLATE_PATH = path.join(BASE, 'baseline', 'buffy-system-prompt.txt')
const CHAT_TEMPLATE_PATH = path.join(BASE, 'baseline', 'chat-body-full.json')

let BUFFY_TEMPLATE = ''
let CHAT_TEMPLATE = null
try {
  BUFFY_TEMPLATE = fs.readFileSync(BUFFY_TEMPLATE_PATH, 'utf8')
} catch (e) {
  console.error(`❌ 读不到 baseline/buffy-system-prompt.txt: ${e.message}`)
  process.exit(1)
}
try {
  CHAT_TEMPLATE = JSON.parse(fs.readFileSync(CHAT_TEMPLATE_PATH, 'utf8'))
} catch (e) {
  console.error(`❌ 读不到 baseline/chat-body-full.json: ${e.message}`)
  process.exit(1)
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
function buffyPrompt() {
  // 日期必须动态，格式与官方一致：October 24, 2026
  const d = new Date()
  const dateStr = `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
  // 模板里的日期行替换掉（官方模板含 "Current date: ..."）
  return BUFFY_TEMPLATE.replace(/Current date:\s*[A-Z][a-z]+ \d{1,2}, \d{4}\.?/, `Current date: ${dateStr}.`)
}

// ══════════════════════════════════════════════════════════════
// 直连会话
// ══════════════════════════════════════════════════════════════
class DirectSession {
  constructor() {
    this.instanceId = ''
    this.attemptId = ''
    this.handle = ''
    this.modelId = ''
    this.fetchId = ''
    this.runId = ''
    this.clientId = 'zgudzxe78yj'
    this.expiresAt = 0
    this.stepNumber = 0
    this.ready = false
    this.multiSession = '1'
  }

  /** 拉 catalog，拿 fetchId + handle */
  async refreshCatalog() {
    const pathname = '/api/v1/freebuff/models'
    const r = await request(`${API}${pathname}`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-fb-timezone': 'Asia/Shanghai',
        'x-freebuff-client-version': CLIENT_VERSION,
        'x-freebuff-catalog-protocol': '1',
        'x-freebuff-env': ENV_HEADER,
        'x-freebuff-client': 'cli',        // ★ 官方 CLI 实发这个头
        'user-agent': UA_CHAT,
        ...signDevice('GET', pathname, '', ''),
      },
    })
    if (r.status !== 200) throw new Error(`catalog ${r.status}: ${r.text.slice(0, 200)}`)
    const j = JSON.parse(r.text)
    this.fetchId = j.fetchId ?? ''
    this.catalog = j
    log(`catalog refreshed: rows=${j.rows?.length ?? 0} version=${j.version}`)
    return j
  }

  /** 查会话状态 */
  async querySession() {
    const r = await request(`${API}/api/v1/freebuff/session`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-fb-timezone': 'Asia/Shanghai',
        'x-freebuff-client-version': CLIENT_VERSION,
        'x-freebuff-catalog-protocol': '1',
        'x-freebuff-catalog-fetch': this.fetchId,
        'x-freebuff-env': ENV_HEADER,
        'x-freebuff-multi-session': '1',
        'x-freebuff-include-unused-rate-limits': '1',
        'x-freebuff-purchase-continuity': '1',
        'x-freebuff-heartbeat': '1',
        'user-agent': UA_CHAT,
        ...signDevice('GET', '/api/v1/freebuff/session', '', this.fetchId),
      },
    })
    if (r.status !== 200) return null
    return JSON.parse(r.text)
  }

  /** 遥测（复刻官方顺序，降低指纹差异） */
  async telemetry() {
    const eps = [
      ['/api/v1/me?fields=id%2Cemail', 'GET'],
      ['/api/healthz', 'GET'],
      ['/api/v1/freebuff/streak', 'GET'],
      ['/api/v1/ads/policy', 'GET'],
    ]
    for (const [p, m] of eps) {
      try {
        await request(`${API}${p}`, {
          method: m,
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'user-agent': UA_CHAT,
            'x-freebuff-env': ENV_HEADER,
            'x-freebuff-client-version': CLIENT_VERSION,
          },
        })
      } catch {}
    }
  }

  /** admission：开会话或接管 */
  async admit(modelId) {
    const spec = MODELS[modelId]
    const row = this.catalog?.rows?.find((x) => x.key === spec.key)
    if (!row) throw new Error(`catalog 里没有 ${spec.key}（${spec.tui}）`)
    this.handle = row.handle
    this.modelId = modelId

    const attempt = crypto.randomUUID()
    const instanceId = `cli:${crypto.randomUUID()}`
    const r = await request(`${API}/api/v1/freebuff/session/admission`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'user-agent': UA_CHAT,
        'x-fb-timezone': 'Asia/Shanghai',
        'x-freebuff-client-version': CLIENT_VERSION,
        'x-freebuff-catalog-protocol': '1',
        'x-freebuff-catalog-fetch': this.fetchId,
        'x-freebuff-env': ENV_HEADER,
        'x-freebuff-model': row.handle,
        'x-freebuff-wallet-spend-limit': 'session',
        'x-freebuff-instance-id': instanceId,
        'x-freebuff-purchase-continuity': '1',
        'x-freebuff-desktop-attempt-id': attempt,
        'x-freebuff-multi-session': '1',
      },
    })

    let j = null
    try { j = JSON.parse(r.text) } catch {}

    if (r.status === 200) {
      this.instanceId = j?.instanceId ?? instanceId
      this.attemptId = this.instanceId.startsWith('cli:') ? this.instanceId.slice(4) : attempt
      this.expiresAt = j?.expiresAt ? Date.parse(j.expiresAt) : Date.now() + 3_600_000
      this.stepNumber = 0
      this.ready = true
      log(`admission ok: ${modelId} window until ${new Date(this.expiresAt).toISOString()}`)
      return { ok: true }
    }

    // 409：会话已存在 → 接管 currentInstanceId（不是重试）
    if (r.status === 409) {
      const cur = j?.currentInstanceId
      if (cur) {
        this.instanceId = cur
        this.attemptId = cur.startsWith('cli:') ? cur.slice(4) : attempt
        const ses = await this.querySession()
        this.expiresAt = ses?.expiresAt
          ? Date.parse(ses.expiresAt)
          : (ses?.windowEndsAt ? Date.parse(ses.windowEndsAt) : Date.now() + 3_600_000)
        this.stepNumber = 0
        this.ready = true
        log(`409 -> adopt ${cur} (${modelId})`)
        return { ok: true, adopted: true }
      }
    }

    throw new Error(`admission ${r.status}: ${r.text.slice(0, 300)}`)
  }

  /** 启动 agent-run */
  async startRun() {
    const r = await request(`${API}/api/v1/agent-runs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'user-agent': UA_CHAT,
        'x-freebuff-acting-user-id': ACTING_USER,
      },
      body: JSON.stringify({ action: 'START', agentId: 'base3-free-catalog', ancestorRunIds: [] }),
    })
    if (r.status !== 200) throw new Error(`agent-runs START ${r.status}: ${r.text.slice(0, 200)}`)
    const j = JSON.parse(r.text)
    this.runId = j.runId
    log(`run started: ${this.runId}`)
    return this.runId
  }

  /** 结束 agent-run */
  async finishRun() {
    if (!this.runId) return
    try {
      await request(`${API}/api/v1/agent-runs`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'user-agent': UA_CHAT,
          'x-freebuff-acting-user-id': ACTING_USER,
        },
        body: JSON.stringify({ action: 'FINISH', runId: this.runId, ancestorRunIds: [] }),
      })
      log(`agent-runs FINISH -> 200`)
    } catch {}
    this.runId = ''
  }

  /** 组装 messages */
  buildMessages(clientMessages) {
    // DSH 的 system prompt 提取出来，作为「调用方指令」并入第一条 user 消息，
    // 让 Buffy 的官方 system prompt 保持首位（面具层 + 真实指令层共存）
    let sysExtra = ''
    let sawSystem = false
    const rest = []
    for (const m of clientMessages ?? []) {
      if (m?.role === 'system' && !sawSystem) {
        sawSystem = true
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        sysExtra += (sysExtra ? '\n\n' : '') + c
        continue
      }
      rest.push(m)
    }

    // ★ 核心：用 serializeMessages 处理 tool 角色 + 配对校验
    //   freebuff 的 user 消息要 [{type:'text',text}]，其它角色用纯字符串
    const wire = serializeMessages(rest, (text) => [{ type: 'text', text }])

    // 把调用方指令并入第一条 user 消息
    if (sysExtra) {
      const tag = `[Instructions from the calling application]\n${sysExtra}\n[End of instructions]`
      const idx = wire.findIndex((m) => m.role === 'user' && Array.isArray(m.content))
      if (idx >= 0) {
        const first = wire[idx].content[0]
        first.text = tag + '\n\n' + (first.text ?? '')
      } else {
        wire.unshift({ role: 'user', content: [{ type: 'text', text: tag }] })
      }
    }

    return [{ role: 'system', content: buffyPrompt() }, ...wire]
  }

  /** 发 chat（支持 tools 透传 + tool_calls 聚合） */
  async chat(clientMessages, opts = {}) {
    this.stepNumber += 1
    const t = JSON.parse(JSON.stringify(CHAT_TEMPLATE))
    t.model = this.handle
    t.messages = this.buildMessages(clientMessages)

    // ★ 关键：应用客户端的 tools（会整体替换 freebuff 自带的 16 个工具）
    applyTools(t, opts)

    const md = t.codebuff_metadata ?? {}
    md.freebuff_instance_id = this.instanceId
    md.freebuff_multi_session = this.multiSession
    md.trace_session_id = this.attemptId
    md.run_id = this.runId
    md.client_id = this.clientId
    md.llm_step_number = String(this.stepNumber)
    md.repo_snapshot = JSON.stringify({
      gitAvailable: false,
      repositoryVisibility: 'unknown',
      fileCount: 0,
      fileCountIsLowerBound: false,
      testFileCount: 0,
      changedFileCount: 0,
      changedFileScanTruncated: false,
    })
    t.codebuff_metadata = md

    const bodyStr = JSON.stringify(t)
    const pathname = '/api/v1/chat/completions'
    // 慢模型给足超时（glyph-cluster 实测可达 4 分 53 秒）
    const spec = MODELS[this.modelId]
    const timeoutMs = spec?.slow ? 900_000 : 300_000

    const r = await request(`${API}${pathname}`, {
      method: 'POST',
      timeoutMs,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'user-agent': UA_CHAT,
        'x-freebuff-acting-user-id': ACTING_USER,
        'x-freebuff-catalog-fetch': this.fetchId,
        'x-freebuff-sse-gzip-recovery': '1',
        ...signDevice('POST', pathname, bodyStr, this.fetchId),
      },
      body: bodyStr,
    })

    if (r.status !== 200) {
      return { status: r.status, error: r.text.slice(0, 400) }
    }

    // ★ 用共享解析器（支持 tool_calls）
    const parsed = parseFreebuffSSE(r.text)
    return { status: 200, ...parsed }
  }

  /** 查 freebucks 用量（验证扣费） */
  async usage() {
    const ses = await this.querySession()
    if (!ses) return null
    return {
      balance: ses.freebucks?.balance,
      daily: ses.freebucks?.daily,
      prices: ses.freebucks?.prices,
      status: ses.status,
      expiresAt: ses.expiresAt,
    }
  }

  shutdown() {
    this.ready = false
  }
}

// ══════════════════════════════════════════════════════════════
// 网关状态
// ══════════════════════════════════════════════════════════════
const state = {
  session: null,
  busy: false,
  cooldownUntil: 0,
  currentModel: DEFAULT_MODEL,
  booting: null,
  lastError: null,
}

const QUEUE_MAX = 3
let queued = 0

function withSlot(fn) {
  if (queued >= QUEUE_MAX) {
    return { queued: false, run: async () => ({ status: 429, body: { error: { message: 'queue full', type: 'busy' } } }) }
  }
  queued++
  return {
    queued: true,
    run: async () => {
      try { return await fn() } finally { queued-- }
    },
  }
}

async function ensureSession() {
  if (state.session?.ready) return state.session
  if (!state.booting) {
    state.booting = (async () => {
      log('booting direct session...')
      const s = new DirectSession()
      await s.refreshCatalog()
      await s.telemetry()
      await s.admit(DEFAULT_MODEL)
      await s.startRun()
      state.session = s
      state.currentModel = s.modelId
      log('direct session ready')
      return s
    })().finally(() => { state.booting = null })
  }
  return state.booting
}

async function doChat(body) {
  if (Date.now() < state.cooldownUntil) {
    const wait = Math.ceil((state.cooldownUntil - Date.now()) / 1000)
    return { status: 429, body: { error: { message: `cooldown ${wait}s remaining`, type: 'cooldown', retry_after: wait } } }
  }

  const modelId =
    Object.keys(MODELS).find((k) => body.model === k || body.model === `freebuff/${k}`) ?? DEFAULT_MODEL

  const messages = body.messages ?? []
  if (!messages.length) return { status: 400, body: { error: { message: 'empty messages' } } }

  try {
    const s = await ensureSession()

    // 窗口过期 → 重新 boot
    if (!s.ready || s.expiresAt < Date.now()) {
      log('window expired; re-booting')
      state.session = null
      return doChat(body)
    }

    // 切模型（走 takeover）
    if (s.modelId !== modelId) {
      log(`model switch ${s.modelId} -> ${modelId} (takeover)`)
      await s.finishRun()
      await s.admit(modelId)
      await s.startRun()
    }
    state.currentModel = modelId

    const t0 = Date.now()
    const r = await s.chat(messages, {
      tools: body.tools,
      toolChoice: body.tool_choice,
      parallelToolCalls: body.parallel_tool_calls,
    })

    const dt = Date.now() - t0
    if (r.status !== 200) {
      log(`chat ${modelId} -> ${r.status} (${dt}ms) err=${(r.error ?? '').slice(0, 200)}`)
      state.cooldownUntil = Date.now() + 120_000
      state.lastError = r.error
      return { status: 502, body: { error: { message: r.error, type: 'backend' } } }
    }

    const toolInfo = r.toolCalls?.length ? ` tools=${r.toolCalls.map((x) => x.function.name).join(',')}` : ''
    log(`chat ${modelId} -> 200 (${dt}ms) text=${r.text.length}ch${toolInfo}`)

    return { status: 200, result: r, model: `freebuff/${modelId}`, credits: 0 }
  } catch (e) {
    state.cooldownUntil = Date.now() + 120_000
    state.lastError = String(e?.message || e)
    log(`chat error: ${e?.stack || e}`)
    try {
      if (state.session) { state.session.shutdown(); state.session = null; log('session reset after error') }
    } catch {}
    return { status: 502, body: { error: { message: state.lastError, type: 'backend' } } }
  }
}

// ══════════════════════════════════════════════════════════════
// HTTP
// ══════════════════════════════════════════════════════════════
function json(res, status, body) {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

const GATEWAY_KEY = process.env.GATEWAY_KEY || ''
const authOk = (req) =>
  !GATEWAY_KEY ||
  ((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '') === GATEWAY_KEY

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  try {
    if (!authOk(req)) return json(res, 401, { error: { message: 'bad gateway key' } })

    if (url.pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: Object.entries(MODELS).map(([id, s]) => ({
          id: `freebuff/${id}`,
          object: 'model',
          owned_by: 'freebuff-direct',
          meta: { tier: s.tier, note: s.note, slow: s.slow },
        })),
      })
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', async () => {
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          return json(res, 400, { error: { message: 'bad json' } })
        }

        const slot = withSlot(() => doChat(body))
        const r = await slot.run()

        if (r.status !== 200) return json(res, r.status, r.body)

        // 流式
        if (body.stream) {
          return writeSSEResponse(res, r.result, r.model, r.credits)
        }
        // 非流式
        return json(res, 200, buildNonStreamResponse(r.result, r.model, r.credits))
      })
      return
    }

    if (url.pathname === '/freebuff/usage') {
      ;(async () => {
        try {
          const s = await ensureSession()
          const u = await s.usage()
          return json(res, 200, u ?? { error: 'cannot query usage' })
        } catch (e) {
          return json(res, 500, { error: String(e?.message || e) })
        }
      })()
      return
    }

    if (url.pathname === '/healthz') {
      return json(res, 200, {
        ok: true,
        mode: 'direct',
        tools: true,
        session: Boolean(state.session?.ready),
        busy: state.busy,
        queued,
        currentModel: state.currentModel,
        windowExpiresAt: state.session?.expiresAt ?? 0,
        cooldownUntil: state.cooldownUntil,
        lastError: state.lastError,
      })
    }

    json(res, 404, { error: { message: 'not found' } })
  } catch (e) {
    log(`http error: ${e?.stack || e}`)
    try { json(res, 500, { error: { message: e.message } }) } catch {}
  }
})

// 心跳（复刻官方 45-50s 节奏，防 idle 释放）
setInterval(async () => {
  const s = state.session
  if (!s?.ready) return
  if (Date.now() > s.expiresAt) {
    log('heartbeat: window expired')
    s.ready = false
    return
  }
  try {
    await s.querySession()
  } catch (e) {
    log(`heartbeat error (kept): ${e.message}`)
  }
}, 45_000)

server.listen(PORT, HOST, () => {
  log(`direct gateway (tools enabled) on http://${HOST}:${PORT}`)
  log(`  GET  /v1/models`)
  log(`  POST /v1/chat/completions   (supports tools / tool_choice / stream)`)
  log(`  GET  /healthz`)
  log(`  GET  /freebuff/usage`)
  log(`  models: ${Object.keys(MODELS).join(', ')}`)
})
