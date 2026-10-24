#!/usr/bin/env node
// Freebuff 独立命令行：不依赖 Freebuff 应用，不依赖 magpie。
//
// 用法：
//   node fb-cli.mjs login                  浏览器登录并添加账号
//   node fb-cli.mjs import magpie          从 magpie 的 plugin-auth.json 导入
//   node fb-cli.mjs import desktop         从 Freebuff 桌面端的加密凭据导入
//   node fb-cli.mjs list                   列出账号
//   node fb-cli.mjs status                 查看余额与可用性（只读，不耗额度）
//   node fb-cli.mjs rm <n|email|userId>    删除账号
//   node fb-cli.mjs test "你好"            真实发一次请求（会消耗额度！）
//   node fb-cli.mjs path                   打印配置文件位置
//
// 账号存在 ~/.config/freebuff-cli/accounts.json（0600）。

import { loadAccounts, saveAccounts, upsertAccount, prepareAccount, importFromMagpie, importFromDesktop, accountsPath, configDir } from "./store.mjs"
import { startLogin, waitForLogin, AUTH_HOST, API_HOST } from "./login.mjs"
import { createClient } from "./freebuff.mjs"
import { pickTarget, slug } from "./pool.mjs"
import { canOpenSession, quotaHours } from "./billing.mjs"

// 登录站 ≠ API 站。登录走 freebuff.com（邮箱登录），API 走 codebuff.com。
const HOST = process.env.FREEBUFF_HOST || API_HOST
const [, , cmd, ...args] = process.argv

const fmtHours = (fb) => `${(fb / 5).toFixed(1)} 小时额度`
const fmtTime = (ts) => {
  if (!ts || !Number.isFinite(ts)) return "-"
  const d = new Date(ts)
  const diff = ts - Date.now()
  if (diff <= 0) return `${d.toLocaleString()}（已过）`
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return `${d.toLocaleString()}（还有 ${h}h${m}m）`
}
const label = (a) => a.email || a.userId || a.token.slice(0, 8)

async function cmdLogin() {
  // 登录走 AUTH_HOST（freebuff.com，邮箱登录），
  // 拿到的 token 用于 HOST（codebuff.com）的 API。
  const attempt = await startLogin(AUTH_HOST)
  console.log(`\n请在浏览器打开（这是 Freebuff 的登录页，用邮箱登录）：\n  ${attempt.loginUrl}\n`)
  console.log("（如果没自动打开，复制上面的链接粘贴到浏览器）\n")
  console.log("等待登录完成…")

  const user = await waitForLogin(AUTH_HOST, attempt, {
    onNeedUser: () => {},
  })

  console.log(`登录成功：${user.email || user.userId}`)

  // 若该账号已存在，复用其 installId / 设备密钥
  const accounts = loadAccounts()
  const existing = accounts.find((a) => a.userId === user.userId)
  const { account, warnings } = await prepareAccount({
    host: HOST,
    token: user.token,
    userId: user.userId,
    email: user.email,
    name: user.name,
    installId: existing?.installId,
    existingDeviceKey: existing?.deviceKey,
  })
  for (const w of warnings) console.log(`⚠  ${w}`)

  const { replaced } = upsertAccount(accounts, account)
  saveAccounts(accounts)
  console.log(`✅ ${replaced ? "已更新" : "已添加"}账号。共 ${accounts.length} 个。`)
  console.log(`   配置：${accountsPath()}`)
}

async function cmdImport(which) {
  const accounts = loadAccounts()

  if (which === "magpie") {
    const r = importFromMagpie()
    let added = 0
    for (const a of r.accounts) {
      upsertAccount(accounts, a)
      added++
    }
    saveAccounts(accounts)
    console.log(`✅ 从 ${r.source} 导入 ${added} 个，跳过 ${r.skipped} 个。`)
    console.log(`   现在共 ${accounts.length} 个账号。`)
    return
  }

  if (which === "desktop") {
    const a = await importFromDesktop()
    const { replaced } = upsertAccount(accounts, a)
    saveAccounts(accounts)
    console.log(`✅ 从 Freebuff 桌面端导入：${label(a)}（${replaced ? "更新" : "新增"}）`)
    console.log(`   现在共 ${accounts.length} 个账号。`)
    return
  }

  console.error("用法：fb-cli.mjs import <magpie|desktop>")
  process.exit(1)
}

function cmdList() {
  const accounts = loadAccounts()
  if (!accounts.length) {
    console.log("没有账号。先跑：fb-cli.mjs login")
    return
  }
  console.log(`\n共 ${accounts.length} 个账号（${accountsPath()}）\n`)
  accounts.forEach((a, i) => {
    const dev = a.deviceKey?.registrations?.[a.scope] ? "已注册" : "未注册"
    console.log(`  [${i + 1}] ${label(a)}`)
    console.log(`       userId: ${a.userId}`)
    console.log(`       设备:   ${dev}`)
    console.log(`       额度锁: ${a.exhaustedUntil ? fmtTime(a.exhaustedUntil) : "无"}`)
    console.log("")
  })
}

