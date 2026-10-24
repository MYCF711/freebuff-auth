// dsh-freebuff-provider — Freebuff 的 DSH 插件入口
//
// 形态：cordis 插件（DSH 的 loader 加载这个模块）
// 职责：
//   1. 提供 Freebuff 的 provider 配置（模型清单 + 本地端点）
//   2. 管理直连网关的生命周期（起停、健康检查）
//   3. 暴露 gateway 供独立运行
//
// 注意：这个包**不自己实现 HTTP 协议** —— 那是 gateway.mjs 和 freebuff-core 的事。
// 它只做「把网关接到 DSH 的 provider 树上」。
//
// ── 为什么是「本地端点」而不是「DSH 原生 provider」 ──
//
// DSH 的 provider 是通过 AI SDK（@ai-sdk/openai-compatible 等）发请求的，
// 它期望对面是一个标准的 OpenAI 兼容端点。Freebuff 需要设备签名、会话准入、
// 账号池轮换 —— 这些都必须在某个进程里做。
//
// 所以架构是：
//   DSH ──(OpenAI 协议)──> 本插件的本地网关 (:8937) ──(Freebuff 协议)──> freebuff.com
//
// 本插件负责把这一段接起来，用户只需要在 DSH 里选模型。

import { FreebuffError, DEFAULT_HOST } from './core/index.mjs'

const PROVIDER = 'freebuff'
const DEFAULT_PORT = 8937
const HOST = '127.0.0.1'

/** 静态模型表：登录前就能让 DSH 看到可选模型 */
const MODELS = [
  { id: 'solar-pro4', name: 'Solar Pro 4', price: 0, ctx: 1048576, image: true, tier: 'UNLIMITED' },
  { id: 'solar-mini-4', name: 'Solar Mini 4', price: 0, ctx: 1048576, image: true, tier: 'UNLIMITED' },
  { id: 'nemotron-3.5-lightning', name: 'Nemotron 3.5 Lightning', price: 0, ctx: 1048576, image: false, tier: 'UNLIMITED' },
  { id: 'glyph-cluster', name: 'Glyph Cluster', price: 0, ctx: 1048576, image: false, tier: 'UNLIMITED' },
  { id: 'mimo-v2.6-flash-slow', name: 'MiMo v2.6 Flash Slow', price: 5, ctx: 1048576, image: true, tier: 'OPTIMIZED' },
  { id: 'mimo-v2.6-flash-fast', name: 'MiMo v2.6 Flash Fast', price: 10, ctx: 1048576, image: true, tier: 'OPTIMIZED' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', price: 15, ctx: 1048576, image: true, tier: 'OPTIMIZED' },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', price: 20, ctx: 1048576, image: true, tier: 'OPTIMIZED' },
]

/**
 * DSH 的 cordis 插件入口。
 *
 * DSH 的 loader 会调用这个函数，传入 cordis 的 ctx。
 * 返回一个对象，DSH 会把它当作插件的对外接口。
 *
 * ⚠ 这个函数必须能被 DSH 的模块加载器直接 import 并调用。
 *   它不应该是 async 的（cordis 的 apply 约定），但为了兼容两种形态，
 *   我们导出的是「返回插件对象的普通函数」。
 */
export function apply(ctx, config = {}) {
  const port = Number(config.port ?? process.env.FREEBUFF_GATEWAY_PORT ?? DEFAULT_PORT)
  const baseURL = `http://${HOST}:${port}/v1`

  const logger = ctx?.logger?.('freebuff') ?? console

  // ── 把 provider 挂到 DSH 的配置树上 ──
  //
  // DSH 的 provider 是通过 @deepseek-ai/dsh-llm-pi-ai 这类 llm 插件声明的。
  // 这里我们只描述「有这样一个 provider」，实际的 provider 注册由用户的
  // cordis.patch.yml 完成（见 README）。
  //
  // 如果 DSH 提供了配置注入 API，这里就用它；否则只打印提示。
  const providerDef = {
    id: PROVIDER,
    displayName: 'Freebuff',
    api: 'openai-completions',
    baseURL,
    models: MODELS.map((m) => ({
      id: `${PROVIDER}/${m.id}`,
      name: `${m.name} · ${m.price === 0 ? '0fb' : m.price + 'fb'}`,
      contextWindow: m.ctx,
      maxTokens: 32768,
      input: m.image ? ['text', 'image'] : ['text'],
    })),
  }

  logger.info?.(`Freebuff provider: ${baseURL} (${MODELS.length} models)`)
  logger.info?.(`网关需单独启动: npx dsh-freebuff-provider gateway`)

  // cordis 插件应返回一个 dispose 函数或对象
  return {
    name: 'freebuff',
    provider: providerDef,
    async dispose() {
      logger.info?.('Freebuff provider disposed')
    },
  }
}

/**
 * 另一种导出形态：有些 DSH 插件用 default 导出。
 */
export default apply

/** 供程序化使用：生成 cordis.patch.yml 需要的片段 */
export function patchEntry(port = DEFAULT_PORT) {
  return {
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: {
      providers: {
        [PROVIDER]: {
          displayName: 'Freebuff',
          apiKeyEnv: 'FREEBUFF_LOCAL_KEY',
          api: 'openai-completions',
          baseURL: `http://${HOST}:${port}/v1`,
          models: MODELS.map((m) => ({
            id: `${PROVIDER}/${m.id}`,
            name: `${m.name} · ${m.price === 0 ? '0fb' : m.price + 'fb'}`,
            contextWindow: m.ctx,
            maxTokens: 32768,
            input: m.image ? ['text', 'image'] : ['text'],
          })),
        },
      },
    },
  }
}

export { MODELS, PROVIDER, DEFAULT_PORT }
export { FreebuffError, DEFAULT_HOST }

// 测试用
export const _internal = { MODELS, PROVIDER, patchEntry }
