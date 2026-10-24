// freebuff-core — Freebuff 协议核心
//
// 这份代码被两个外壳共用：
//   magpie-freebuff-provider  —— magpie 插件（导出 {config, auth, provider} 钩子）
//   dsh-freebuff-provider     —— DSH bundle（导出 cordis 插件，提供 provider）
//
// 核心只做协议：设备签名、catalog、会话准入、SSE 解析、消息规范化。
// 它不认识 magpie，也不认识 DSH。

export {
  parseFreebuffSSE,
  applyTools,
  serializeMessages,
  normalizeHarnessMessages,
  normalizeToolArguments,
  hasUsableToolName,
  isParsableJsonObject,
  detectMessageShape,
  resolveToolPairing,
  buildNonStreamResponse,
  writeSSEResponse,
} from './tool-calling.mjs'

export { createClient, FreebuffError, DEFAULT_HOST } from './freebuff.mjs'

export { createPool, collectAccounts, pickTarget, slug, accountFromAuth } from './pool.mjs'

export {
  resetAtOf,
  decide,
  sessionInfoOf,
  DAILY_FREEBUCKS,
  HOURS_PER_FREEBUCKS,
  SESSION_WINDOW_MS,
} from './billing.mjs'

export { waitReady, markCall } from './cooldown.mjs'

export { generateDeviceKey, scopeOf } from './device.mjs'
