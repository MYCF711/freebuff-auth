// 独立账号存储：不依赖 magpie，也不依赖 Freebuff 应用。
//
// 这是"脱离宿主"的核心。凭据存在自己的文件里：
//   ~/.config/freebuff-cli/accounts.json
//
// 文件权限设 0600（仅本人可读）。里面是明文 token + 设备私钥，
// 和 magpie 的 plugin-auth.json 同等敏感。
//
// 同时提供导入器：能从已有的 magpie plugin-auth.json 或 Freebuff 桌面端的
// auth-secrets.json 里把账号搬过来，省得重新登录。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as nodeCp from "node:child_process"
import { createClient } from "./freebuff.mjs"
import { accountFromAuth } from "./pool.mjs"
import { generateDeviceKey, scopeOf } from "./device.mjs"

const CONFIG_DIR =
  process.env.FREEBUFF_CLI_HOME || path.join(os.homedir(), ".config", "freebuff-cli")
const ACCOUNTS_FILE = path.join(CONFIG_DIR, "accounts.json")

export function configDir() {
  return CONFIG_DIR
}

export function accountsPath() {
  return ACCOUNTS_FILE
}

/** 确保目录存在且权限收紧。 */
function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  try {
    fs.chmodSync(CONFIG_DIR, 0o700)
  } catch {
    // Windows 上 chmod 语义有限，忽略
  }
}

/**
 * Windows 上 `chmod` 基本无效（NTFS 走 ACL），而这里存的是明文 token 和
 * 设备私钥。所以额外用 icacls 把继承切断、只留当前用户。
 * 失败不抛错——收紧是加固，不是功能前提。
 */
function tightenWindowsAcl(file) {
  if (process.platform !== "win32") return
  try {
    // 同步 exec 在 ESM 里用 spawnSync（不能 require）
    const { spawnSync } = nodeCp
    const me = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${me}:F`], {
      stdio: "ignore",
      windowsHide: true,
    })
  } catch {
    // 没有 icacls 或权限不足：跳过
  }
}

/** 读全部账号。文件不存在时返回空数组。 */
export function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"))
    const list = Array.isArray(raw?.accounts) ? raw.accounts : []
    return list.filter((a) => a && a.token)
  } catch (e) {
    throw new Error(`账号文件损坏（${ACCOUNTS_FILE}）：${e.message}`)
  }
}

/** 原子写入（先写临时文件再改名，避免中断损坏）。 */
export function saveAccounts(accounts) {
  ensureDir()
  const tmp = `${ACCOUNTS_FILE}.tmp-${process.pid}`
  const body = JSON.stringify({ version: 1, accounts }, null, 2)
  fs.writeFileSync(tmp, body, { mode: 0o600 })
  fs.renameSync(tmp, ACCOUNTS_FILE)
  try {
    fs.chmodSync(ACCOUNTS_FILE, 0o600)
  } catch {}
  tightenWindowsAcl(ACCOUNTS_FILE)
  return ACCOUNTS_FILE
}

/**
 * 加一个账号。若同一个 userId 已存在则更新 token（保留原设备密钥和 installId，
 * 因为服务端用它们识别同一安装，换新的会让账号看起来像新设备）。
 */
export function upsertAccount(accounts, fresh) {
  const i = accounts.findIndex((a) => a.userId && a.userId === fresh.userId)
  if (i >= 0) {
    const old = accounts[i]
    accounts[i] = {
      ...old,
      ...fresh,
      // 保留可复用的身份凭据
      installId: old.installId || fresh.installId,
      deviceKey: fresh.deviceKey ?? old.deviceKey,
      exhaustedUntil: 0,
    }
    return { account: accounts[i], replaced: true }
  }
  accounts.push(fresh)
  return { account: fresh, replaced: false }
}

/**
 * 让一个刚登录的账号"就绪"：生成设备密钥并向服务端注册，拿到 keyId。
 * 注册失败不阻塞（首次请求会重试），但会返回警告。
 */
export async function prepareAccount({ host, token, userId, email, name, installId, existingDeviceKey }) {
  const deviceKey = existingDeviceKey ?? generateDeviceKey()
  const scope = scopeOf(host, userId)
  const account = {
    host,
    token,
    userId,
    email,
    name,
    installId: installId || crypto.randomUUID(),
    deviceKey,
    exhaustedUntil: 0,
    scope,
    addedAt: new Date().toISOString(),
  }

  const warnings = []
  if (!deviceKey.registrations?.[scope]) {
    try {
      const client = createClient(account)
      const keyId = await client.registerDevice(scope, deviceKey.publicKey)
      deviceKey.registrations = { ...(deviceKey.registrations ?? {}), [scope]: keyId }
      account.deviceKey = deviceKey
    } catch (e) {
      warnings.push(`设备注册失败（首次请求时会重试）：${e.message}`)
    }
  }
  return { account, warnings }
}

/**
 * 从 magpie 的 plugin-auth.json 导入。
 * @returns {{imported:number, skipped:number, accounts:[]}}
 */
export function importFromMagpie(authFile) {
  const p =
    authFile || path.join(os.homedir(), ".config", "magpie", "plugin-auth.json")
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}`)

  const all = JSON.parse(fs.readFileSync(p, "utf8"))
  const freebuffAuth = all.freebuff
  if (!freebuffAuth) throw new Error(`${p} 里没有 freebuff 账号`)

  // magpie 的形态：单条或 { accounts: [...] }
  const list = Array.isArray(freebuffAuth.accounts) ? freebuffAuth.accounts : [freebuffAuth]
  const out = []
  let skipped = 0

  for (const raw of list) {
    const a = accountFromAuth(raw)
    if (!a || !a.userId || !a.deviceKey) {
      skipped++
      continue
    }
    out.push({
      host: a.host || "https://www.codebuff.com",
      token: a.token,
      userId: a.userId,
      email: a.email,
      name: a.name,
      installId: a.installId,
      deviceKey: a.deviceKey,
      exhaustedUntil: a.exhaustedUntil || 0,
      scope: scopeOf(a.host || "https://www.codebuff.com", a.userId),
      addedAt: new Date().toISOString(),
    })
  }
  return { imported: out.length, skipped, accounts: out, source: p }
}

