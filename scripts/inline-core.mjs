// 把 freebuff-core 内联进 magpie 和 dsh 包，让每个包自包含
//
// 原因：magpie 用 `plugin add <tgz>` 装包时**不解析 dependencies**。
//   我们拆了三包，但 magpie 只装 magpie-freebuff-provider，
//   freebuff-core 没装 → `import from '@freebuff/core'` 失败 →
//   "exports no OpenCode plugin function"
//
//   这是实测踩到的（2026-10-25）。
//
// 方案：把 core 的 .mjs 复制进每个包，改 import 为相对路径。
//   代价是代码重复，但换来「一个 tgz 装完就能用」。
//
// 注：monorepo 里仍然保留 packages/core 作为唯一的**源**，
//   这两个脚本在打包前跑（prepare 钩子）。

import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/主工作区/freebuff-auth-monorepo'
const CORE = path.join(ROOT, 'packages/core')

// core 里要被内联的文件
const CORE_FILES = [
  'tool-calling.mjs',
  'freebuff.mjs',
  'pool.mjs',
  'billing.mjs',
  'cooldown.mjs',
  'device.mjs',
]

function inlineInto(pkgDir, pkgName) {
  const target = path.join(ROOT, 'packages', pkgDir, 'core')
  fs.mkdirSync(target, { recursive: true })

  // 1. 复制 core 文件
  for (const f of CORE_FILES) {
    fs.copyFileSync(path.join(CORE, f), path.join(target, f))
  }
  // 2. 复制 core 的图标（magpie 需要）
  const iconSrc = path.join(CORE, 'icon')
  const iconDst = path.join(target, 'icon')
  if (fs.existsSync(iconSrc)) {
    fs.mkdirSync(iconDst, { recursive: true })
    for (const f of fs.readdirSync(iconSrc)) {
      fs.copyFileSync(path.join(iconSrc, f), path.join(iconDst, f))
    }
  }

  // 3. 生成 core 的 index.mjs（指向同目录）
  fs.writeFileSync(
    path.join(target, 'index.mjs'),
    `// 内联的 freebuff-core（由 scripts/inline-core.mjs 生成，勿手改）
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
`,
  )

  // 4. 把这个包里所有 `from 'freebuff-core...'` 改成相对路径
  let changed = 0
  for (const f of fs.readdirSync(path.join(ROOT, 'packages', pkgDir))) {
    if (!f.endsWith('.mjs')) continue
    const fp = path.join(ROOT, 'packages', pkgDir, f)
    let c = fs.readFileSync(fp, 'utf8')
    const before = c
    c = c.split("from 'freebuff-core'").join("from './core/index.mjs'")
    c = c.split('from "freebuff-core"').join('from "./core/index.mjs"')
    c = c.split("from 'freebuff-core/tool-calling'").join("from './core/tool-calling.mjs'")
    c = c.split("from 'freebuff-core/freebuff'").join("from './core/freebuff.mjs'")
    c = c.split('from "freebuff-core/tool-calling"').join('from "./core/tool-calling.mjs"')
    c = c.split('from "freebuff-core/freebuff"').join('from "./core/freebuff.mjs"')
    if (c !== before) {
      fs.writeFileSync(fp, c)
      changed++
    }
  }

  // 5. 从 package.json 里去掉对 freebuff-core 的依赖，并把 core/ 加进 files
  const pkgFile = path.join(ROOT, 'packages', pkgDir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  if (pkg.dependencies?.['freebuff-core']) {
    delete pkg.dependencies['freebuff-core']
    if (Object.keys(pkg.dependencies).length === 0) delete pkg.dependencies
  }
  if (!pkg.files.includes('core/**')) pkg.files.push('core/**')
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')

  console.log(`  ${pkgName}: 内联 ${CORE_FILES.length} 个文件, 改 ${changed} 处 import`)
}

console.log('内联 freebuff-core 到各包：')
inlineInto('magpie', 'magpie-freebuff-provider')
inlineInto('dsh', 'dsh-freebuff-provider')

console.log('\n验证：')
for (const p of ['magpie', 'dsh']) {
  const dir = path.join(ROOT, 'packages', p, 'core')
  const n = fs.readdirSync(dir).length
  console.log(`  packages/${p}/core/  ${n} 个文件`)
}
