// 复现 magpie 的 servers() 判定，看我们的包会不会被识别
import fs from 'node:fs'
import path from 'node:path'

// magpie 的 servers() 逻辑（原样抄自 host-25ef7cf0d281.js）
function servers(mod) {
  const d = mod.default
  if (d && typeof d === 'object' && ('server' in d || 'id' in d || 'tui' in d)) {
    return typeof d.server === 'function' ? [d.server] : []
  }
  const seen = new Set()
  const out = []
  for (const v of Object.values(mod)) {
    if (seen.has(v)) continue
    seen.add(v)
    if (typeof v === 'function') out.push(v)
    else if (v && typeof v === 'object' && typeof v.server === 'function') out.push(v.server)
  }
  return out
}

// 解包到临时目录再 import（模拟 magpie 装完后的状态）
const TMP = 'D:/主工作区/freebuff-auth-monorepo/.tmp-unpack'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

import { execSync } from 'node:child_process'
const tgz = 'D:/主工作区/freebuff-auth-monorepo/dist/magpie-freebuff-provider-0.3.0-beta.1.tgz'
execSync(`tar -xzf "${tgz}" -C "${TMP}"`)

const target = path.join(TMP, 'package')

console.log('='.repeat(70))
console.log('模拟 magpie 的加载')
console.log('='.repeat(70))
console.log('解包目录:', target)
console.log('')

// 读 package.json
const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
console.log('package.json:')
console.log('  main   :', pkg.main)
console.log('  exports:', JSON.stringify(pkg.exports))
console.log('  type   :', pkg.type)
console.log('')

// entries() 逻辑
function entries(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const out = []
  const add = (v) => typeof v === 'string' && v.trim() && out.push(path.resolve(pkgDir, v.trim()))
  const pick = (x) => (typeof x === 'string' ? x : (x?.import ?? x?.default))
  const ex = pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports) ? pkg.exports : undefined
  if (ex) {
    if (ex['./server']) add(pick(ex['./server']))
    if (ex['.']) add(pick(ex['.']))
  }
  if (pkg.main) add(pkg.main)
  if (out.length === 0) {
    for (const f of ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs']) {
      if (fs.existsSync(path.join(pkgDir, f))) { out.push(path.join(pkgDir, f)); break }
    }
  }
  return out
}

const entryFiles = entries(target)
console.log('entries() 返回的入口文件:')
entryFiles.forEach((f) => console.log('  ' + f))
console.log('')

// 实际 import 并跑 servers()
async function tryLoad(file) {
  const mod = await import('file://' + file.replace(/\\/g, '/'))
  const fns = servers(mod)
  return { file, mod, fns, keys: Object.keys(mod) }
}

for (const f of entryFiles) {
  console.log('='.repeat(70))
  console.log('import:', f)
  console.log('='.repeat(70))
  try {
    const r = await tryLoad(f)
    console.log('  导出键:', r.keys.join(', '))
    console.log('  servers() 识别到:', r.fns.length, '个函数')
    if (r.fns.length === 0) {
      console.log('  ❌ magpie 会报 "exports no OpenCode plugin function"')
      // 检查 default
      if (r.mod.default) {
        console.log('  default 类型:', typeof r.mod.default)
        console.log('  default 键:', r.mod.default && typeof r.mod.default === 'object' ? Object.keys(r.mod.default).join(',') : 'N/A')
      }
    } else {
      console.log('  ✅ 可以加载')
      // 试着调用
      try {
        const plugin = await r.fns[0]({ client: { app: { log() {} } } })
        console.log('  调用成功, 返回键:', Object.keys(plugin).join(', '))
      } catch (e) {
        console.log('  ❌ 调用失败:', e.message.slice(0, 200))
      }
    }
  } catch (e) {
    console.log('  ❌ import 失败:', e.message.slice(0, 300))
    if (e.stack) console.log(e.stack.split('\n').slice(0, 5).join('\n'))
  }
  console.log('')
}

fs.rmSync(TMP, { recursive: true, force: true })
