// 账号池：一个号一天一次会话，用完自动换下一个。
//
// 判据全部来自服务端（billing.mjs 的 decide）：
//   session.status / expiresAt  —— 会话活没活、还有多久
//   freebucks.balance           —— 够不够开下一次
//
// 本模块只负责「按顺序找一个能用的号」和「把结果落盘」，
// 不再自己维护一套本地状态机（那会和服务端不一致）。

import {
  createClient,
  FreebuffError,
  HOURS_PER_FREEBUCKS,
  CLI_INSTANCE_PREFIX,
  isCliInstanceId,
} from "./freebuff.mjs"
import { decide, describeDecision, sessionInfoOf, resetAtOf } from "./billing.mjs"

// magpie 用的 provider id。多账号时 magpie 用 "freebuff#<slot>" 作键。
const PROVIDER_ID = "freebuff"

/** 从一个 magpie auth 对象里取出账号条目。 */
export function accountFromAuth(auth) {
  if (!auth) return null

  // magpie 的 oauth 记录：{ type, access, accountId, refresh:"<JSON>" }
  // 我们把自己的字段都放在 refresh 的 JSON 里。
  let fromRefresh = {}
  if (typeof auth.refresh === "string" && auth.refresh.trim()) {
    try {
      const parsed = JSON.parse(auth.refresh)
      if (parsed && typeof parsed === "object") fromRefresh = parsed
    } catch {}
  } else if (auth.refresh && typeof auth.refresh === "object") {
    fromRefresh = auth.refresh
  }

  const fromMeta = auth.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
  const raw = { ...fromMeta, ...fromRefresh }
  const token = auth.access || auth.key || raw.token
  if (!token) return null

  let deviceKey = raw.deviceKey ?? auth.deviceKey ?? null
  if (typeof deviceKey === "string") {
    try {
      deviceKey = JSON.parse(deviceKey)
    } catch {
      deviceKey = null
    }
  }

  const fallbackId = auth.accountId || ""
  return {
    host: raw.host || undefined,
    token,
    userId: raw.userId || (fallbackId && !fallbackId.includes("@") ? fallbackId : ""),
    email: raw.email || (fallbackId.includes("@") ? fallbackId : ""),
    name: raw.name || "",
    installId: raw.installId || "",
    deviceKey,
    label: raw.email || fallbackId || raw.userId || token.slice(0, 8),
  }
}

export function collectAccounts(auth) {
  if (!auth) return []

  // ⚠⚠ magpie 传入的真实形状 ⚠⚠
  //
  // magpie 给 loader 的 getAuth() 返回的是「provider id → 账号记录」的映射：
  //
  //   {
  //     "freebuff":        { type:"oauth", access, accountId, refresh },
  //     "freebuff#73tu2z": { type:"oauth", access, accountId, refresh }
  //   }
  //
  // 早先的实现只认 Array / {accounts:[]} / 单条记录三种形状，
  // 遇到这个映射就把它整个包成 [auth]，于是 accountFromAuth 收到的是
  // 「装着所有账号的对象」而不是单个账号 → 返回 null → 账号数 0，
  // 插件表现为「没有已登录的账号」，完全不可用。
  //
  // 多账号时 magpie 用 "freebuff#<slot>" 作键，所以按前缀过滤。

  // 1) 已经是数组
  if (Array.isArray(auth)) return auth.map(accountFromAuth).filter(Boolean)

  // 2) { accounts: [...] }
  if (Array.isArray(auth.accounts)) return auth.accounts.map(accountFromAuth).filter(Boolean)

  // 3) { freebuff: {...}, "freebuff#xxx": {...} } —— magpie 的真实形状
  const keys = Object.keys(auth)
  const providerKeys = keys.filter(
    (k) => k === PROVIDER_ID || k.startsWith(`${PROVIDER_ID}#`),
  )
  if (providerKeys.length) {
    const out = []
    for (const k of providerKeys) {
      const a = accountFromAuth(auth[k])
      if (a) out.push(a)
    }
    // 有匹配就能确定形状，直接返回（哪怕全解析失败也说明形状对了）
    return out
  }

  // 4) 单条记录
  const single = accountFromAuth(auth)
  return single ? [single] : []
}