async function cmdStatus() {
  const accounts = loadAccounts()
  if (!accounts.length) {
    console.log("没有账号。先跑：fb-cli.mjs login")
    return
  }

  console.log("")
  console.log("═".repeat(70))
  let usableCount = 0
  for (const a of accounts) {
    console.log(`\n账号  ${label(a)}`)
    try {
      const snap = await createClient(a).snapshot()
      const t = pickTarget(snap.models)
      const price = t.found ? t.model.price : null
      const gate = t.found
        ? canOpenSession({ balance: snap.balance, price, daily: snap.daily })
        : { ok: false, reason: "no_v41" }

      console.log(`  余额      ${snap.balance} freebucks = ${fmtHours(snap.balance)}`)
      console.log(`  今日额度  ${snap.daily ? `${snap.daily.spent}/${snap.daily.limit}` : "-"}`)
      console.log(`  重置      ${fmtTime(snap.daily ? Date.parse(snap.daily.resetAt) : null)}`)
      if (t.found) {
        console.log(`  目标模型  ${t.model.name}（${price}fb = ${quotaHours(price)} 小时额度）`)
        console.log(`  上下文    ${(t.model.contextWindow / 1048576).toFixed(0)}M`)
      } else {
        console.log(`  目标模型  (无可用 V4.1)`)
      }
      if (snap.lockedModel) {
        console.log(`  状态      🔵 正在使用（服务端锁定 ${snap.lockedModel}）`)
      } else if (gate.ok) {
        console.log(`  状态      🟢 可开一次会话`)
        usableCount++
      } else {
        console.log(`  状态      ⚪ 不可用（${gate.reason}）`)
      }
    } catch (e) {
      console.log(`  ❌ 读取失败：${e.message}`)
    }
  }
  console.log("\n" + "─".repeat(70))
  console.log(`合计 ${accounts.length} 个：${usableCount} 个可开（≈${usableCount} 小时）`)
  console.log("")
}

function cmdRm(which) {
  if (!which) {
    console.error("用法：fb-cli.mjs rm <序号|邮箱|userId>")
    process.exit(1)
  }
  const accounts = loadAccounts()
  const idx = Number(which)
  let target = -1
  if (Number.isInteger(idx) && idx >= 1 && idx <= accounts.length) {
    target = idx - 1
  } else {
    target = accounts.findIndex((a) => a.email === which || a.userId === which)
  }
  if (target < 0) {
    console.error(`找不到账号：${which}`)
    process.exit(1)
  }
  const removed = accounts.splice(target, 1)[0]
  saveAccounts(accounts)
  console.log(`✅ 已删除 ${label(removed)}。剩 ${accounts.length} 个。`)
}

async function cmdTest(prompt) {
  const text = prompt || "Reply with exactly: OK"
  const accounts = loadAccounts()
  if (!accounts.length) {
    console.error("没有账号。先跑：fb-cli.mjs login")
    process.exit(1)
  }

  for (const a of accounts) {
    if (a.exhaustedUntil && a.exhaustedUntil > Date.now()) {
      console.log(`${label(a)} 额度锁定中，跳过`)
      continue
    }
    try {
      const api = createClient(a)
      const snap = await api.snapshot()
      const t = pickTarget(snap.models)
      if (!t.found) {
        console.log(`${label(a)} 没有 V4.1 可用`)
        continue
      }
      const gate = canOpenSession({ balance: snap.balance, price: t.model.price, daily: snap.daily })
      if (!gate.ok) {
        console.log(`${label(a)} 余额不够（${snap.balance}fb，需 ${t.model.price}fb）`)
        continue
      }

      console.log(`\n⚠  即将开会话：${t.model.name}`)
      console.log(`   这会消耗 ${t.model.price}fb = ${quotaHours(t.model.price)} 小时额度，且不会退还。`)
      console.log(`   账号：${label(a)}\n`)

      const adm = await api.admit(t.model)
      console.log(`会话已开：${adm.instanceId.slice(0, 8)}，1 小时窗口`)
      const runId = await api.runId({ instanceId: adm.instanceId, modelHandle: t.model.handle })

      const res = await api.complete({
        modelKey: t.model.key,
        modelHandle: t.model.handle,
        runId,
        instanceId: adm.instanceId,
        body: { model: t.model.key, messages: [{ role: "user", content: text }], max_tokens: 64 },
      })
      console.log(`HTTP ${res.status}`)
      console.log(JSON.stringify(res.json, null, 2).slice(0, 1200))
      return
    } catch (e) {
      console.log(`${label(a)} 失败：${e.message}`)
    }
  }
}

// ── 分发 ──
switch (cmd) {
  case "login":
    await cmdLogin()
    break
  case "import":
    await cmdImport(args[0])
    break
  case "list":
    cmdList()
    break
  case "status":
    await cmdStatus()
    break
  case "rm":
    cmdRm(args[0])
    break
  case "test":
    await cmdTest(args.join(" "))
    break
  case "path":
    console.log(`配置目录：${configDir()}`)
    console.log(`账号文件：${accountsPath()}`)
    break
  default:
    console.log(`Freebuff 独立 CLI

  node fb-cli.mjs login                浏览器登录并添加账号
  node fb-cli.mjs import magpie        从 magpie 导入已有账号
  node fb-cli.mjs import desktop       从 Freebuff 桌面端导入
  node fb-cli.mjs list                 列出账号
  node fb-cli.mjs status               余额与可用性（不耗额度）
  node fb-cli.mjs rm <序号|邮箱>       删除账号
  node fb-cli.mjs test "你好"          真实请求（消耗额度！）
  node fb-cli.mjs path                 配置文件位置

配置：${accountsPath()}`)
}
