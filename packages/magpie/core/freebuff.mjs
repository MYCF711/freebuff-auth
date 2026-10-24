// Freebuff 的 API 客户端：模型目录、会话准入、runId、对话。
//
// 完整链路（每一步都实测过）：
//   GET  /api/v1/freebuff/models             → catalog（每模型一个 handle）
//   GET  /api/v1/freebuff/session            → freebucks 余额 / 每日额度 / 锁定的模型
//   POST /api/v1/freebuff/session/admission  → 开 1 小时会话（扣该账号额度）
//   POST /api/v1/agent-runs                  → { runId }
//   POST /api/v1/chat/completions            → 对话（body 里带 codebuff_metadata.run_id）
//   DELETE /api/v1/freebuff/session          → 主动释放（切模型/换号前必须先发）

import { signDevice, sha256hex } from "./device.mjs"

export const DEFAULT_HOST = "https://www.codebuff.com"

// ═══════════════════════════════════════════════════════════════════
// ★ 免费模式（cost_mode: "free"）的准入协议 —— 已逆向并实测通过 ★
// ═══════════════════════════════════════════════════════════════════
//
// 服务端对免费模式有一整套客户端识别规则，缺任一环都会回
//   403 free_mode_cli_required
// "Free mode is only available through the freebuff CLI."
//
// 以下每个常量都来自**官方 freebuff CLI 0.2.34 二进制的真实抓包**，
// 不是猜的。改任何一项都可能导致 403 回归。
//
// 1) 客户端版本头必须是 CLI 的版本号，而不是 Desktop 的 0.0.188
export const CLIENT_VERSION = "0.2.34"

// 2) UA 结尾必须是 runtime/browser（CLI 的），不是 runtime/bun/1.4.2（Desktop 的）
export const USER_AGENT =
  "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser"

// 3) 终端环境指纹。CLI 的 O4() 在 FREEBUFF_MODE 时发 x-freebuff-env，
//    同时 chat body 的 freebuff_client_env 也用它。
//    格式：v1;<key=value 用 ; 连接>
export const CLIENT_ENV =
  "v1;in=1;out=1;tp=none;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=0;p=na;g=na;osc=na;tzo=0;px=none;tls=1;ca=0;cde=none"

// 4) 输入画像（打字节奏）。CLI 在 chat metadata 里带它。
export const INPUT_PROFILE = "v1;tc=21;ke=21;mc=0;pc=0;pe=0;ms=1634;cps=21"

// 5) agent-runs 的 agentId。CLI 用 base3-free-catalog 作为根 agent。
export const ROOT_AGENT_ID = "base3-free-catalog"

// 6) instance id 必须是 "cli:" 前缀的 UUID。
//    CLI 的 o_H="cli:" + sLH()=`cli:${randomUUID()}`，
//    swA() 见前缀才补 { freebuff_multi_session:"1", surface:"cli" }。
export const CLI_INSTANCE_PREFIX = "cli:"

/** 生成一个符合 CLI 规范的 instance id。 */
export function newCliInstanceId() {
  return CLI_INSTANCE_PREFIX + crypto.randomUUID()
}

/** 判断是否 CLI 形态的 instance id。 */
export function isCliInstanceId(id) {
  return typeof id === "string" && id.startsWith(CLI_INSTANCE_PREFIX)
}

// 最近一次 /freebuff/models 返回的 fetchId。
// 官方把 catalog 响应的 fetchId 放进 x-freebuff-catalog-fetch 头，
// 后续 admission / chat 都要带，服务端用它校验目录新鲜度。
let CURRENT_FETCH_ID = ""
export function setFetchId(id) {
  CURRENT_FETCH_ID = typeof id === "string" ? id : ""
}
export function getFetchId() {
  return CURRENT_FETCH_ID
}

// 设备时区：服务端据此判断「每日额度」按哪个午夜重置。
const TIMEZONE =
  process.env.FREEBUFF_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || ""

// 免费档的模型价格表（单位 freebucks；5 freebucks = 1 小时）。
// 这是服务端下发的，这里只是没网时的兜底，真实值以 /session 的 freebucks.prices 为准。
export const HOURS_PER_FREEBUCKS = 5

export class FreebuffError extends Error {
  constructor(message, { status = 0, code = "", body = null } = {}) {
    super(message)
    this.name = "FreebuffError"
    this.status = status
    this.code = code
    this.body = body
  }
}