/**
 * 建池。
 *
 * magpie 会按账号作用域发请求（getAuth 只看到当前账号），
 * 所以这里的"池"通常只有一个成员；但 CLI 模式会用多账号。
 */
export function createPool({ authOf, log = () => {} } = {}) {
  // 同一进程内缓存「已开会话」，避免每步请求都重新 admission。
  // key: 账号标识 -> { instanceId, modelKey, modelName, handle, expiresAt, runId }
  const sessions = new Map()

  const keyOf = (a) => `${a.host || ""}|${a.userId || a.email || a.token.slice(0, 12)}`

  return {
    sessions,

    /**
     * 找账号。返回 { account, client, session, snapshot }。
     *
     * 若已有活会话 → 复用；否则开新的；都开不了 → 抛错说明原因。
     */
    /**
     * 找账号。返回 { account, client, session, snapshot }。
     *
     * @param directAuth 直接给一个 auth 对象（loader 已拿到的那个）。
     *   优先级最高：magpie 按账号作用域跑请求，loader 里的 getAuth
     *   才是**当前这个账号**，比 authOf() 再去查一遍更可靠。
     */
    async pick({ signal, prefer = null, preferredModel = null, directAuth = null } = {}) {
      const auth = directAuth ?? (await authOf())
      let accounts = collectAccounts(auth)
      if (!accounts.length) {
        throw new FreebuffError("Freebuff 没有已登录的账号——请先添加一个", {
          status: 401,
          code: "not_signed_in",
        })
      }

      // ⚠⚠ magpie 按账号作用域发请求，一次只交一个账号 ⚠⚠
      //
      // 实测（2026-10-24）：magpie 可能把**失效的那个账号**交给插件
      // （logins.json 里的 lapsed 标记有时和真实 token 状态不一致），
      // 于是插件只看到那一个账号，直接报「没有可用账号」，
      // 而另一个账号明明是好的。
      //
      // 对策：directAuth 只有 1 个账号、且它在下面全都失败时，
      // 回退到 authOf()（那是全量的），把同 provider 下的其它账号也试一遍。
      const usingDirectOnly = !!(directAuth && accounts.length === 1)

      if (prefer) {
        const i = accounts.findIndex((a) => keyOf(a) === prefer)
        if (i > 0) accounts = [accounts[i], ...accounts.slice(0, i), ...accounts.slice(i + 1)]
      }

      const blocked = []
      for (const account of accounts) {
        const client = createClient(account)
        const k = keyOf(account)

        let snap
        try {
          snap = await client.snapshot(signal)
        } catch (e) {
          log(`${account.label} 读取状态失败：${e.message}`)
          blocked.push({ account, reason: "snapshot_failed" })
          continue
        }

        // ⚠⚠ 判定顺序（踩过坑，别改回去）⚠⚠
        //
        //   1. 先问服务端「有没有会话在跑」
        //   2. 有 → 直接用，**不碰余额、不碰模型选择**
        //      （会话的钱已经付过了，余额只剩多少都与它无关）
        //   3. 没有 → 才走余额检查 + 选模型 + 开新会话
        //
        // 早先把余额检查写在第 1 步之前，导致「会话活着、余额已扣到低于单价」
        // 时被误报 balance_too_low，直接拒绝服务一个正在计费的会话。
        const si = sessionInfoOf(snap)

        // ── 第一优先：会话进行中 → 无条件复用 ──
        if (si.active && si.expiresAt > Date.now()) {
          const cached = sessions.get(k)
          if (cached && cached.expiresAt === si.expiresAt) {
            log(`${account.label} 复用会话（${cached.modelName}），还剩 ${Math.ceil((si.expiresAt - Date.now()) / 60_000)} 分钟`)
            return { account, client, session: cached, snapshot: snap }
          }
          // 进程内没缓存（重启过）：用服务端的 instanceId 重建会话对象。
          // runId 留空，调用方会重新取。
          const model =
            snap.models.find((m) => m.key === si.model) ?? {
              key: si.model,
              handle: "",
              name: si.model || "未知模型",
              price: null,
            }
          const session = {
            instanceId: si.instanceId,
            // 接管来的会话：instance 形如 "cli:<uuid>"，uuid 就是 attemptId。
            attemptId: isCliInstanceId(si.instanceId)
              ? si.instanceId.slice(CLI_INSTANCE_PREFIX.length)
              : undefined,
            modelKey: model.key,
            modelName: model.name,
            handle: model.handle ?? "",
            expiresAt: si.expiresAt,
            runId: "",
            openedHere: false,
          }
          sessions.set(k, session)
          log(`${account.label} 接管现有会话（${model.name}），还剩 ${Math.ceil((si.expiresAt - Date.now()) / 60_000)} 分钟`)
          return { account, client, session, snapshot: snap }
        }

        // ── 没有活会话：才进入选模型 + 查余额 ──
        const target = pickTarget(snap.models, preferredModel)
        if (!target.found) {
          const why =
            target.reason === "locked"
              ? `点名的 ${target.lockedModel?.name ?? "模型"} 需要付费计划`
              : target.reason === "not_found"
                ? `点名的模型 ${target.wanted ?? ""} 不在可用列表里`
                : "没有可用的 V4.1 Flash"
          log(`${account.label} ${why}`)
          blocked.push({ account, reason: target.reason || "no_target" })
          continue
        }
        if (target.model.price >= snap.balance) {
          blocked.push({
            account,
            reason: "balance_too_low",
            balance: snap.balance,
            price: target.model.price,
            waitUntil: resetAtOf(snap),
          })
          continue
        }

        const d = decide({ snapshot: snap, model: target.model })
        log(describeDecision(d, account, target.model))

        // ── 开新的 ──
        if (d.action === "open") {
          let admission
          try {
            admission = await client.admit(target.model, { signal })
          } catch (e) {
            if (e.lockedModel) {
              const locked = snap.models.find((m) => m.key === e.lockedModel)
              log(`${account.label} 服务端锁着 ${locked?.name ?? e.lockedModel}，本次跳过`)
              blocked.push({ account, reason: "model_locked" })
              continue
            }
            log(`${account.label} 开会话失败：${e.message}`)
            blocked.push({ account, reason: e.code || "admit_failed" })
            continue
          }
          const model = snap.models.find((m) => m.key === admission.modelKey) ?? target.model
          const session = {
            instanceId: admission.instanceId,
            // ★ attemptId 必须留在会话对象里：
            //   chat 的 trace_session_id 要用它（用错 → 403 free_mode_cli_required），
            //   释放会话时也要用它走 /session/attempt。
            attemptId: admission.attemptId,
            modelKey: model.key,
            modelName: model.name,
            handle: model.handle,
            expiresAt: admission.expiresAt,
            runId: "",
            openedHere: true,
          }
          sessions.set(k, session)
          log(
            `${account.label} 开会话：${model.name}，` +
              `可用到 ${new Date(session.expiresAt).toLocaleTimeString()}（已扣 ${model.price}fb）`,
          )
          return { account, client, session, snapshot: snap }
        }

        // ── blocked：这个号今天不行 ──
        blocked.push({
          account,
          reason: d.reason,
          waitUntil: d.waitUntil,
          // 带上这些，describeDecision 才能拼出「余额 0fb，不够开 XX（需 15fb）」
          balance: d.balance ?? snap.balance,
          price: d.price ?? target?.model?.price,
          model: target?.model,
          session: d.session,
          snapshot: snap,
        })
      }

      // ⚠ 回退：magpie 只交了一个账号且它不可用时，去全量里找别的账号。
      //
      // 这是最常见的情况：magpie 把失效账号交给插件，而另一个账号是好的。
      // 不回退的话用户会看到「没有可用账号」，完全无法使用。
      if (usingDirectOnly && authOf) {
        try {
          const all = collectAccounts(await authOf())
          const tried = new Set(accounts.map((a) => keyOf(a)))
          const others = all.filter((a) => !tried.has(keyOf(a)))
          if (others.length) {
            log(`当前账号不可用，回退到其它 ${others.length} 个账号`)
            const retry = await pick({
              signal,
              prefer,
              preferredModel,
              directAuth: { accounts: others },
            })
            return retry
          }
        } catch (e) {
          // 回退失败就按原逻辑报错
          log(`回退失败：${e.message}`)
        }
      }

      // 全都不行：把原因汇总成一句人话
      const soonest = Math.min(...blocked.map((b) => b.waitUntil || Infinity))
      const when = Number.isFinite(soonest) ? new Date(soonest).toLocaleString() : "未知"
      // ⚠ 用 describeDecision 转成人话，不要直接拼 reason 代码。
      //   早先直接 join("; ") 出来的是 "balance_too_low; snapshot_failed" 这种，
      //   用户根本看不懂，而且分不清「额度不够」和「登录过期」。
      const why = blocked
        .map((b) => {
          // snapshot_failed 是登录/网络问题，要单独说清楚
          if (b.reason === "snapshot_failed") {
            return `${b.account?.email ?? "某账号"} 登录可能已过期（状态读不出来）`
          }
          return describeDecision(
            { reason: b.reason, balance: b.balance, price: b.price, waitUntil: b.waitUntil, session: b.session },
            b.account,
            b.model,
          )
        })
        .join("；")
      throw new FreebuffError(
        `Freebuff 今天没有可用的账号：${why}。最早恢复：${when}`,
        { status: 429, code: "all_blocked", blocked, until: soonest },
      )
    },

    /** 记录 runId 供同一会话复用。 */
    setRun(account, runId) {
      const s = sessions.get(keyOf(account))
      if (s) s.runId = runId
      return s
    },

    /** 上游说额度耗尽时清掉本地会话缓存。 */
    drop(account) {
      sessions.delete(keyOf(account))
    },

    /** 主动释放（仅退出时用；正常流程不要调，避免打断活跃会话）。 */
    async release(account) {
      const k = keyOf(account)
      const live = sessions.get(k)
      if (!live) return false
      sessions.delete(k)
      return createClient(account).release(live.instanceId)
    },

    keyOf,
  }
}

