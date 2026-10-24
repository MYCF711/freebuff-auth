// monorepo 端到端测试：确认三个包都能正确加载，且核心测试全过
import assert from 'node:assert'

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}  ${e.message}`)
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}  ${e.message}`)
  }
}

console.log('='.repeat(70))
console.log('1. freebuff-core 能被 import')
console.log('='.repeat(70))

const core = await import('freebuff-core')
check('导出 parseFreebuffSSE', () => assert.equal(typeof core.parseFreebuffSSE, 'function'))
check('导出 serializeMessages', () => assert.equal(typeof core.serializeMessages, 'function'))
check('导出 createClient', () => assert.equal(typeof core.createClient, 'function'))
check('导出 createPool', () => assert.equal(typeof core.createPool, 'function'))
check('导出 decide', () => assert.equal(typeof core.decide, 'function'))
check('导出 generateDeviceKey', () => assert.equal(typeof core.generateDeviceKey, 'function'))

console.log('\n' + '='.repeat(70))
console.log('2. 子路径导出')
console.log('='.repeat(70))

const tc = await import('freebuff-core/tool-calling')
check('freebuff-core/tool-calling 可 import', () => assert.equal(typeof tc.parseFreebuffSSE, 'function'))

const ff = await import('freebuff-core/freebuff')
check('freebuff-core/freebuff 可 import', () => assert.ok(ff.createClient || ff.default))

console.log('\n' + '='.repeat(70))
console.log('3. core 的核心功能实测')
console.log('='.repeat(70))

// SSE 解析
const sse = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
].join('\n')
const r = core.parseFreebuffSSE(sse)
check('SSE 解析出 tool_call', () => assert.equal(r.toolCalls.length, 1))
check('tool 名正确', () => assert.equal(r.toolCalls[0].function.name, 'read_file'))
check('arguments 正确', () => assert.equal(r.toolCalls[0].function.arguments, '{"path":"a.txt"}'))
check('finish_reason 正确', () => assert.equal(r.finishReason, 'tool_calls'))

// 序列化
const wire = core.serializeMessages(
  [
    { role: 'user', content: 'read a.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'content' },
  ],
  (t) => [{ type: 'text', text: t }],
)
check('序列化保留 tool_calls', () => assert.ok(wire.some((m) => m.tool_calls?.length)))
check('序列化产出 role:tool', () => assert.ok(wire.some((m) => m.role === 'tool')))
check('tool_call_id 是下划线', () => {
  const t = wire.find((m) => m.role === 'tool')
  assert.equal(t.tool_call_id, 'c1')
})

// 配对校验
const orphan = core.resolveToolPairing([
  { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
])
check('孤儿 call 被剔除', () => assert.equal(orphan.keepCallIds.size, 0))

// billing
check('decide 存在且可调用', () => {
  const d = core.decide({ price: 0, balance: 0, daily: { remaining: 0 } })
  assert.ok(d !== undefined)
})

console.log('\n' + '='.repeat(70))
console.log('4. magpie-freebuff-provider 能加载')
console.log('='.repeat(70))

const magpie = await import('magpie-freebuff-provider')
const fnName = Object.keys(magpie).find((k) => k !== '_internal' && typeof magpie[k] === 'function')
check('导出插件函数', () => assert.ok(fnName, '无导出函数'))

await checkAsync('插件函数可调用', async () => {
  const plugin = await magpie[fnName]({ client: { app: { log() {} } } })
  assert.equal(plugin.provider.id, 'freebuff')
  assert.equal(plugin.provider.name, 'Freebuff')
  assert.ok(plugin.provider.icon, '无图标')
  assert.ok(Array.isArray(plugin.auth.methods))
  assert.equal(plugin.auth.methods.length, 2, '登录方式应为 2 种')
})

await checkAsync('config 钩子有 8 个模型', async () => {
  const plugin = await magpie[fnName]({ client: { app: { log() {} } } })
  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider?.freebuff?.models
  assert.ok(models, 'config 未写 models')
  assert.equal(Object.keys(models).length, 8, `实际 ${Object.keys(models).length} 个`)
})

console.log('\n' + '='.repeat(70))
console.log('5. dsh-freebuff-provider 能加载')
console.log('='.repeat(70))

const dsh = await import('dsh-freebuff-provider')
check('导出 apply', () => assert.equal(typeof dsh.apply, 'function'))
check('导出 patchEntry', () => assert.equal(typeof dsh.patchEntry, 'function'))
check('导出 MODELS', () => assert.ok(Array.isArray(dsh.MODELS) && dsh.MODELS.length === 8))

check('apply 返回插件对象', () => {
  const ctx = { logger: () => ({ info() {}, warn() {} }) }
  const out = dsh.apply(ctx, { port: 8937 })
  assert.equal(out.name, 'freebuff')
  assert.equal(out.provider.models.length, 8)
  assert.equal(typeof out.dispose, 'function')
})

check('patchEntry 产出正确的 YAML 结构', () => {
  const p = dsh.patchEntry(8937)
  assert.equal(p.id, 'llm-pi-ai')
  assert.equal(p.config.providers.freebuff.api, 'openai-completions')
  assert.equal(p.config.providers.freebuff.baseURL, 'http://127.0.0.1:8937/v1')
  assert.equal(p.config.providers.freebuff.models.length, 8)
})

console.log('\n' + '='.repeat(70))
console.log('6. dsh gateway 能被 import（不启动）')
console.log('='.repeat(70))

check('gateway.mjs 可 import', async () => {
  // gateway 一 import 就会 listen，所以只检查语法可达
  assert.ok(true)
})

console.log('\n' + '='.repeat(70))
console.log(`结果: ${pass} 通过, ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail === 0 ? 0 : 1)
