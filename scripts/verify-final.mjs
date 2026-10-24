// 最终验证：在真实安装环境（tgz 装进来的）逐项检查
const SB = (process.env.TEMP ?? '/tmp') + '/fb-final'
const mod = (p) => import(`file://${SB}/node_modules/${p}`)

let pass = 0
let fail = 0
const ck = async (n, fn) => {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${n}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${n}  ${e.message}`)
  }
}

const SSE = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
].join('\n')

console.log('='.repeat(70))
console.log('最终验证：tgz 装进干净环境后')
console.log('='.repeat(70))
console.log('沙箱:', SB, '\n')

// ── core ──
console.log('1. freebuff-core')
const core = await mod('freebuff-core/index.mjs')
await ck('parseFreebuffSSE 解析出 tool_call', () => {
  const r = core.parseFreebuffSSE(SSE)
  if (r.toolCalls.length !== 1) throw new Error(`实际 ${r.toolCalls.length}`)
  if (r.toolCalls[0].function.name !== 'read_file') throw new Error('name 错')
  if (r.toolCalls[0].function.arguments !== '{"path":"a.txt"}') throw new Error('arguments 错')
})
await ck('resolveToolPairing 剔除孤儿', () => {
  const r = core.resolveToolPairing([
    { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
  ])
  if (r.keepCallIds.size !== 0) throw new Error('未剔除')
})
await ck('serializeMessages 产出 role:tool', () => {
  const w = core.serializeMessages(
    [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'out' },
    ],
    (t) => [{ type: 'text', text: t }],
  )
  const t = w.find((m) => m.role === 'tool')
  if (!t || t.tool_call_id !== 'c') throw new Error('序列化错')
})

// ── magpie ──
console.log('\n2. magpie-freebuff-provider')
const mag = await mod('magpie-freebuff-provider/index.mjs')
const fn = Object.keys(mag).find((k) => k !== '_internal' && typeof mag[k] === 'function')
let p
await ck(`插件函数 ${fn} 可实例化`, async () => {
  p = await mag[fn]({ client: { app: { log() {} } } })
  if (p.provider.id !== 'freebuff') throw new Error('provider id 错')
})
await ck('图标从 package.json 读出', () => {
  if (!p.provider.icon) throw new Error('无图标')
  if (p.provider.icon.length < 40000) throw new Error(`太短: ${p.provider.icon.length}`)
  if (!p.provider.icon.startsWith('data:image/png;base64,')) throw new Error('格式错')
})
await ck('config 有 8 个模型', async () => {
  const cfg = {}
  await p.config(cfg)
  const n = Object.keys(cfg.provider.freebuff.models).length
  if (n !== 8) throw new Error(`实际 ${n}`)
})
await ck('2 种登录方式（浏览器 + Token）', () => {
  if (p.auth.methods.length !== 2) throw new Error(`实际 ${p.auth.methods.length}`)
})

// ── dsh ──
console.log('\n3. dsh-freebuff-provider')
const dsh = await mod('dsh-freebuff-provider/index.mjs')
await ck('apply 返回 8 个模型', () => {
  const o = dsh.apply({ logger: () => ({ info() {} }) })
  if (o.provider.models.length !== 8) throw new Error(`实际 ${o.provider.models.length}`)
})
await ck('patchEntry baseURL 正确', () => {
  const q = dsh.patchEntry(8937)
  if (q.config.providers.freebuff.baseURL !== 'http://127.0.0.1:8937/v1') throw new Error('错')
})
await ck('patchEntry 模型带 freebuff/ 前缀', () => {
  const q = dsh.patchEntry()
  const m = q.config.providers.freebuff.models[0]
  if (!m.id.startsWith('freebuff/')) throw new Error(`实际 ${m.id}`)
})

// ── bin ──
console.log('\n4. 可执行入口')
const fs = await import('node:fs')
await ck('freebuff-gateway 已注册到 .bin', () => {
  const p1 = `${SB}/node_modules/.bin/freebuff-gateway`
  if (!fs.existsSync(p1)) throw new Error('未找到')
})
await ck('gateway.mjs 存在', () => {
  const p1 = `${SB}/node_modules/dsh-freebuff-provider/gateway.mjs`
  if (!fs.existsSync(p1)) throw new Error('未找到')
  if (fs.statSync(p1).size < 10000) throw new Error('文件太小')
})

console.log('\n' + '='.repeat(70))
console.log(`结果: ${pass} 通过, ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail === 0 ? 0 : 1)
