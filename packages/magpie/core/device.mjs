// Freebuff 的设备签名。
//
// 服务端对会话/对话类接口要求 Ed25519 签名，防重放。三个头：
//   x-freebuff-device-key  = 注册后服务端给的 keyId
//   x-freebuff-device-ts   = 毫秒时间戳
//   x-freebuff-device-sig  = base64url(签名)
//
// 签名载荷（逐字，从 orchestrator.js 的 freebuffDeviceSignaturePayload 逆向）：
//   freebuff-device-v1\n<METHOD 大写>\n<PATH>\n<timestampMs>\n<sha256(body) hex>\n<fetchId 或空串>
//
// 注意：设备密钥对**是客户端自己生成的**（服务端只收公钥），
// 所以这里生成密钥不算"破解"，它本来就是设计成客户端自证的。

import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto"

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** 生成一对新的 Ed25519 设备密钥（PKCS8 DER 的 base64 私钥 + raw 公钥）。 */
export function generateDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    version: 1,
    publicKey: b64url(publicKey.export({ type: "spki", format: "der" }).subarray(-32)),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    registrations: {},
  }
}

/** 把注册了 device key 的账号 scope 算出来：`<host> user:<id>`。 */
export function scopeOf(host, userId) {
  return `${host.replace(/\/$/, "")} user:${userId}`
}

export function sha256hex(body) {
  return createHash("sha256").update(body ?? "").digest("hex")
}

/** 生成三个设备签名头。 */
export function signDevice({ privateKey, keyId, method, path, body, fetchId, now = Date.now() }) {
  if (!keyId) return {}
  const payload = [
    "freebuff-device-v1",
    String(method).toUpperCase(),
    path,
    String(now),
    sha256hex(body),
    fetchId ?? "",
  ].join("\n")
  const keyObj = createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  })
  return {
    "x-freebuff-device-key": keyId,
    "x-freebuff-device-ts": String(now),
    "x-freebuff-device-sig": b64url(sign(null, Buffer.from(payload), keyObj)),
  }
}
