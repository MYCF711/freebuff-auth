// 冷却管理：持久化「上次调用时间」，保证两次调用之间至少间隔 N 秒。
//
// 依据（2026-10-24 实测）：
//   - 账号静默 120 秒后第一次调用 → 200
//   - 连续调用（间隔 < 10s）→ 403
//   - 无论成功失败，都会消耗额度
//
// 所以：宁可慢，要排队。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE = path.join(os.homedir(), '.config', 'manicode', 'fb-cooldown.json')

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return {}
  }
}

export function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2))
}

/** 距离下次可调用还有多少毫秒。 */
export function msUntilReady(accountId, gapMs) {
  const s = loadState()
  const last = s[accountId]?.lastCallAt ?? 0
  return Math.max(0, last + gapMs - Date.now())
}

/** 记录一次调用。 */
export function markCall(accountId) {
  const s = loadState()
  s[accountId] = { lastCallAt: Date.now() }
  saveState(s)
}

/** 等够冷却时间。 */
export async function waitReady(accountId, gapMs, onWait) {
  const ms = msUntilReady(accountId, gapMs)
  if (ms <= 0) return 0
  onWait?.(ms)
  await new Promise((r) => setTimeout(r, ms))
  return ms
}
