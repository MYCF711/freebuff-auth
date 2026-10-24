// Freebuff 的额度与会话状态判定。
//
// ⚠⚠ 本文件纠正过两个实测错误，读之前先看这里 ⚠⚠
//
// 【纠正 1】提前释放**会**退款。
//   早先看到 "18:28 mimo-slow 扣5 退0" 就断言「release 等于白烧」。
//   那是**退款还没入账时的快照**。后来同一条变成 "扣5 退5"。
//   真实规则：admission 先扣，会话没真正产生对话/被释放后服务端退款。
//   所以释放不是浪费——但也不必为了省额度去频繁开关。
//
// 【纠正 2】额度的权威来源是服务端，不是本地推算。
//   判据三条，优先用服务端给的：
//     a. session.status      服务端说的会话状态（active / ended / none）
//     b. session.expiresAt   服务端给的会话到期时刻（倒计时用这个）
//     c. freebucks.balance   服务端给的当前可用额
//   只有在服务端字段缺失时才回落到本地记录。
//
// ── 额度单位 ────────────────────────────────────────────────
//   5 freebucks = 1 小时额度
//   免费档每日 25 freebucks = 5 小时额度，太平洋午夜重置
//   V4.1 Flash 价格 15fb = 3 小时额度 → 换 1 小时对话
//
// ── 判据（"这个号今天还能不能用"）────────────────────────────
//   服务端 status 是 active 且未到期  → 复用，绝不重开
//   服务端 status 是 active 但已到期  → 今天用完了
//   服务端 status none/ended          → 看余额
//     余额 > 价格                      → 能开一次
//     余额 <= 价格                     → 今天开不了
//
//   余额判定必须 **严格大于**：实测余额 5 / 价 5 时 admission 会成功，
//   但随后对话 402。所以等于也不行。

export const HOURS_PER_FREEBUCKS = 5
export const DAILY_FREEBUCKS = 25
export const SESSION_WINDOW_MS = 3_600_000

/** price 折合多少「小时额度」。 */
export function quotaHours(price) {
  return price == null ? null : price / HOURS_PER_FREEBUCKS
}

/** 服务端给的会话快照，统一成一个形状。 */
export function sessionInfoOf(snapshot) {
  const s = snapshot ?? {}
  const status = s.status ?? "none"
  const expiresAt = s.expiresAt ? Date.parse(s.expiresAt) : 0
  const admittedAt = s.admittedAt ? Date.parse(s.admittedAt) : 0
  const active = status === "active" && expiresAt > 0
  return {
    status,
    instanceId: s.instanceId ?? "",
    model: s.model ?? "",
    admittedAt,
    expiresAt,
    // 服务端没给 remainingMs（那只在 admission 响应里出现一次），
    // 所以倒计时由 expiresAt 推算，和 Freebuff 客户端显示的是同一个来源。
    remainingMs: active ? Math.max(0, expiresAt - Date.now()) : 0,
    active,
    expired: active && expiresAt <= Date.now(),
  }
}

/**
 * 这个账号现在能不能用，以及该怎么用。
 *
 * @returns {{action:"reuse"|"open"|"blocked", reason, need?, waitUntil?, session}}
 */
