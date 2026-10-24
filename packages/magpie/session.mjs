// 每个账号的「今天还能不能用」状态机。
//
// ── 为什么需要它 ─────────────────────────────────────────────
// 早先的写法是「发请求 → 撞 402 → 再标记账号」。那等于每耗尽一个号
// 都要白打一次上游请求，而且在 magpie 里会表现为「请求失败」而不是
// 「换号重试」。
//
// 现在改成**先算后打**：发请求之前就知道这个号今天还剩不剩，
// 不剩就直接说"换下一个"，一次上游请求都不浪费。
//
// ── 一个号的生命周期 ─────────────────────────────────────────
//
//   fresh   今天还没开过会话        → 可以开（前提：余额 > 价格）
//   active  会话开着，未到 1 小时   → 直接复用，绝不重开
//   used    会话已到期（1 小时用完）→ 今天报废
//   broke   余额不足以开一次        → 今天报废
//
//   任何一个状态，只要服务端的 resetAt 变了（跨过太平洋午夜），
//   就回到 fresh。
//
// ── 两个不能违反的规则 ───────────────────────────────────────
//   1. active 期间绝不 release —— 提前释放不退额度
//   2. used 之后绝不重开 —— 重开会再烧一次额度，而今天只剩不够的量

import { SESSION_WINDOW_MS } from "./billing.mjs"

/** 距会话到期不足这个时间，就不再往里塞请求了（避免请求中途窗口结束）。 */
export const EXPIRY_MARGIN_MS = 60_000

/** 用服务端的 resetAt 作为"今天"的标识：它一变就是新的一天。 */
export function dayKeyOf(snapshot) {
  const iso = snapshot?.daily?.resetAt
  if (!iso) return "unknown"
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toISOString() : "unknown"
}

/** 读账号上挂的状态（magpie 存在 refresh JSON 里，CLI 存在 accounts.json 里）。 */
export function readState(account) {
  const s = account?.sessionState
  if (!s || typeof s !== "object") {
    return { phase: "fresh", dayKey: "", openedAt: 0, expiresAt: 0, instanceId: "", modelKey: "", runId: "" }
  }
  return {
    phase: s.phase ?? "fresh",
    dayKey: s.dayKey ?? "",
    openedAt: Number(s.openedAt) || 0,
    expiresAt: Number(s.expiresAt) || 0,
    instanceId: s.instanceId ?? "",
    modelKey: s.modelKey ?? "",
    handle: s.handle ?? "",
    name: s.name ?? "",
    runId: s.runId ?? "",
    resetAt: s.resetAt ?? 0,
  }
}

export function writeState(account, state) {
  if (!account) return
  account.sessionState = state
}

/**
 * 决定这次请求该怎么做。
 *
 * @returns {{action:"reuse"|"open"|"rotate", state, reason, waitUntil?}}
 *   reuse  — 复用现有会话，state 里有 instanceId / runId
 *   open   — 开一个新会话
 *   rotate — 这个号今天没戏了，换下一个（waitUntil 是恢复时间）
 */
export function decide({ account, snapshot, model, now = Date.now() }) {
  const dayKey = dayKeyOf(snapshot)
  const prev = readState(account)

  // 跨天了：任何状态都重置
  let state = prev
  if (prev.dayKey && prev.dayKey !== dayKey) {
    state = { phase: "fresh", dayKey, openedAt: 0, expiresAt: 0, instanceId: "", modelKey: "", handle: "", name: "", runId: "", resetAt: 0 }
  } else if (!prev.dayKey) {
    state = { ...prev, dayKey }
  }

  const resetAt = snapshot?.daily?.resetAt ? Date.parse(snapshot.daily.resetAt) : 0

  // ── active：会话还活着 ──
  if (state.phase === "active" && state.expiresAt > 0) {
    if (now < state.expiresAt - EXPIRY_MARGIN_MS) {
      return { action: "reuse", state, reason: "session_alive" }
    }
    // 只剩不到 1 分钟：当作今天用完，不要在半路开新会话
    const used = { ...state, phase: "used", resetAt }
    writeState(account, used)
    return {
      action: "rotate",
      state: used,
      reason: "session_expired",
      waitUntil: resetAt || now + 24 * 3_600_000,
    }
  }

  // ── used / broke：今天报废 ──
  if (state.phase === "used" || state.phase === "broke") {
    return {
      action: "rotate",
      state,
      reason: state.phase === "used" ? "session_used_today" : "balance_too_low",
      waitUntil: state.resetAt || resetAt || now + 24 * 3_600_000,
    }
  }

  // ── fresh：看看能不能开 ──
  const balance = snapshot?.balance ?? 0
  const price = model?.price ?? null
  if (price == null) {
    return { action: "rotate", state, reason: "no_model", waitUntil: resetAt || now + 3_600_000 }
  }
  // 服务端要求 price < balance（严格小于）；等于就会开成功但对话 402 且不退
  if (balance <= price) {
    const broke = { ...state, phase: "broke", resetAt }
    writeState(account, broke)
    return {
      action: "rotate",
      state: broke,
      reason: "balance_too_low",
      need: price - balance,
      waitUntil: resetAt || now + 3_600_000,
    }
  }
  const daily = snapshot?.daily
  if (daily && typeof daily.remaining === "number" && daily.remaining <= 0) {
    const broke = { ...state, phase: "broke", resetAt }
    writeState(account, broke)
    return { action: "rotate", state: broke, reason: "daily_exhausted", waitUntil: resetAt || now + 3_600_000 }
  }

  return { action: "open", state, reason: "fresh" }
}

/** 开会话成功后调用，把状态推进到 active。 */
export function markOpened(account, { instanceId, model, expiresAt, resetAt }) {
  const state = {
    phase: "active",
    dayKey: readState(account).dayKey,
    openedAt: Date.now(),
    expiresAt: expiresAt || Date.now() + SESSION_WINDOW_MS,
    instanceId,
    modelKey: model.key,
    handle: model.handle,
    name: model.name,
    runId: "",
    resetAt: resetAt || 0,
  }
  writeState(account, state)
  return state
}

/** 记录 runId，后续同一会话复用。 */
export function markRun(account, runId) {
  const s = readState(account)
  s.runId = runId
  writeState(account, s)
  return s
}

/** 上游判定额度耗尽/会话终结时调用。 */
export function markDead(account, { reason, waitUntil }) {
  const s = readState(account)
  const next = {
    ...s,
    phase: reason === "balance_too_low" || reason === "daily_exhausted" ? "broke" : "used",
    resetAt: waitUntil || s.resetAt,
  }
  writeState(account, next)
  return next
}

/** 人话解释一个状态，用于日志和错误消息。 */
export function describe(state, account) {
  const who = account?.email || account?.userId || "账号"
  switch (state.phase) {
    case "active": {
      const mins = Math.max(0, Math.round((state.expiresAt - Date.now()) / 60_000))
      return `${who} 会话进行中（${state.name || state.modelKey}），还剩约 ${mins} 分钟`
    }
    case "used":
      return `${who} 今天的 1 小时已用完`
    case "broke":
      return `${who} 今日余额不足以再开一次会话`
    default:
      return `${who} 今天还没用过`
  }
}
