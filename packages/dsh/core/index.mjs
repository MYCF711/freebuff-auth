// 内联的 freebuff-core（由 scripts/inline-core.mjs 生成，勿手改）
// 源：packages/core/
export {
  parseFreebuffSSE, applyTools, serializeMessages, normalizeHarnessMessages,
  normalizeToolArguments, hasUsableToolName, isParsableJsonObject,
  detectMessageShape, resolveToolPairing, buildNonStreamResponse, writeSSEResponse,
} from './tool-calling.mjs'
export { createClient, FreebuffError, DEFAULT_HOST } from './freebuff.mjs'
export { createPool, collectAccounts, pickTarget, slug, accountFromAuth } from './pool.mjs'
export { resetAtOf, decide, sessionInfoOf, DAILY_FREEBUCKS, HOURS_PER_FREEBUCKS, SESSION_WINDOW_MS } from './billing.mjs'
export { waitReady, markCall } from './cooldown.mjs'
export { generateDeviceKey, scopeOf } from './device.mjs'