/**
 * 从 Freebuff 桌面端的加密凭据导入（需要 Windows DPAPI 解 Chromium v10 密文）。
 * 只在 Windows 上可用；失败时抛出明确的说明。
 */
export async function importFromDesktop(opts = {}) {
  const cfgDir =
    opts.configDir || path.join(os.homedir(), ".config", "freebuff-desktop")
  const secretsPath = path.join(cfgDir, "state.json.auth-secrets.json")
  const statePath = path.join(cfgDir, "state.json")

  if (!fs.existsSync(secretsPath)) {
    throw new Error(`找不到 ${secretsPath}：这台机器上没有 Freebuff 桌面端的登录记录`)
  }
  if (process.platform !== "win32") {
    throw new Error("从桌面端导入目前只实现了 Windows（依赖 DPAPI + Chromium v10）")
  }

  const { execFileSync } = await import("node:child_process")
  const localState =
    opts.localState ||
    path.join(os.homedir(), "AppData", "Roaming", "Freebuff", "Local State")

  const ps = `
$ls = Get-Content "${localState.replace(/\\/g, "\\\\")}" -Raw | ConvertFrom-Json
$raw = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)
$blob = $raw[5..($raw.Length-1)]
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($key)
`
  const aesKey = Buffer.from(
    execFileSync("pwsh", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim(),
    "base64",
  )
  if (aesKey.length !== 32) throw new Error("os_crypt 主密钥长度异常")

  const { createDecipheriv } = await import("node:crypto")
  function decryptV10(str) {
    const buf = Buffer.from(str, "base64")
    if (buf.subarray(0, 3).toString("ascii") !== "v10") throw new Error("不是 v10 密文")
    const iv = buf.subarray(3, 15)
    const rest = buf.subarray(15)
    const ct = rest.subarray(0, rest.length - 16)
    const tag = rest.subarray(rest.length - 16)
    const d = createDecipheriv("aes-256-gcm", aesKey, iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8")
  }

  const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"))
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"))

  let account = null
  let deviceKey = null
  for (const [k, blob] of Object.entries(secrets)) {
    let plain
    try {
      plain = decryptV10(blob)
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(plain)
      if (parsed?.token && parsed?.user) account = parsed
      else if (parsed?.privateKey) deviceKey = parsed
    } catch {}
  }
  if (!account) throw new Error("解不出账号 token")

  const host = "https://www.codebuff.com"
  return {
    host,
    token: account.token,
    userId: account.user?.id ?? "",
    email: account.user?.email ?? "",
    name: account.user?.name ?? "",
    installId: state.installId || crypto.randomUUID(),
    deviceKey: deviceKey ?? generateDeviceKey(),
    exhaustedUntil: 0,
    scope: scopeOf(host, account.user?.id ?? ""),
    addedAt: new Date().toISOString(),
    importedFrom: "desktop",
  }
}
