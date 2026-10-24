// Freebuff 的浏览器登录流程。
//
// 协议（从 Freebuff 0.0.188 的 orchestrator.js 逆向确认，实测可用）：
//
//   1. POST {AUTH_HOST}/api/auth/cli/code   { fingerprintId }
//      → { fingerprintId, fingerprintHash, loginUrl, expiresAt, expiresInMs }
//      loginUrl 形如 {AUTH_HOST}/login?auth_code=XXXX
//
//   2. 用户在浏览器里打开 loginUrl、登录自己的账号
//
//   3. 轮询 GET {AUTH_HOST}/api/auth/cli/status?fingerprintId=&fingerprintHash=&expiresAt=
//      → { user: { authToken, id, email, name } }
//
// ⚠⚠ AUTH_HOST ≠ API_HOST，这是踩过的坑 ⚠⚠
//
// orchestrator.js 里的真实定义：
//
//   AUTH_HOST = process.env.FREEBUFF_AUTH_HOST
//     || (API_HOST === PROD_API_HOST ? FREEBUFF_WEB_HOST : API_HOST)
//   FREEBUFF_WEB_HOST = https://freebuff.com
//   PROD_API_HOST     = https://www.codebuff.com
//
// 也就是说：**登录页在 freebuff.com，API 在 www.codebuff.com。**
//
// 两个站的登录方式也不同：
//   freebuff.com      → 邮箱登录（这是用户实际用的）
//   www.codebuff.com  → 只有 GitHub / Google 登录
//
// 早期版本错把 API_HOST 当成登录站，结果弹出来的是 Codebuff 的
// GitHub/Google 登录页，而不是 Freebuff 的邮箱登录页。
//
// 换取到的 authToken 是**同一个账号体系**下的令牌，两个 host 的 API 都认它。

/** 登录站在 freebuff.com（邮箱登录）。 */
export const AUTH_HOST = "https://freebuff.com"

/** API 站在 codebuff.com（真正打 /api/v1/* 的地方）。 */
export const API_HOST = "https://www.codebuff.com"

const CODE_PATH = "/api/auth/cli/code"
const STATUS_PATH = "/api/auth/cli/status"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 开始一次登录：向服务端要一个 auth_code。
 * @returns {{fingerprintId, fingerprintHash, loginUrl, expiresAt, deadline}}
 */
export async function startLogin(authHost = AUTH_HOST, { timeoutMs = 20_000, retries = 2 } = {}) {
  const fingerprintId = crypto.randomUUID()
  const url = new URL(CODE_PATH, authHost)

  // ⚠ 首次请求常因 DNS + TLS 冷启动慢到 8 秒以上（实测 8246ms → 后续 250ms），
  // 而 magpie 的 oauth authorize 有它自己的超时，慢一次就报
  // "context deadline exceeded"。所以这里带重试，并且超时给足。
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprintId }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        // 4xx 不重试（不是瞬时故障）
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`登录服务返回 HTTP ${res.status}（${url}）`)
        }
        lastErr = new Error(`登录服务返回 HTTP ${res.status}（${url}）`)
        continue
      }
      return parseLoginResponse(await res.json(), fingerprintId, authHost)
    } catch (e) {
      lastErr = e
      if (i < retries) await new Promise((r) => setTimeout(r, 600 * (i + 1)))
    }
  }
  throw lastErr ?? new Error("登录服务无响应")
}

function parseLoginResponse(data, fingerprintId, authHost) {
  const fingerprintHash = typeof data.fingerprintHash === "string" ? data.fingerprintHash.trim() : ""
  const loginUrl = typeof data.loginUrl === "string" ? data.loginUrl.trim() : ""
  const expiresAt = Number(data.expiresAt)
  const expiresInMs = Number(data.expiresInMs)
  if (!fingerprintHash) throw new Error("登录响应缺少 fingerprintHash")
  if (!loginUrl) throw new Error("登录响应缺少 loginUrl")
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error("登录响应缺少有效的 expiresAt")

  return {
    // 记下发放这个 code 的 host：轮询必须在同一个 host 上，否则 401
    authHost,
    fingerprintId,
    fingerprintHash,
    loginUrl,
    expiresAt,
    deadline: Date.now() + (Number.isFinite(expiresInMs) && expiresInMs > 0 ? expiresInMs : 3_600_000),
  }
}

/** 预热：提前建立到登录站的连接，避免第一次 authorize 慢到超时。 */
/**
 * 预热：降低首次 authorize() 的延迟。
 *
 * ⚠ 实测（2026-10-24）：本机到 freebuff.com / www.codebuff.com 的
 * **每个请求固定要 ~8 秒**（同网段 216.24.57.x，百度只要 188ms）。
 * 这不是冷启动，是网络路径问题，预热消除不了它。
 *
 * 所以这里只能做「提前开始」，把这段延迟挪到 authorize 之前：
 * 宿主可以在插件注册时就调一次，让连接池先建立好。
 * 对 HTTP/1.1 keep-alive 有帮助；对每次新建连接无效。
 */
export async function warmUp(authHost = AUTH_HOST) {
  const tasks = [
    fetch(new URL("/", authHost), {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null),
    fetch(new URL(CODE_PATH, authHost), {
      method: "OPTIONS",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null),
  ]

  try {
    await Promise.all(tasks)
    return true
  } catch {
    return false
  }
}

/**
 * 轮询登录结果，拿到 authToken 就返回账号。
 * @param {(info: {code: string, url: string}) => any} onNeedUser
 *        需要通知用户去浏览器登录时调用；插件宿主可把它变成弹窗/日志。
 */
export async function waitForLogin(authHost, attempt, { onNeedUser, pollIntervalMs = 2_000, timeoutMs = 15_000, signal } = {}) {
  // code 只在发放它的 host 上有效，优先用 attempt 里记的那个
  const host = attempt?.authHost || authHost || AUTH_HOST
  onNeedUser?.({ code: attempt.fingerprintHash, url: attempt.loginUrl })

  const url = new URL(STATUS_PATH, host)
  url.searchParams.set("fingerprintId", attempt.fingerprintId)
  url.searchParams.set("fingerprintHash", attempt.fingerprintHash)
  url.searchParams.set("expiresAt", String(attempt.expiresAt))

  while (Date.now() < attempt.deadline) {
    if (signal?.aborted) throw new Error("登录已取消")
    await sleep(pollIntervalMs)
    if (Date.now() >= attempt.deadline) break

    let user = null
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
      })
      if (res.ok) user = (await res.json())?.user ?? null
    } catch {
      // 网络抖动：继续轮询
    }

    if (user?.authToken) {
      return {
        token: user.authToken,
        userId: typeof user.id === "string" ? user.id : "",
        email: typeof user.email === "string" ? user.email : "",
        name: typeof user.name === "string" ? user.name : "",
      }
    }
  }
  throw new Error("登录超时——请重新添加账号")
}