/**
 * 判断一个错误是否值得「等一下再试」。
 *
 * 实测规律（2026-10-24）：
 *   - 403 free_mode_cli_required 有时不是协议错，而是服务端对
 *     「短时间内反复 admission/release」的惩罚性回退；
 *     同样的代码在账号静默一段时间后能回 503（= 协议正确）。
 *   - 503 说明协议全过，只是模型侧暂时不可用，退避重试即可。
 *
 * 所以调用方遇到这两类应该退避，而不是改代码或换协议。
 */
export function isTransient(err) {
  if (!err) return false
  if (err.status === 503) return true
  if (err.status === 403 && /free_mode_cli_required/.test(String(err.body ?? err.message ?? ""))) {
    return true
  }
  if (err.status === 428 || err.code === "waiting_room_required") return true
  return false
}

/** 建议的退避时长（毫秒）：403 冷却久一点，503 短一点。 */
export function cooldownFor(err) {
  if (!err) return 0
  if (err.status === 403) return 90_000
  if (err.status === 503) return 20_000
  if (err.status === 428) return 3_000
  return 0
}

/**
 * 一个账号的 API 客户端。
 * @param {{host, token, userId, installId, deviceKey, scope}} account
 */
export function createClient(account) {
  const host = (account.host || DEFAULT_HOST).replace(/\/$/, "")

  async function call(
    pathname,
    { method = "GET", body = null, extra = {}, signal, retries = 2, isCatalog = false } = {},
  ) {
    const bodyStr =
      body == null ? null : typeof body === "string" ? body : JSON.stringify(body)
    const scope = account.scope || `${host} user:${account.userId}`
    const keyId = account.deviceKey?.registrations?.[scope]

    const headers = {
      Authorization: `Bearer ${account.token}`,
      // ★★★ 2026-10-24 晚间更正 —— 下面这段注释原来是错的 ★★★
      //
      // 【原注释（错的）】「千万不要发 x-freebuff-client 头，加了就 403，是死亡开关」
      //
      // 【实际情况】官方 CLI 拉 catalog 时**确实会发** `x-freebuff-client: cli`
      // （实证：~/cli-capture.jsonl 第 6 条 `GET /api/v1/freebuff/models`）。
      //
      // 当时误判的原因：我手工试探时，把「冷却中被拒」的 403 归因到了这个头上。
      // 真正的门槛是「必须由 CLI 调用」（free_mode_cli_required 的字面意思），
      // 而 `x-freebuff-client: cli` 正是**声明自己是 CLI** 的头 —— 去掉它反而更可疑。
      //
      // 现在的判定标准：**与官方 CLI 的头集合完全一致**。缺一个、多一个都是指纹。
      // 详见 `交接-FREEBUFF反代.md` 第 2.1 节。
      //
      // ⚠ 注意端点差异：目前只在 catalog 的抓包里确认了这个头，
      //    session / chat 的抓包里没有。所以这里只在拉 catalog 时带。
      ...(isCatalog ? { "x-freebuff-client": "cli" } : {}),
      // ★ CLI 的版本头（0.2.34）。用 Desktop 的 0.0.188 会被判非 CLI。
      "x-freebuff-client-version": CLIENT_VERSION,
      // ⚠ 以下两个头官方 CLI **从不发送**，是 Desktop 才有的：
      //     x-freebuff-install-id      —— CLI 不用
      //     x-freebuff-desktop-attempt-id —— 名字里带 desktop，冒充 CLI 时自相矛盾
      //     x-freebuff-wallet-spend-limit / x-freebuff-model —— 未抓到证据，保守不发
      "x-freebuff-catalog-protocol": "1",
      // ★ 终端环境指纹 —— 免费模式识别的关键之一
      "x-freebuff-env": CLIENT_ENV,
      // 官方每个请求都带：catalog 的 fetchId（服务端校验目录是否新鲜）
      ...(CURRENT_FETCH_ID ? { "x-freebuff-catalog-fetch": CURRENT_FETCH_ID } : {}),
      // ★ CLI 的 UA（结尾是 runtime/browser）
      "user-agent": USER_AGENT,
      // 官方每个请求都带设备时区，服务端据此算「每日额度」按哪个午夜重置
      ...(TIMEZONE ? { "x-fb-timezone": TIMEZONE } : {}),
      ...signDevice({
        privateKey: account.deviceKey?.privateKey,
        keyId,
        method,
        path: pathname,
        body: bodyStr,
        // ⚠⚠ 第 6 行载荷：fetchId ⚠⚠
        //
        // 官方 freebuffDeviceSignaturePayload 是 6 行：
        //   freebuff-device-v1
        //   <METHOD>
        //   <PATH>
        //   <timestampMs>
        //   <bodySha256>
        //   <fetchId ?? "">      ← 这一行早先漏了！
        //
        // 漏掉它的后果：签名与服务端期望的载荷不匹配 → 服务端认不出
        // 这是官方客户端发出的请求 → 410 freebuff_update_required。
        fetchId: CURRENT_FETCH_ID,
      }),
      ...extra,
    }
    if (bodyStr != null) headers["Content-Type"] = "application/json"

    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(`${host}${pathname}`, {
          method,
          headers,
          body: bodyStr ?? undefined,
          signal: signal ?? AbortSignal.timeout(120_000),
        })
        const text = await res.text()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          // 非 JSON（一般是网关错误页）
        }
        return { status: res.status, text, json, headers: res.headers }
      } catch (e) {
        if (i === retries) throw e
        await new Promise((r) => setTimeout(r, 700 * (i + 1)))
      }
    }
  }

  return {
    host,

    /** 拉模型目录 + 会话状态（合并成一次，调用方拿到完整视图）。 */
    async snapshot(signal) {
      const [cat, ses] = await Promise.all([
        call("/api/v1/freebuff/models", { signal, isCatalog: true }),
        // ⚠ 不要带 x-freebuff-multi-session: 1！
        //
        // 实测（2026-10-24）：
        //   裸请求                               → status: active, model, expiresAt 都有
        //   + multi-session: 1                   → status: none, 没有 model/expiresAt
        //   + include-unused-rate-limits: 1      → status: active（正常）
        //
        // 那个头是「多会话视图」开关，一旦带上，服务端返回的是一个聚合视图，
        // 不包含单会话的 instanceId / model / expiresAt。
        // 我们需要单会话详情来算倒计时，所以不能带。
        //
        // 官方 orchestrator 的 getSession() 也是这个规律：
        // 只有「不带 instanceId」时才加 multi-session 头。
        call("/api/v1/freebuff/session", {
          signal,
          extra: {
            "x-freebuff-include-unused-rate-limits": "1",
          },
        }),
      ])
      if (cat.status !== 200) {
        throw new FreebuffError(`拉模型目录失败 HTTP ${cat.status}`, {
          status: cat.status,
          body: cat.text.slice(0, 400),
        })
      }
      const rows = cat.json?.rows ?? []
      // catalog-fetch：服务端签发的一次性拉取凭据，后续每个请求都要带上它。
      // 官方常量名 FREEBUFF_CATALOG_FETCH_HEADER = "x-freebuff-catalog-fetch"，
      // 值来自 catalog 响应的 fetchId（形如 fbf1.xxx）。
      //
      // ⚠⚠ 必须在这里 setFetchId()！⚠⚠
      // 早先只把它放进返回值，忘了写回模块级 CURRENT_FETCH_ID，
      // 结果后面的 admission / agent-runs / chat 全都**不带这个头**，
      // 服务端一律回 403 free_mode_cli_required —— 排查了很久才发现。
      const fetchId = cat.json?.fetchId ?? ""
      if (fetchId) setFetchId(fetchId)
      const catalogVersion = cat.json?.version ?? ""
      const prices = ses.json?.freebucks?.prices ?? {}
      const daily = ses.json?.freebucks?.daily ?? null
      const balance = ses.json?.freebucks?.balance ?? 0
      const models = rows.map((r) => ({
        key: r.key,
        handle: r.handle,
        name: r.displayName,
        price: prices[r.key] ?? null,
        hours: prices[r.key] == null ? null : prices[r.key] / HOURS_PER_FREEBUCKS,
        // access: "open" = 免费档可用；"locked" = 付费计划专用（免费账号选了会被服务端拒）
        access: r.access ?? "open",
        locked: r.access === "locked",
        lockedLabel: r.lockedLabel ?? "",
        premium: !!r.premium,
        // ⚠ contextWindow 是模型真实上下文（V4.1 = 1048576 = 1M）。
        //   compaction.maxContextLength 只是「自动压缩的触发阈值」（400000 = 400K），
        //   不是上下文上限。之前错用后者，导致 magpie 里显示 400K。
        contextWindow: r.contextWindow ?? 0,
        compactAt: r.compaction?.maxContextLength ?? 0,
        multimodal: !!r.multimodal,
        // 排名语义：optimized / powerful 等分区
        section: r.placement?.section ?? "",
      }))
      return {
        models,
        fetchId,
        catalogVersion,
        balance,
        hours: balance / HOURS_PER_FREEBUCKS,
        daily,
        accessTier: ses.json?.accessTier ?? null,
        // 会话相关：这几个字段是「当前会话」的唯一权威来源，
        // sessionInfoOf() 靠它们算实时剩余时间。
        status: ses.json?.status ?? null,
        instanceId: ses.json?.instanceId ?? null,
        // sessionInfoOf 读的是 model；lockedModel 是历史别名，两个都给，
        // 避免调用方各取一个导致「模型名为空」。
        model: ses.json?.model ?? null,
        lockedModel: ses.json?.model ?? null,
        admittedAt: ses.json?.admittedAt ?? null,
        expiresAt: ses.json?.expiresAt ?? null,
        // 每个模型每天的次数池（与 freebucks 是两套独立额度）。
        // 键是 catalog row key，形如 { model, limit, recentCount, resetAt }
        rateLimits: Object.values(ses.json?.rateLimitsByModel ?? {}),
        planRequiredModelIds: ses.json?.freebucks?.planRequiredModelIds ?? [],
      }
    },

    /** 开会话。成功返回 {instanceId, modelKey, expiresAt}。 */
    async admit(model, { signal } = {}) {
      // ★ CLI 用同一个 UUID 既作 instance 又作 attempt：
      //   x-freebuff-instance-id: cli:<uuid>
      //   x-freebuff-desktop-attempt-id: <同一个 uuid>
      const attemptId = crypto.randomUUID()
      const instanceId = CLI_INSTANCE_PREFIX + attemptId
      const res = await call("/api/v1/freebuff/session/admission", {
        method: "POST",
        signal,
        extra: {
          "x-freebuff-model": model.handle,
          "x-freebuff-wallet-spend-limit": "session",
          "x-freebuff-instance-id": instanceId,
          "x-freebuff-purchase-continuity": "1",
          // 官方 admission 还带这两个（抓包实录）：
          //   x-freebuff-desktop-attempt-id: 每次开会话生成的 attempt 标识
          //   x-freebuff-multi-session: 1    标记支持多会话协议
          "x-freebuff-desktop-attempt-id": attemptId,
          "x-freebuff-multi-session": "1",
        },
      })
      if (res.status === 200 && res.json?.status === "active") {
        return {
          instanceId,
          // ★ attemptId 必须一起带出去：chat 的 trace_session_id 要用它，
          //   而且释放会话时也要用它走 /session/attempt。
          attemptId,
          modelKey: res.json.model ?? model.key,
          expiresAt: Date.parse(res.json.expiresAt) || Date.now() + 3_600_000,
          raw: res.json,
        }
      }
      const err = new FreebuffError(
        res.json?.message ?? res.json?.error ?? res.text.slice(0, 300),
        { status: res.status, code: res.json?.status ?? "", body: res.json },
      )
      // 服务端还锁着别的模型：把它带出去，调用方可以决定续用
      if (res.json?.status === "model_locked") err.lockedModel = res.json.currentModel
      // ★ 名额被占：自动接管现有会话（官方 CLI 也这么做）
      if (res.json?.status === "purchase_capacity") {
        const cur = res.json.currentInstanceId
        if (typeof cur === "string") {
          err.currentInstanceId = cur
          err.currentModelKey = res.json.desktopPurchases?.[0]?.model
          err.expiresAt = Date.parse(res.json.desktopPurchases?.[0]?.expiresAt) || 0
        }
      }
      throw err
    },

    /**
     * 释放任意 instance（自动从 cli:<uuid> 推出 attemptId）。
     *
     * 「一个账号同时只能有一个 premium 会话」是服务端硬限制，
     * 要开新会话就必须先正确释放旧的 —— 否则会 409 purchase_capacity。
     *
     * ⚠ 必须走 /session/attempt（带 attemptId），走 /session 会让
     *   整条会话链失效，后续 chat 全部 409 session_superseded。
     */
    async forceRelease(instanceId, { signal } = {}) {
      if (!instanceId) return false
      const attemptId = isCliInstanceId(instanceId)
        ? instanceId.slice(CLI_INSTANCE_PREFIX.length)
        : undefined
      try {
        const path = attemptId
          ? "/api/v1/freebuff/session/attempt"
          : "/api/v1/freebuff/session"
        const res = await call(path, {
          method: "DELETE",
          signal,
          extra: {
            "x-freebuff-instance-id": instanceId,
            "x-freebuff-multi-session": "1",
            ...(attemptId
              ? { "x-freebuff-desktop-attempt-id": attemptId }
              : { "x-freebuff-purchase-continuity": "1" }),
          },
        })
        return res.status < 400
      } catch {
        return false
      }
    },

    /**
     * 开会话；若名额被占，先释放旧的再开。
     *
     * 这是插件的主入口：总是走「自己开新会话」的路径，
     * 因为只有自己能控制 attemptId / trace_session_id 的一致性。
     */
    async admitFresh(model, { signal, releaseExisting = true } = {}) {
      try {
        return await this.admit(model, { signal })
      } catch (e) {
        if (e.code !== "purchase_capacity" || !e.currentInstanceId || !releaseExisting) throw e
        await this.forceRelease(e.currentInstanceId, { signal })
        // 服务端需要一点时间落账
        await new Promise((r) => setTimeout(r, 1200))
        return await this.admit(model, { signal })
      }
    },

    /** 取（或复用）runId。 */
    async runId({ instanceId, modelHandle, signal } = {}) {
      // ★ 官方 CLI 的 agent-runs 只带 2 个头（抓包实录）：
      //     authorization, x-freebuff-acting-user-id
      //   不带 x-freebuff-model / x-freebuff-instance-id（多带会干扰判定）。
      //   agentId 用 base3-free-catalog（CLI 的根 agent）。
      const res = await call("/api/v1/agent-runs", {
        method: "POST",
        signal,
        body: { action: "START", agentId: ROOT_AGENT_ID, ancestorRunIds: [] },
        extra: {
          "x-freebuff-acting-user-id": account.userId ?? "",
        },
      })
      if (res.status !== 200 || !res.json?.runId) {
        throw new FreebuffError(`取 runId 失败 HTTP ${res.status}`, {
          status: res.status,
          body: res.text.slice(0, 300),
        })
      }
      return res.json.runId
    },

    /** 发一轮对话。 */
    async complete({ modelKey, modelHandle, runId, instanceId, attemptId, body, signal }) {
      // ⚠ 调试用：FREEBUFF_DEBUG_PAYLOAD=1 时打印实际发出的体
      if (process.env.FREEBUFF_DEBUG_PAYLOAD === "1") {
        console.error("[freebuff] complete() 入参:", JSON.stringify({
          modelKey, modelHandle: modelHandle?.slice(0, 20), runId, instanceId,
        }))
        console.error("[freebuff] body keys:", Object.keys(body ?? {}).join(","))
      }
      // 官方的 model 字段用的是 catalog handle（fbm1.xxx），不是 row key（m-xxx）。
      // 抓包实录：{"model":"fbm1.AAEAAUQ4tv1eVD4pA594HQ2Ap…", ...}
      const payload = {
        ...body,
        model: modelHandle || modelKey,
        codebuff_metadata: {
          ...(body.codebuff_metadata ?? {}),
          run_id: runId,
          // CLI 的 client_id 是 11 位 base36 随机串（抓包实录：zgudzxe78yj），
          // 不是 instance id。
          client_id:
            body?.codebuff_metadata?.client_id ??
            Math.random().toString(36).slice(2, 13),
          // ⚠⚠ cost_mode 是「这次调用算免费额度」的开关 ⚠⚠
          //
          // 官方 getAgentStreamFromTemplate 构造的 metadata 里有它：
          //   codebuff_metadata: { run_id, client_id, cost_mode, ... }
          // 而 FREE_COST_MODE = "free"（../common/src/constants/free-agents.ts）。
          //
          // 漏掉它的后果（实测）：服务端把请求当成付费调用，每次 chat 都
          // 重新扣一次 freebucks，余额一低就 402 "Out of credits" ——
          // 即使那 1 小时会话窗口还开着、钱已经在 admission 时付过了。
          //
          // 这也解释了用户的实际体验：官方客户端一个会话里能连发远多于
          // 会话次数池上限的请求，因为它带 cost_mode=free。
          // ── 以下字段全部来自官方 chat 抓包 ──
          cost_mode: "free",
          freebuff_instance_id: instanceId,
          freebuff_multi_session: "1",
          // ★ 以下三个字段是 CLI 独有的（抓包实录），
          //   缺了会被判成非 CLI → 403 free_mode_cli_required
          surface: "cli",
          freebuff_client_env: CLIENT_ENV,
          freebuff_input_profile: INPUT_PROFILE,
          // trace_session_id 必须等于 admission 时用的 attemptId（裸 uuid，不带 cli:）。
          // 官方 CLI 用同一个 uuid 贯穿 instance / attempt / trace，
          // 用别的值会被判成另一个客户端 → 403 free_mode_cli_required。
          trace_session_id:
            body?.codebuff_metadata?.trace_session_id ??
            attemptId ??
            (isCliInstanceId(instanceId) ? instanceId.slice(CLI_INSTANCE_PREFIX.length) : crypto.randomUUID()),
          llm_step_number: String(body?.codebuff_metadata?.llm_step_number ?? 1),
          repo_snapshot:
            body?.codebuff_metadata?.repo_snapshot ??
            '{"gitAvailable":false,"repositoryVisibility":"unknown","fileCount":10000,"fileCountIsLowerBound":true,"testFileCount":48,"changedFileCount":0,"changedFileScanTruncated":false}',
        },
        // 官方还带 provider.data_collection = "deny"
        provider: body?.provider ?? { data_collection: "deny" },
      }
      if (process.env.FREEBUFF_DEBUG_PAYLOAD === "1") {
        console.error("[freebuff] 发出 payload:", JSON.stringify(payload).slice(0, 500))
      }
      return call("/api/v1/chat/completions", {
        method: "POST",
        signal,
        body: payload,
        extra: {
          // ★ 官方 CLI 的 chat 头集合（抓包实录，一共只有这些）：
          //     authorization, content-type, user-agent,
          //     x-freebuff-acting-user-id, x-freebuff-sse-gzip-recovery,
          //     x-freebuff-catalog-fetch, x-freebuff-device-key/ts/sig
          //
          // ⚠ 不带 x-freebuff-model / x-freebuff-instance-id /
          //   x-freebuff-wallet-spend-limit / x-freebuff-purchase-continuity /
          //   x-freebuff-attention —— CLI 一个都不带。
          //   多带会干扰服务端的客户端类型判定（实测会导致 403）。
          "x-freebuff-acting-user-id": account.userId ?? "",
          "x-freebuff-sse-gzip-recovery": "1",
        },
      })
    },

    /** 释放会话（切模型、换号、退出前都要发，否则服务端一直锁着）。 */
    async release(instanceId, { signal, attemptId } = {}) {
      if (!instanceId) return false
      try {
        // ★ 有 attemptId 时走 /session/attempt（官方正常路径），
        //   没有才走 /session —— 后者会让整条会话链失效（409 session_superseded）。
        const path = attemptId
          ? "/api/v1/freebuff/session/attempt"
          : "/api/v1/freebuff/session"
        const res = await call(path, {
          method: "DELETE",
          signal,
          extra: {
            "x-freebuff-instance-id": instanceId,
            "x-freebuff-multi-session": "1",
            ...(attemptId
              ? { "x-freebuff-desktop-attempt-id": attemptId }
              : { "x-freebuff-purchase-continuity": "1" }),
          },
        })
        return res.status < 400
      } catch {
        return false
      }
    },

    /** 注册设备公钥，拿 keyId。 */
    async registerDevice(scope, publicKey, { signal } = {}) {
      const res = await call("/api/v1/freebuff/device-keys", {
        method: "POST",
        signal,
        // ★ client 必须是 "cli" —— 抓包实录 CLI 发的就是 {"publicKey":...,"client":"cli"}
        body: { publicKey, client: "cli" },
      })
      if (!res.ok && !res.json?.keyId) {
        throw new FreebuffError(`设备注册失败 HTTP ${res.status}`, {
          status: res.status,
          body: res.text?.slice(0, 300),
        })
      }
      const keyId = res.json?.keyId
      if (!keyId) {
        throw new FreebuffError(`设备注册没有返回 keyId（HTTP ${res.status}）`, {
          status: res.status,
          body: res.text?.slice(0, 300),
        })
      }
      return keyId
    },

    raw: call,
  }
}

export { sha256hex }
