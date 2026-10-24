// @magpie-community/opencode-freebuff-auth
//
// 把 Freebuff 的免费额度接成 OpenCode / magpie 的 provider。
// Provider id: freebuff
//
// 计费模型（关键，决定了整个插件的形状）：
//   一个号一天只能开一次会话，一次 1 小时，**时间不可暂停、不可续期，
//   提前释放不退额度**。所以策略是：开出来就用满，到期即换号。
//   详见 billing.mjs 的注释。

import { startLogin, waitForLogin, AUTH_HOST, API_HOST } from "./login.mjs"
import { generateDeviceKey, scopeOf } from "freebuff-core"
import { createClient, FreebuffError, DEFAULT_HOST } from "freebuff-core"
import { createPool, collectAccounts, pickTarget, slug, accountFromAuth } from "freebuff-core"
import { resetAtOf, decide, sessionInfoOf, DAILY_FREEBUCKS, HOURS_PER_FREEBUCKS, SESSION_WINDOW_MS } from "freebuff-core"
import { waitReady, markCall } from "freebuff-core"
import {
  parseFreebuffSSE,
  serializeMessages,
  normalizeToolArguments,
  hasUsableToolName,
} from "freebuff-core"

/** 小时数显示：整数就不带小数点，否则保留一位。 */
function fmtHours(h) {
  const n = Math.max(0, Number(h) || 0)
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

const PROVIDER = "freebuff"

// usage() 结果的缓存。
//
// 本机到 codebuff.com 的每个请求固定 ~8 秒，snapshot() 要掉两个接口，
// 而 magpie 界面重绘就会刷一次 usage —— 不缓存的话每次都卡 16 秒。
// 额度是按小时变的，60 秒缓存完全够。
const USAGE_CACHE_MS = 60_000
const usageCache = new Map()
// 登录站 ≠ API 站：登录走 freebuff.com（邮箱登录），API 走 codebuff.com。
const HOST = process.env.FREEBUFF_HOST || API_HOST

// 供应商图标：从 package.json 的 magpie.icon 读（官方规范位置）
// 早期版本硬编码在这里，48 KB base64 让文件难读、diff 难看，已挪走。
import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const FREEBUFF_ICON = (() => {
  try {
    return _require('./package.json').magpie?.icon ?? ''
  } catch {
    return ''
  }
})()
// ══════════════════════════════════════════════════════════════
// 静态模型表（登录前的兜底）
// ══════════════════════════════════════════════════════════════
//
// ⚠ 为什么需要：magpie 在未登录时就渲染供应商卡片，models() 拿不到账号
//   只能返回空 → 界面显示 "0 models"，用户以为插件坏了。
//   这里列的是 2026-10-24 catalog 快照里的免费档模型，
//   登录后 models() 会用服务端真实目录覆盖它。
const STATIC_MODELS = {
    "solar-pro4": {
      id: "solar-pro4",
      providerID: PROVIDER,
      name: "Solar Pro 4",
      api: { id: "m-9a7e098cc1", url: `${HOST}/api/v1`, npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1048576, output: 64000 },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      // 免费档信息：0 freebucks（只占会话窗口）
      meta: { tier: "UNLIMITED", price: 0 },
    },
    "solar-mini-4": {
      id: "solar-mini-4",
      providerID: PROVIDER,
      name: "Solar Mini 4",
      api: { id: "m-69307952f8", url: `${HOST}/api/v1`, npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1048576, output: 64000 },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      // 免费档信息：0 freebucks（只占会话窗口）
      meta: { tier: "UNLIMITED", price: 0 },
    },
    "nemotron-3.5-lightning": {
      id: "nemotron-3.5-lightning",
      providerID: PROVIDER,
      name: "Nemotron 3.5 Lightning",
      api: { id: "m-ddc687c50f", url: `${HOST}/api/v1`, npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1048576, output: 64000 },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      // 免费档信息：0 freebucks（只占会话窗口）
      meta: { tier: "UNLIMITED", price: 0 },
    },
    "glyph-cluster": {
      id: "glyph-cluster",
      providerID: PROVIDER,
      name: "Glyph Cluster",
      api: { id: "m-02244092cb", url: `${HOST}/api/v1`, npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1048576, output: 64000 },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      // 免费档信息：0 freebucks（只占会话窗口）
      meta: { tier: "UNLIMITED", price: 0 },
    },
    "mimo-v2.6-flash-slow": {
      id: "mimo-v2.6-flash-slow",
      providerID: PROVIDER,
      name: "MiMo v2.6 Flash Slow",
      api: { id: "m-61c26317cc", url: `${HOST}/api/v1`, npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1048576, output: 64000 },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      // 免费档信息：5 freebucks/小时
      meta: { tier: "OPTIMIZED", price: 5 },
    },
    "mimo-v2.6-flash-fast": {
      id: "mimo-v2.6-flash-fast",
      providerID: PROVIDER,
      name: "MiMo v2.6 Flash Fast",
      api: { id: "m-00032eaeec", url: `${HOST}/api/v1`, npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1048576, output: 64000 },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      // 免费档信息：10 freebucks/小时
      meta: { tier: "OPTIMIZED", price: 10 },
    },
    "deepseek-v4.1-flash-10-17": {
      id: "deepseek-v4.1-flash-10-17",
      providerID: PROVIDER,
      name: "DeepSeek V4.1 Flash 10/17",
      api: { id: "m-096e75164d", url: `${HOST}/api/v1`, npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1048576, output: 64000 },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      // 免费档信息：15 freebucks/小时
      meta: { tier: "OPTIMIZED", price: 15 },
    },
    "glm-5.3-flash": {
      id: "glm-5.3-flash",
      providerID: PROVIDER,
      name: "GLM 5.3 Flash",
      api: { id: "m-7e20df6765", url: `${HOST}/api/v1`, npm: "@ai-sdk/openai-compatible" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1048576, output: 64000 },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
      // 免费档信息：20 freebucks/小时
      meta: { tier: "OPTIMIZED", price: 20 },
    },
}


export async function FreebuffAuthPlugin({ client } = {}) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "freebuff-auth", level: "info", message } })
    } catch {}
  }
  const error = (message) => {
    try {
      client?.app?.log?.({ body: { service: "freebuff-auth", level: "error", message } })
    } catch {}
  }

  /**
   * 标记某个账号今天额度用尽。
   *
   * ⚠⚠ 这里**绝不能**回写 magpie 的 auth 存储 ⚠⚠
   *
   * 事故记录（2026-10-24）：早先的实现是
   *     const auth = await client.auth.get(...)      // ← 这个方法不存在
   *     await client.auth.set({ body: {...auth, ...} })
   * magpie 的 client.auth 只有 set / remove，没有 get；未定义方法会落到
   * stub() 上返回一个 Proxy，展开后得到空对象，再被 set 写回去，
   * 结果 plugin-auth.json 里的 freebuff 条目被覆盖成
   *     {"refresh":"{\"exhaustedUntil\":1792873538930}"}
   * —— token、设备密钥、userId 全没了，账号等于废掉。
   *
   * 而且「额度用尽」本来就是**服务端账本上的事实**，本地记不记都能从
   * snapshot() 读出来。所以这里只更新内存里的标记，绝不碰持久化存储。
   */
  async function markDead(account, until) {
    // 只标记内存对象；下次 snapshot() 会从服务端读到真实状态
    if (account && typeof account === "object") {
      try {
        account.exhaustedUntil = until
      } catch {
        // 冻结对象就算了
      }
    }
  }

  /**
   * ⚠ magpie 的 client.auth 只有 set / remove，**没有 get**。
   *
   * 从 magpie 的插件宿主源码确认：
   *   makeClient().auth = { set, remove }     ← 就这两个
   * 任何未定义的方法都会落到 stub() 上，返回 { data: undefined }，
   * 于是 createPool 的 authOf() 永远拿不到账号，报
   * 「Freebuff 没有已登录的账号」。
   *
   * 正确做法：用 loader 收到的 getAuth 作为唯一账号来源。
   * 这个函数仅作为有没有注入成功的兜底检查。
   */
  const pool = createPool({ authOf: () => authSource(), markDead, log })

  /**
   * 账号来源。loader / usage 会先把它们拿到的 getAuth 注入进来，
   * 因为那才是 magpie 官方给的、且**在账号作用域内**的取值方式。
   */
  let injectedGetAuth = null
  function setAuthSource(fn) {
    if (typeof fn === "function") injectedGetAuth = fn
  }
  async function authSource() {
    if (injectedGetAuth) return injectedGetAuth()
    return null
  }

  async function authorize() {
    // 登录走 freebuff.com（邮箱登录），token 用于 codebuff.com 的 API
    //
    // ⚠⚠ authorize() 必须**立刻返回**，不能等网络 ⚠⚠
    //
    // 实测（2026-10-24）：本机到 freebuff.com 的每个请求固定要 ~8 秒
    // （同段 216.24.57.x，百度只要 188ms）。而 magpie 对 oauth authorize
    // 有它自己的超时，等 8 秒就报 "context deadline exceeded"，登录窗口出不来。
    //
    // 解法：这里只做「本地瞬间就能算出来的事」，把拿 loginUrl 的网络请求
    // 放进 callback。callback 由 magpie 在后台跑，慢一点没关系。
    //
    // 代价：第一次展示给用户的 URL 是占位地址；真正的 URL 由 callback
    // 拿到后通过 log 输出，同时 magpie 的弹窗会继续等 callback 完成。
    const LOGIN_PLACEHOLDER = `${AUTH_HOST}/login`

    return {
      url: LOGIN_PLACEHOLDER,
      instructions:
        "正在向 Freebuff 申请登录链接（本机网络到 freebuff.com 较慢，约需 8 秒）。申请到后会自动打开浏览器；若没自动打开，请看日志里的链接。",
      method: "auto",
      async callback() {
        // 真正的登录握手放在这里
        let attempt
        try {
          attempt = await startLogin(AUTH_HOST)
          log(`请在浏览器打开：${attempt.loginUrl}`)
        } catch (e) {
          log(`获取登录链接失败：${e.message}`)
          return { type: "failed", error: `无法连接 Freebuff 登录服务：${e.message}` }
        }

        let user
        try {
          user = await waitForLogin(AUTH_HOST, attempt, {
            onNeedUser: ({ url }) => log(`等待浏览器登录：${url}`),
            // 登录窗口由服务端控制（expiresAt），这里给足 10 分钟
            timeoutMs: 600_000,
          })
        } catch (e) {
          log(`登录失败：${e.message}`)
          return { type: "failed", error: e.message }
        }

        const deviceKey = generateDeviceKey()

        // installId 必须跨登录稳定（服务端用它识别同一安装）
        let reusedInstallId = ""
        try {
          const existing = collectAccounts(await client?.auth?.get?.({ path: { id: PROVIDER } }))
          const same = existing.find((a) => a.userId && a.userId === user.userId && a.installId)
          if (same) reusedInstallId = same.installId
        } catch {}

        const account = {
          host: HOST,
          token: user.token,
          userId: user.userId,
          email: user.email,
          name: user.name,
          installId: reusedInstallId || crypto.randomUUID(),
          deviceKey,
          exhaustedUntil: 0,
        }
        const scope = scopeOf(HOST, user.userId)
        account.scope = scope
        try {
          const api = createClient(account)
          const keyId = await api.registerDevice(scope, deviceKey.publicKey)
          deviceKey.registrations[scope] = keyId
          log(`设备已注册：${keyId}`)
        } catch (e) {
          error(`设备注册失败（稍后重试）：${e.message}`)
        }

        log(`已添加账号：${user.email || user.userId}`)
        return {
          type: "success",
          refresh: JSON.stringify({
            host: HOST,
            userId: user.userId,
            email: user.email,
            name: user.name,
            installId: account.installId,
            deviceKey,
            exhaustedUntil: 0,
          }),
          access: user.token,
          accountId: user.email || user.userId,
        }
      },
    }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Freebuff",
        npm: "@ai-sdk/openai-compatible",
        api: `${HOST}/api/v1`,
        ...was,
        // ⚠ models 必须有值：magpie 的配置层在插件未登录时也会读它，
        //   写空对象会让界面显示 "0 models"。
        //   用 STATIC_MODELS 打底，用户手动改过的条目优先保留。
        models: { ...STATIC_MODELS, ...(was.models ?? {}) },
      }
    },

    provider: {
      id: PROVIDER,

      /**
       * 供应商显示名。magpie 用它作为标题，而不是包名。
       */
      name: "Freebuff",

      /**
       * 供应商图标：从 Freebuff Desktop 的 Freebuff.exe 里提取的原始图标
       * （RT_GROUP_ICON → 256x256 PNG）。
       *
       * 必须内联成 data URI —— magpie 只读插件导出的对象，
       * 不会去磁盘上找 icon 文件。
       */
      icon: FREEBUFF_ICON,

      /**
       * 静态模型表兜底。
       *
       * ⚠ 为什么需要这个：magpie 在**未登录**时就会渲染供应商卡片，
       *   models() 拿不到账号只能返回空 → 界面显示 "0 models"，
       *   用户会以为插件坏了。
       *
       * 这里列的是 Freebuff 免费档的已知模型（2026-10-24 catalog 快照），
       * 登录后 models() 会用服务端返回的真实目录覆盖它。
       */
      models: STATIC_MODELS,

      // 只暴露 V4.1 Flash 一个模型。
      // 便宜的 MiMo 不进目录——它只用于手工验证 DSH 连通性（verify-dsh.mjs），
      // 不参与自动选型，也不该出现在用户的模型列表里。
      /**
       * 如实捕获模型目录。
       *
       * 过滤规则只有一条：**按 `access` 字段**
       *   access: "open"    → 免费档可用，全部列出
       *   access: "locked"  → 需要付费计划（lockedLabel: "Paid plan"），屏蔽
       *
       * 不再按「是不是 V4.1」去筛——那是用户的选择，不是插件该替用户决定的。
       * 早先只暴露 V4.1 一个，导致用户以为"捕获不到模型"。
       *
       * 价格（freebucks）仍会带在模型条目上，用户自己能看出哪个贵。
       */
      async models(provider, { auth } = {}) {
        const accounts = collectAccounts(auth)
        // ⚠ 未登录时不能返回空表 —— magpie 会显示 "0 models"，
        //   用户以为插件坏了。返回静态表兜底。
        //   注意不能用 provider.models：那指向本函数自身（同名覆盖），不是静态表。
        if (!accounts.length) return STATIC_MODELS

        for (const account of accounts) {
          try {
            const snap = await createClient(account).snapshot()
            // 只要 open 的；locked 的是付费计划专用
            const usable = snap.models.filter((m) => !m.locked && m.price != null)
            if (!usable.length) continue

            const out = {}
            for (const m of usable) {
              out[slug(m.name)] = modelEntry(m, `${HOST}/api/v1`)
            }
            log(
              `捕获 ${Object.keys(out).length} 个可用模型` +
                `（另有 ${snap.models.length - usable.length} 个付费计划专用已屏蔽）`,
            )
            return out
          } catch (e) {
            error(`拉模型目录失败（${account.label}）：${e.message}`)
          }
        }
        // 全部账号都拉失败 → 退回静态表，而不是空表
        return STATIC_MODELS
      },
    },

    auth: {
      provider: PROVIDER,

      methods: [
        {
          type: "oauth",
          label: "Freebuff account (browser sign-in)",
          authorize,
        },

        /**
         * 粘贴 token 直接登录。
         *
         * 为什么需要：浏览器登录要等 8 秒拿链接、再人工点。
         * 打不开浏览器（远程机 / 无头环境）就完全没法用。
         *
         * token 从哪来：官方 CLI 登录一次后，token 落在
         *   ~/.config/manicode/credentials.json 的 default.authToken
         * 用户把它粘贴进来即可。
         *
         * 这个登录方式**不验证 token**（登录时不发网络请求，避免 8 秒延迟），
         * 是否有效由后续第一次实际调用暴露。这样即使网络慢也能立刻完成登录。
         */
        {
          type: "oauth",
          label: "Freebuff token（粘贴已有 token）",
          prompts: [
            {
              type: "password",
              key: "token",
              message:
                "粘贴 Freebuff 的 authToken（36 位 UUID）。从 ~/.config/manicode/credentials.json 的 default.authToken 取，或从已登录的官方 CLI 里拿。",
            },
            {
              type: "text",
              key: "email",
              message: "账号邮箱（可选，仅用于界面显示；留空则自动生成标签）",
            },
          ],
          async authorize(inputs = {}) {
            const raw = typeof inputs.token === "string" ? inputs.token.trim() : ""
            if (!raw) {
              return { type: "failed", error: "没有填 token" }
            }
            // token 是 36 位 UUID；不合法就直接拒绝，省得后面一路 401
            if (!/^[0-9a-fA-F-]{20,64}$/.test(raw)) {
              return {
                type: "failed",
                error: "token 格式不对（应形如 3f2504e0-4f89-11d3-9a0c-0305e82c3301）",
              }
            }

            const deviceKey = generateDeviceKey()
            const installId = crypto.randomUUID()
            const email = typeof inputs.email === "string" ? inputs.email.trim() : ""

            const account = {
              host: HOST,
              token: raw,
              // userId 登录时不知道；第一次成功调用后由 snapshot 补上。
              // magpie 用 accountId 做展示，这里用邮箱或 token 前缀。
              userId: "",
              email: email || `token:${raw.slice(0, 8)}`,
              name: email || "Freebuff",
              installId,
              deviceKey,
              exhaustedUntil: 0,
            }
            const scope = scopeOf(HOST, account.userId || account.email)
            account.scope = scope

            // 尽力注册设备（失败不阻断 —— 可能是网络慢，后续调用会重试）
            try {
              const api = createClient(account)
              const keyId = await api.registerDevice(scope, deviceKey.publicKey)
              deviceKey.registrations[scope] = keyId
              log(`设备已注册：${keyId}`)
            } catch (e) {
              error(`设备注册失败（不影响登录，后续调用会重试）：${e.message}`)
            }

            log(`已添加 token 账号：${account.email}`)
            return {
              type: "success",
              refresh: JSON.stringify({
                host: HOST,
                userId: account.userId,
                email: account.email,
                name: account.name,
                installId,
                deviceKey,
                exhaustedUntil: 0,
              }),
              access: raw,
              accountId: account.email,
            }
          },
        },
      ],

      /**
       * 额度卡片。magpie 在 provider 下面显示这个。
       *
       * 免费档有两套额度同时生效，都显示：
       *   1. 今日 freebucks —— 5fb = 1 小时额度，每日 25fb
       *   2. 目标模型的每日次数 —— rateLimitsByModel，默认 6 次
       *
       * 再加一条会话状态（今天开没开过、还剩多久），这是用户最关心的。
       *
       * ⚠ 必须带缓存 ⚠
       *
       * 本机到 codebuff.com 的每个请求固定 ~8 秒，而 snapshot() 要掉两个接口。
       * magpie 会频繁刷这个卡片（界面重绘就刷一次），不缓存的话每次 16 秒，
       * 界面会一直转圈。缓存 60 秒足够——额度是按小时变的，不需要秒级精度。
       */
      async usage(getAuth, provider) {
        setAuthSource(getAuth)
        const auth = await getAuth()
        // ⚠ 用 collectAccounts，不能用 accountFromAuth！
        //
        // magpie 给的 auth 是「provider id → 账号记录」的映射
        // （{"freebuff":{...}, "freebuff#xxx":{...}}），
        // accountFromAuth 收到映射会返回 null → 卡片永远显示 "not signed in"。
        const accounts = collectAccounts(auth)
        const account = accounts[0]
        if (!account) return { error: "not signed in", windows: [] }

        // 缓存键用 userId，避免切换账号时串数据
        const cacheKey = account.userId || account.email || "default"
        const now = Date.now()
        const hit = usageCache.get(cacheKey)
        if (hit && now - hit.at < USAGE_CACHE_MS) {
          return hit.value
        }

        try {
          const api = createClient(account)
          const snap = await api.snapshot()
          const t = pickTarget(snap.models)
          const resetIso = snap.daily?.resetAt

          // ── 额度窗口 ──
          //
          // 数据全部来自服务端：
          //   freebucks.balance / daily.limit   → 剩余小时（5fb = 1H，每日 25fb = 5H）
          //   session.status / model / expiresAt → 当前会话的模型与实时剩余时间
          //
          // 不显示「次数」：那是每模型的会话次数池（6 次/天），
          // 而余额第一个就用完，次数永远碰不到，显示它只会误导。
          const DAILY_HOURS = (snap.daily?.limit ?? DAILY_FREEBUCKS) / HOURS_PER_FREEBUCKS
          const leftHours = (snap.balance ?? 0) / HOURS_PER_FREEBUCKS

          const si = sessionInfoOf(snap)
          const sessionActive = si.active && si.expiresAt > Date.now()

          const windows = []

          // 会话进行中：单独一条，显示「哪个模型 + 还剩多少分钟」
          if (sessionActive) {
            const leftMs = Math.max(0, si.expiresAt - Date.now())
            // session.model 是 catalog row key，还原成显示名
            const runningModel =
              snap.models.find((m) => m.key === si.model)?.name ?? si.model ?? "未知模型"
            const leftMin = Math.ceil(leftMs / 60_000)
            const usedMs = Math.min(SESSION_WINDOW_MS, SESSION_WINDOW_MS - leftMs)

            windows.push({
              name: "当前会话",
              used: SESSION_WINDOW_MS > 0 ? (usedMs / SESSION_WINDOW_MS) * 100 : 0,
              display: `${runningModel} · 剩余 ${leftMin} 分钟`,
              amount: leftMin,
              limit: Math.round(SESSION_WINDOW_MS / 60_000),
              unit: "分钟",
              // runsOutAt 让 magpie 自己算倒计时，不用等下次 usage 刷新
              runsOutAt: new Date(si.expiresAt).toISOString(),
            })
          }

          // 额度条：始终显示剩余小时
          windows.push({
            name: "剩余额度",
            used:
              DAILY_HOURS > 0
                ? Math.max(0, Math.min(100, ((DAILY_HOURS - leftHours) / DAILY_HOURS) * 100))
                : 0,
            display: `${fmtHours(leftHours)} / ${fmtHours(DAILY_HOURS)}H`,
            amount: Number(leftHours.toFixed(2)),
            limit: DAILY_HOURS,
            unit: "小时",
            ...(resetIso ? { resetsAt: resetIso } : {}),
          })

          const result = {
            ...(account.email ? { user: account.email } : {}),
            windows,
            signIn: "kept",
          }
          // 成功才缓存（失败不缓存，好让用户重试时立刻能重新查）
          usageCache.set(cacheKey, { at: now, value: result })
          return result
        } catch (e) {
          return { error: e?.message ?? String(e), windows: [] }
        }
      },

      async loader(getAuth, provider) {
        // ⚠ 关键：magpie 只把 getAuth 交给 loader/usage，client.auth 上没有 get。
        // 所以必须在这里把它注入给 pool，否则 pool 永远拿不到账号。
        setAuthSource(getAuth)

        const auth = await getAuth()
        const accounts = collectAccounts(auth)
        if (!accounts.length) return {}
        const id = provider?.id ?? PROVIDER

        return {
          baseURL: `${HOST}/api/v1`,
          apiKey: accounts[0].token || "freebuff",

          async fetch(input, init) {
            const fresh = await getAuth()
            const current = collectAccounts(fresh)
            if (!current.length) throw new Error("Freebuff 没有可用账号，请重新登录")

            const rawBody =
              init?.body == null
                ? null
                : typeof init.body === "string"
                  ? init.body
                  : await new Response(init.body).text()
            const body = rawBody ? JSON.parse(rawBody) : {}

            // 账号用 loader 刚拿到的 fresh（那是 magpie 给的、当前作用域内的账号），
            // 不再走 pool 内部的 authOf()——那条路在 magpie 里没有 get 可用。
            // 模型用请求里点名的那个（用户在界面上选的）。
            const { account, client: api, session, snapshot } = await pool.pick({
              directAuth: fresh,
              preferredModel: body.model ? resolveModelName(body.model) : null,
            })

            // ★ 冷却等待 ★
            //
            // 实测（2026-10-24）：连续调用会让服务端回 403 free_mode_cli_required，
            // 即使协议完全正确。账号静默 ≥120 秒后的第一次调用才能过。
            // 所以这里强制排队，宁可慢也不要把号打成 403。
            const acctId = account.userId || account.email || "default"
            const waited = await waitReady(acctId, CALL_GAP_MS, (ms) =>
              log(`${account.label} 冷却中，等待 ${Math.ceil(ms / 1000)} 秒`),
            )
            if (waited > 0) {
              log(`${account.label} 冷却完成（等了 ${Math.round(waited / 1000)} 秒）`)
            }
            markCall(acctId)

            // ⚠ handle 必须补全：复用服务端已有会话时（进程重启过），
            // 本地没有 handle，而 runId / chat 都靠它标识模型。
            // 空 handle 会让 /agent-runs 失败或返回的 runId 不被认。
            if (!session.handle) {
              const snapNow = await api.snapshot().catch(() => null)
              session.handle =
                snapNow?.models?.find((m) => m.key === session.modelKey)?.handle ?? ""
              if (!session.handle) {
                throw new Error(
                  `无法解析模型 handle（modelKey=${session.modelKey}），请重新开启会话`,
                )
              }
            }

            // ⚠⚠ runId 必须用「真值判断」，不能用 ?? ⚠⚠
            //
            // 踩过的坑：session.runId 被初始化为空字符串 ""，
            // 而 `"" ?? x` 的结果是 ""（空字符串不是 null/undefined），
            // 于是永远不去取 runId，导致发出
            //   codebuff_metadata: { run_id: "" }
            // 服务端报 400 "No runId found in request body"。
            //
            // 正确写法：`session.runId || (await api.runId(...))`
            const runId =
              session.runId ||
              (await api.runId({
                instanceId: session.instanceId,
                modelHandle: session.handle,
              }))
            session.runId = runId

            // ★★★ 请求侧：规范化消息 + 透传 tools ★★★
            //
            // 两件事必须做：
            //   1. DSH 发的是 role:'tool' + 驼峰 toolCallId，而 freebuff 的
            //      openai-compatible 适配器要 role:'tool' + 下划线 tool_call_id。
            //      不做转换 → tool_calls 被服务端忽略或 400。
            //   2. tools / tool_choice 必须透传，否则模型看不到可用工具。
            //
            // freebuff 的 user 消息 content 是 [{type:'text',text}]，其它角色用字符串。
            const outgoing = { ...body }
            if (Array.isArray(body.messages)) {
              outgoing.messages = serializeMessages(body.messages, (text) => [
                { type: "text", text },
              ])
              // 把 DSH 的 system prompt 并入首条 user 消息（保留 Buffy 的 system）
              const sysMsg = body.messages.find((m) => m?.role === "system")
              if (sysMsg) {
                const sysText =
                  typeof sysMsg.content === "string"
                    ? sysMsg.content
                    : JSON.stringify(sysMsg.content)
                const idx = outgoing.messages.findIndex(
                  (m) => m.role === "user" && Array.isArray(m.content),
                )
                const tag = `[Instructions from the calling application]\n${sysText}\n[End of instructions]`
                if (idx >= 0) {
                  const first = outgoing.messages[idx].content[0]
                  first.text = tag + "\n\n" + (first.text ?? "")
                } else {
                  outgoing.messages.unshift({ role: "user", content: [{ type: "text", text: tag }] })
                }
              }
            }
            if (Array.isArray(body.tools) && body.tools.length) {
              outgoing.tools = body.tools
              outgoing.tool_choice = body.tool_choice ?? "auto"
              log(`${account.label} 附带 ${body.tools.length} 个工具定义`)
            }

            const res = await api.complete({
              modelKey: session.modelKey,
              modelHandle: session.handle,
              runId,
              instanceId: session.instanceId,
              // ★ attemptId 必须传下去：chat 的 trace_session_id 要用它，
              //   传错会导致 403 free_mode_cli_required。
              attemptId: session.attemptId,
              body: outgoing,
            })

            // 402：额度真的用完了，标记该号并告诉上层切号
            if (res.status === 402) {
              // ⚠ 重置时间必须取自 snapshot.daily.resetAt（服务端的太平洋午夜），
              // 早先错写成 session.daily（不存在）→ 兜底成「24 小时后」，
              // 于是提示恢复时间变成了 10/25 04:25，而真实是 10/24 15:00。
              const until = resetAtOf(snapshot)
              account.exhaustedUntil = until
              await markDead(account, until)
              pool.sessions.delete(pool.keyOf(account))
              error(`${account.label} 额度已耗尽，到 ${new Date(until).toLocaleString()} 恢复`)
              return new Response(
                JSON.stringify({
                  error: {
                    type: "rate_limit_error",
                    message: `Freebuff 账号 ${account.label} 额度已用尽，将在 ${new Date(until).toLocaleString()} 恢复。已自动切换下一个账号。`,
                  },
                }),
                { status: 429, headers: { "content-type": "application/json" } },
              )
            }

            // ── 403 free_mode_cli_required ──
            //
            // 实测语义（2026-10-24）：
            //   1. 余额为 0 → 服务端一律 403（与协议无关）
            //   2. 连续调用（间隔 <120s）→ 403（惩罚性回退）
            //   3. 协议缺项 → 403（但插件已对齐，正常不会发生）
            //
            // 处理：标记冷却，让 pool 换下一个号；都不可用就报 429。
            if (res.status === 403) {
              const code = safeParse(res.text)?.error ?? ""
              if (String(code).includes("free_mode_cli_required")) {
                const until = resetAtOf(snapshot)
                const noBalance = (snapshot?.balance ?? 0) <= 0
                if (noBalance) {
                  // 余额真没了：按「额度耗尽」处理，等重置
                  account.exhaustedUntil = until
                  await markDead(account, until)
                  pool.sessions.delete(pool.keyOf(account))
                  error(`${account.label} 余额为 0，服务端拒绝免费模式，等 ${new Date(until).toLocaleString()} 重置`)
                  return new Response(
                    JSON.stringify({
                      error: {
                        type: "rate_limit_error",
                        message: `Freebuff 账号 ${account.label} 今日额度已用尽（0 fb），将在 ${new Date(until).toLocaleString()} 重置。已切换下一个账号。`,
                      },
                    }),
                    { status: 429, headers: { "content-type": "application/json" } },
                  )
                }
                // 还有余额但被拒：多半是冷却，短退避后重试
                error(`${account.label} 被拒（可能是冷却中），建议等 90 秒再试`)
                return new Response(
                  JSON.stringify({
                    error: {
                      type: "rate_limit_error",
                      message: `Freebuff 账号 ${account.label} 暂时被限流（连续请求过快）。请等约 90 秒再试，或换用其他模型。`,
                    },
                  }),
                  {
                    status: 429,
                    headers: { "content-type": "application/json", "retry-after": "90" },
                  },
                )
              }
            }

            // ── 503 模型暂时不可用 ──
            //
            // 这不是错误：503 说明**协议已全部通过**，只是模型侧短暂不可用。
            // 退避 20 秒后重试同一请求是安全的（不会扣费）。
            if (res.status === 503) {
              error(`${account.label} 模型暂时不可用（503），协议已通过，稍后重试`)
              return new Response(
                JSON.stringify({
                  error: {
                    type: "server_error",
                    message: `Freebuff 模型暂时不可用（503）。这不是账号问题，稍等 20 秒重试即可。`,
                  },
                }),
                {
                  status: 503,
                  headers: { "content-type": "application/json", "retry-after": "20" },
                },
              )
            }

            // 会话过期/被顶：清掉，下次会走新号（不重开，因为重开要再烧额度）
            if (res.status === 409 || res.status === 410) {
              const until = resetAtOf({ daily: session.daily })
              session.expiresAt = 0
              account.exhaustedUntil = until
              await markDead(account, until)
              pool.sessions.delete(pool.keyOf(account))
              error(`${account.label} 会话已结束（1 小时窗口用完），今天不再重开`)
              return new Response(
                JSON.stringify({
                  error: {
                    type: "rate_limit_error",
                    message: `Freebuff 账号 ${account.label} 的 1 小时会话已结束。额度按小时计费、不可暂停或续期，今天该账号不再可用，已自动切换下一个账号。`,
                  },
                }),
                { status: 429, headers: { "content-type": "application/json" } },
              )
            }

            if (res.status !== 200) {
              return new Response(res.text, {
                status: res.status,
                headers: { "content-type": "application/json" },
              })
            }

            // ★★★ chat 返回的是 SSE，不是 JSON ★★★
            //
            // call() 用 JSON.parse(text) 解析，对 SSE 必然失败 → json 为 null，
            // 于是旧代码走 `JSON.stringify(null)` → 返回字符串 "null" 给 magpie，
            // magpie 再转给 DSH → DSH 收到 null，表现为「拿到了 200 但没内容」。
            //
            // 正确做法：用 parseFreebuffSSE 解析 SSE，提取文本与 tool_calls。
            const parsed = parseFreebuffSSE(res.text)

            const hasTools = parsed.toolCalls.length > 0

            // 既没有 tool_calls 也没有文本 → 空响应，明确报错而不是静默返回 null
            if (!hasTools && !parsed.text) {
              error(
                `${account.label} 返回 200 但没有可解析内容（SSE 长度 ${res.text?.length ?? 0}）`,
              )
              return new Response(
                JSON.stringify({
                  error: {
                    type: "server_error",
                    message: "Freebuff 返回 200 但响应体里没有可解析的文本或工具调用。",
                  },
                }),
                { status: 502, headers: { "content-type": "application/json" } },
              )
            }

            const payload = {
              id: `chatcmpl-${Date.now().toString(36)}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: slug(session.name),
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    // 纯 tool_calls 时 content 必须是 null（OpenAI 规范）
                    content: parsed.text && parsed.text.length ? parsed.text : hasTools ? null : "",
                    ...(hasTools ? { tool_calls: parsed.toolCalls } : {}),
                  },
                  finish_reason: parsed.finishReason,
                },
              ],
              usage: {
                prompt_tokens: parsed.usage?.prompt_tokens ?? 0,
                completion_tokens: parsed.usage?.completion_tokens ?? 0,
                total_tokens: parsed.usage?.total_tokens ?? 0,
                freebuff_credits: parsed.usage?.cost ?? 0,
              },
            }

            if (hasTools) {
              log(
                `${account.label} 工具调用: ${parsed.toolCalls.map((t) => t.function.name).join(", ")}`,
              )
            }

            return new Response(JSON.stringify(payload), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          },
        }
      },
    },
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * 把请求里的 model 字段还原成「给 pickTarget 做模糊匹配用的名字」。
 *
 * 客户端（magpie / DSH）发来的可能是：
 *   freebuff/mimo-v2.6-flash-slow     ← 带 provider 前缀 + slug
 *   mimo-v2.6-flash-slow             ← slug
 *   m-00032eaeec                     ← catalog row key
 * 而 pickTarget 是按 displayName 模糊匹配的，所以要把 slug 还原成
 * 「词之间用空格」的形式：mimo-v2.6-flash-slow → mimo v2.6 flash slow
 */
function resolveModelName(model) {
  if (!model || typeof model !== "string") return null
  let s = model.trim()
  // 去掉 provider 前缀
  const slash = s.indexOf("/")
  if (slash >= 0) s = s.slice(slash + 1)
  // catalog row key（m-xxxxxxxxxx）原样返回，pickTarget 会按 key 精确匹配
  if (/^m-[0-9a-f]+$/i.test(s)) return s
  // slug → 空格分隔，便于大小写无关的子串匹配
  return s.replace(/[-_]+/g, " ")
}

/** 把模型条目转成 magpie / OpenCode 认的 provider model 形状。 */
function modelEntry(m, apiBase) {
  return {
    id: slug(m.name),
    providerID: PROVIDER,
    name: m.name,
    api: { id: m.key, url: apiBase, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // context 用模型真实上下文窗口（V4.1 = 1048576 = 1M）。
    // 不要用 compaction.maxContextLength（那是自动压缩阈值 400K）。
    limit: { context: m.contextWindow || 1_048_576, output: 64_000 },
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: m.multimodal,
      toolcall: true,
      input: { text: true, image: m.multimodal, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export const _internal = { PROVIDER, HOST, slug, pickTarget, FreebuffError }
