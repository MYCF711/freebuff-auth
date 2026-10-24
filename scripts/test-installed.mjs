// 在真实安装环境里验证（模拟用户装机后）
const SB = process.env.TEMP + '/fb-install-test'

console.log('='.repeat(70))
console.log('在真实安装环境验证（tgz 装进来的）')
console.log('='.repeat(70))
console.log('沙箱:', SB, '\n')

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}  ->  ${e.message}`)
  }
}

// 从沙箱的 node_modules 里 import
const mod = (p) => import(`file://${SB}/node_modules/${p}`)

// ── 1. freebuff-core ──
console.log('1. freebuff-core')
const core = await mod('freebuff-core/index.mjs')
await check('parseFreebuffSSE 可用', () => {
  const r = core.parseFreebuffSSE(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"f","arguments":"{}"}}]}}]}',
  )
  if (r.toolCalls.length !== 1) throw new Error('解析失败')
})
await check('resolveToolPairing 可用', () => {
  if (typeof core.resolveToolPairing !== 'function') throw new Error('不存在')
})

// ── 2. magpie-freebuff-provider ──
console.log('\n2. magpie-freebuff-provider')
const magpie = await mod('magpie-freebuff-provider/index.mjs')
const fnName = Object.keys(magpie).find((k) => k !== '_internal' && typeof magpie[k] === 'function')
await check(`插件函数 ${fnName} 存在`, () => {
  if (!fnName) throw new Error('无导出函数')
})
let plugin
await check('插件可实例化', async () => {
  plugin = await magpie[fnName]({ client: { app: { log() {} } } })
  if (plugin.provider.id !== 'freebuff') throw new Error('provider id 错')
})
await check('图标存在', () => {
  if (!plugin.provider.icon) throw new Error('无图标')
  if (!plugin.provider.icon.startsWith('data:image/png;base64,')) throw new Error('图标格式错')
})
await check('config 有 8 个模型', async () => {
  const cfg = {}
  await plugin.config(cfg)
  const n = Object.keys(cfg.provider.freebuff.models).length
  if (n !== 8) throw new Error(`实际 ${n} 个`)
})
await check('2 种登录方式', () => {
  if (plugin.auth.methods.length !== 2) throw new Error(`实际 ${plugin.auth.methods.length}`)
})

// ── 3. dsh-freebuff-provider ──
console.log('\n3. dsh-freebuff-provider')
const dsh = await mod('dsh-freebuff-provider/index.mjs')
await check('apply 是函数', () => {
  if (typeof dsh.apply !== 'function') throw new Error('不是函数')
})
await check('apply 返回 provider', () => {
  const out = dsh.apply({ logger: () => ({ info() {} }) })
  if (out.provider.models.length !== 8) throw new Error('模型数不对')
})
await check('patchEntry 结构正确', () => {
  const p = dsh.patchEntry(8937)
  if (p.config.providers.freebuff.baseURL !== 'http://127.0.0.1:8937/v1') throw new Error('baseURL 错')
})
await check('MODELS 是 8 个', () => {
  if (dsh.MODELS.length !== 8) throw new Error(`实际 ${dsh.MODELS.length}`)
})

// ── 4. gateway 语法 ──
console.log('\n4. gateway')
await check('gateway.mjs 存在且非空', async () => {
  const fs = await import('node:fs')
  const p = `${SB}/node_modules/dsh-freebuff-provider/gateway.mjs`
  const st = fs.statSync(p)
  if (st.size < 1000) throw new Error('文件太小')
})

console.log('\n' + '='.repeat(70))
console.log(`结果: ${pass} 通过, ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail === 0 ? 0 : 1)
