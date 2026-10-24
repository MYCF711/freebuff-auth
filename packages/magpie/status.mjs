#!/usr/bin/env node
// Freebuff 账号池状态查看器。
//
// 用法：
//   node status.mjs            看所有账号
//   node status.mjs --json     机器可读
//
// 不消耗额度（只读接口）。会话状态来自进程内内存，脚本看不到——
// 这里显示的是服务端账本状态，更有参考价值。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { accountFromAuth, collectAccounts, pickTarget } from "./pool.mjs"
import { createClient } from "./freebuff.mjs"
import { canOpenSession, resetAtOf, quotaHours } from "./billing.mjs"

const AUTH_FILE = path.join(os.homedir(), ".config", "magpie", "plugin-auth.json")
const asJson = process.argv.includes("--json")

function loadAccounts() {
  if (!fs.existsSync(AUTH_FILE)) return []
  const all = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"))
  return collectAccounts(all.freebuff)
}

function fmtHours(fb) {
  return `${(fb / 5).toFixed(1)} 小时额度`
}

function fmtTime(ts) {
  if (!ts || !Number.isFinite(ts)) return "-"
  const d = new Date(ts)
  const now = Date.now()
  const diff = ts - now
  if (diff <= 0) return `${d.toLocaleString()}（已过）`
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return `${d.toLocaleString()}（还有 ${h}h${m}m）`
}

const accounts = loadAccounts()
if (!accounts.length) {
  console.log("没有已登录的 Freebuff 账号。先在 magpie 里添加账号。")
  process.exit(0)
}

const rows = []
for (const account of accounts) {
  const row = {
    account: account.label,
    fresh: false,
  }
  try {
    const api = createClient(account)
    const snap = await api.snapshot()
    const target = pickTarget(snap.models)
    const price = target.found ? target.model.price : null
    const gate = target.found
      ? canOpenSession({ balance: snap.balance, price, daily: snap.daily })
      : { ok: false, reason: "no_v41" }

    row.fresh = true
    row.balance = snap.balance
    row.daily = snap.daily ? `${snap.daily.spent}/${snap.daily.limit}` : "-"
    row.resetAt = snap.daily?.resetAt ? Date.parse(snap.daily.resetAt) : null
    row.model = target.found ? target.model.name : "(无 V4.1)"
    row.price = price
    row.quotaHours = price == null ? null : quotaHours(price)
    row.canOpen = gate.ok
    row.reason = gate.reason ?? ""
    row.lockedNow = snap.lockedModel ?? null
    row.sessionStatus = snap.status ?? null
    row.contextWindow = target.found ? target.model.contextWindow : null

    // 服务端还锁着会话 → 说明这个号此刻正在被用
    if (snap.lockedModel) {
      row.inUse = true
      row.canOpen = false
    }
  } catch (e) {
    row.error = e.message
  }
  rows.push(row)
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

console.log("")
console.log("═".repeat(78))
console.log("Freebuff 账号池状态")
console.log("═".repeat(78))

for (const r of rows) {
  console.log("")
  console.log(`账号  ${r.account}`)
  if (!r.fresh) {
    console.log(`  ❌ 读取失败：${r.error}`)
    continue
  }
  console.log(`  余额      ${r.balance} freebucks = ${fmtHours(r.balance)}`)
  console.log(`  今日额度  ${r.daily}`)
  console.log(`  重置      ${fmtTime(r.resetAt)}`)
  console.log(`  目标模型  ${r.model}`)
  if (r.price != null) {
    console.log(`  价格      ${r.price} freebucks = ${r.quotaHours} 小时额度 → 可兑换 1 小时对话`)
  }
  if (r.contextWindow) {
    console.log(`  上下文    ${(r.contextWindow / 1048576).toFixed(0)}M（${r.contextWindow} tokens）`)
  }
  if (r.inUse) {
    console.log(`  状态      🔵 正在使用（服务端锁定 ${r.lockedNow}）`)
  } else if (r.canOpen) {
    console.log(`  状态      🟢 可以开一次会话`)
  } else {
    console.log(`  状态      ⚪ 今日不可用（${r.reason}）`)
  }
}

// 汇总
const usable = rows.filter((r) => r.canOpen)
const used = rows.filter((r) => r.inUse)
console.log("")
console.log("─".repeat(78))
console.log(`合计 ${rows.length} 个账号：🟢 ${usable.length} 个可开 · 🔵 ${used.length} 个在用 · ⚪ ${rows.length - usable.length - used.length} 个今日不可用`)
if (usable.length) {
  const totalHours = usable.reduce((a, r) => a + 1, 0)
  console.log(`可开出的对话时长：约 ${totalHours} 小时（每个号 1 小时）`)
}
console.log("")
