// 从独立 CLI 的 accounts.json 恢复 magpie 的 plugin-auth.json。
//
// 背景：插件曾在 402 分支里调用 markDead()，而 markDead 直接改了
// accountFromAuth() 反解出来的**副本对象**，调用方又把「这个副本」
// 当成完整 auth 写回 magpie，结果凭据被覆盖成只含 exhaustedUntil 的残缺对象。
//
// 这个脚本用来恢复。跑之前先确认 accounts.json 里有完整 token + 设备密钥。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CLI_FILE = path.join(os.homedir(), ".config", "freebuff-cli", "accounts.json")
const AUTH_FILE = path.join(os.homedir(), ".config", "magpie", "plugin-auth.json")

if (!fs.existsSync(CLI_FILE)) {
  console.error(`找不到 ${CLI_FILE}`)
  process.exit(1)
}
if (!fs.existsSync(AUTH_FILE)) {
  console.error(`找不到 ${AUTH_FILE}`)
  process.exit(1)
}

const cli = JSON.parse(fs.readFileSync(CLI_FILE, "utf8"))
const accounts = (cli.accounts ?? []).filter((a) => a?.token && a?.userId)
if (!accounts.length) {
  console.error("accounts.json 里没有可用于恢复的账号（缺 token 或 userId）")
  process.exit(1)
}

const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"))

// 备份当前（可能已损坏的）文件
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const backup = `${AUTH_FILE}.before-restore-${stamp}`
fs.copyFileSync(AUTH_FILE, backup)

/** 把我们的账号对象编回 magpie 的 oauth 记录形状。 */
function toAuthRecord(a) {
  return {
    type: "oauth",
    access: a.token,
    accountId: a.email || a.userId,
    refresh: JSON.stringify({
      host: a.host,
      userId: a.userId,
      email: a.email,
      name: a.name,
      installId: a.installId,
      deviceKey: a.deviceKey,
      exhaustedUntil: 0,
    }),
  }
}

// 第一个账号放 provider id 下，其余放 provider#<slot>
auth.freebuff = toAuthRecord(accounts[0])
for (let i = 1; i < accounts.length; i++) {
  const slot = `freebuff#${accounts[i].userId.slice(0, 6)}`
  auth[slot] = toAuthRecord(accounts[i])
}

// 清掉之前损坏的 freebuff# 槽位（只保留刚写入的）
for (const k of Object.keys(auth)) {
  if (k.startsWith("freebuff#") && !accounts.some((a, i) => i > 0 && k === `freebuff#${a.userId.slice(0, 6)}`)) {
    delete auth[k]
  }
}

fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2))
console.log(`✅ 已恢复 ${accounts.length} 个账号到 ${AUTH_FILE}`)
console.log(`   损坏文件备份：${backup}`)
for (const a of accounts) {
  console.log(`   • ${a.email}  token=${a.token.slice(0, 8)}…  设备密钥=${a.deviceKey ? "有" : "无"}`)
}