/**
 * 找目标模型。
 *
 * 两种情况语义不同，必须分开：
 *
 *   ① 用户点名了模型（wanted 非空）→ **尊重用户选择**，只要它是 open 的。
 *      用户可能故意选便宜的 MiMo 做测试，插件不该替他改回 V4.1。
 *
 *   ② 用户没点名（wanted 为空）→ 走自动选型：只认 V4.1 Flash。
 *      买不起就换账号，绝不降级到便宜模型。
 *
 * locked（付费计划专用）在任何情况下都不返回。
 */
export function pickTarget(models, wanted) {
  const open = models.filter((m) => !m.locked && m.price != null && m.price > 0)

  // ── ① 用户点名了：在全部 open 模型里找 ──
  if (wanted) {
    const norm = String(wanted).toLowerCase().trim()
    const hit =
      open.find((m) => m.key === wanted) ||
      open.find((m) => m.name.toLowerCase() === norm) ||
      open.find((m) => m.name.toLowerCase().includes(norm)) ||
      // slug 已在调用方转成空格形式，这里再宽松一点
      open.find((m) => slug(m.name).replace(/-/g, " ") === norm) ||
      open.find((m) => slug(m.name).includes(norm.replace(/\s+/g, "-")))
    if (hit) return { found: true, model: hit, explicit: true }

    // 点到了 locked 的：明确说清为什么不行
    const locked = models.find(
      (m) => m.locked && (m.key === wanted || m.name.toLowerCase().includes(norm)),
    )
    if (locked) return { found: false, reason: "locked", lockedModel: locked }
    return { found: false, reason: "not_found", wanted }
  }

  // ── ② 没点名：只认 V4.1 Flash ──
  const v41 = open.filter((m) => /deepseek.*v4\.1/i.test(m.name))
  const plain = v41.find((m) => !/fast/i.test(m.name))
  if (plain) return { found: true, model: plain }
  if (v41.length) return { found: true, model: v41[0] }
  return { found: false, reason: "no_v41" }
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "")
}

export function cheapestPaid(models) {
  const paid = models.filter((m) => m.price != null && m.price > 0)
  if (!paid.length) return null
  return paid.reduce((a, b) => (b.price < a.price ? b : a))
}

export { HOURS_PER_FREEBUCKS, sessionInfoOf, resetAtOf }