export function decide({ snapshot, model, now = Date.now() }) {
  const session = sessionInfoOf(snapshot)
  const resetAt = snapshot?.daily?.resetAt ? Date.parse(snapshot.daily.resetAt) : 0
  const waitUntil = resetAt || now + 24 * 3_600_000

  // ── 1. 服务端说会话活着：复用 ──
  if (session.active && session.expiresAt > now) {
    // 剩余不足 1 分钟就别再往里塞了（请求可能跨过窗口）
    if (session.expiresAt - now < 60_000) {
      return { action: "blocked", reason: "session_about_to_end", waitUntil, session }
    }
    return { action: "reuse", reason: "session_active", session }
  }

  // ── 2. 服务端说会话还在但已到期：今天的额度已经花掉 ──
  if (session.active && session.expired) {
    return { action: "blocked", reason: "session_used_today", waitUntil, session }
  }

  // ── 3. 没有活会话：看余额够不够开一次 ──
  const balance = snapshot?.balance ?? 0
  const price = model?.price ?? null
  if (price == null) {
    return { action: "blocked", reason: "no_model", waitUntil: now + 3_600_000, session }
  }

  // ⚠ 价格 0 的模型不需要余额 ⚠
  //
  // 实测（2026-10-24 07:38）：余额 0fb 时，服务端对 Solar Mini 4 / Solar Pro 4 /
  // Glyph Cluster / Nemotron 3.5 Lightning 这四个 0fb 模型仍然返回
  //   admission 200 {"status":"active"}
  // 所以它们确实能开。
  //
  // 早先的判断是 `balance <= price`，余额 0、价格 0 → 0 <= 0 → true → 误判成
  // balance_too_low，白白错过 4 个免费模型。
  //
  // 正确判据：价格 > 0 时要求余额严格大于价格（服务端要留余量）；
  //          价格 === 0 时余额不作要求。
  if (price > 0 && balance <= price) {
    return {
      action: "blocked",
      reason: "balance_too_low",
      need: price - balance,
      balance,
      price,
      waitUntil,
      session,
    }
  }
  const daily = snapshot?.daily
  // ⚠ 每日额度用满时，0fb 模型仍然可用 ⚠
  //
  // 实测（2026-10-24 07:38，账号 25/25 用满、余额 0fb）：
  //   POST /session/admission  → 200 {"status":"active"}   （0fb 模型照开）
  //   POST /chat/completions   → 503（协议已过，只是模型侧暂不可用）
  //
  // 所以 daily_exhausted 只对**付费模型**构成阻断，
  // 0fb 模型不该被它挡住 —— 那 4 个（Solar Mini 4 / Solar Pro 4 /
  // Glyph Cluster / Nemotron 3.5 Lightning）在额度耗尽时依然可用。
  if (price > 0 && daily && typeof daily.remaining === "number" && daily.remaining <= 0) {
    return { action: "blocked", reason: "daily_exhausted", waitUntil, session }
  }

  return { action: "open", reason: "can_open", balance, price, waitUntil, session }
}

/** 兼容旧调用：能不能开。 */
export function canOpenSession({ balance, price, daily }) {
  if (balance == null || price == null) return { ok: false, reason: "unknown" }
  // 同 decide()：0fb 模型不需要余额
  if (price > 0 && balance <= price) return { ok: false, reason: "balance_not_enough", need: price - balance }
  // 同 decide()：0fb 模型不受每日额度限制
  if (price > 0 && daily && typeof daily.remaining === "number" && daily.remaining <= 0) {
    return { ok: false, reason: "daily_exhausted" }
  }
  return { ok: true }
}

/** 今天几点恢复。 */
export function resetAtOf(snapshot, now = Date.now()) {
  const iso = snapshot?.daily?.resetAt
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) && t > now ? t : now + 24 * 3_600_000
}

/** 人话描述状态，给日志和卡片用。 */
export function describeDecision(d, account, model) {
  const who = account?.email || account?.userId || "账号"
  switch (d.reason) {
    case "session_active": {
      const m = Math.ceil((d.session.expiresAt - Date.now()) / 60_000)
      return `${who} 会话进行中，还剩 ${m} 分钟`
    }
    case "session_about_to_end":
      return `${who} 会话不到 1 分钟就结束，先在别的号上发`
    case "session_used_today":
      return `${who} 今天这 1 小时已经用完了`
    case "balance_too_low":
      return `${who} 余额 ${d.balance}fb，不够开 ${model?.name ?? "目标模型"}（需 ${d.price}fb）`
    case "daily_exhausted":
      return `${who} 今日额度已用完`
    case "can_open":
      return `${who} 可以开一次（${d.balance}fb，消耗 ${d.price}fb）`
    // snapshot 拉取失败：token 过期或网络问题，与额度无关
    case "snapshot_failed":
      return `${who} 状态读取失败（登录可能已过期，请重新登录）`
    case "no_model":
      return `${who} 没有可用的模型（模型价格未下发）`
    default:
      return `${who}：${d.reason}`
  }
}
