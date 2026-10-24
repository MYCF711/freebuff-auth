# magpie 装本地 tgz 的正确写法

> 2026-10-25 · 实测踩出来的

---

## 结论

**`magpie plugin add <tgz路径>` 不能用。** 它会失败：

```
Error: exports no OpenCode plugin function
```

**正确做法是两步，照抄 codearts 的形态：**

```jsonc
// ~/.config/magpie/plugins.json
{
  "plugins": [
    { "spec": "magpie-freebuff-provider" }      // ← 包名，不是 tgz 路径
  ]
}
```

```jsonc
// ~/.config/magpie/plugins/package.json
{
  "dependencies": {
    "magpie-freebuff-provider": "./dist/magpie-freebuff-provider-0.3.0-beta.1.tgz"
  }
}
```

```powershell
# tgz 放进 dist/
cp magpie-freebuff-provider-0.3.0-beta.1.tgz "$env:USERPROFILE\.config\magpie\plugins\dist\"
# 用 magpie 自带的 bun 装
& "$env:USERPROFILE\.cache\magpie\bun\1.4.4\magpie-bun.exe" install
```

---

## 为什么 `plugin add <tgz>` 会失败

看 magpie 插件宿主的 `entries()` 实现（`host-*.js`）：

```js
function entries(target) {
  const stat = fs.statSync(target, { throwIfNoEntry: false })
  if (!stat) throw new Error(`no such plugin: ${target}`)
  if (!stat.isDirectory()) return [target]   // ← 不是目录就直接当文件
  // ...
}
```

**`target` 是 `.tgz` 路径时，`stat.isDirectory()` 为 false，于是 magpie 把这个
tgz 当成 JS 模块去 `import()`** —— 当然拿不到任何函数导出。

而注册成**包名**时，magpie 在 `node_modules` 里解析，
那里是 bun 解包后的**目录**，`entries()` 才能正常走 `package.json` 的
`exports` / `main` 分支。

**这是 magpie 的一个缺陷**（`plugin add` 接受 tgz 却不支持），
不是我们包的问题 —— 同样的 tgz 用 npm/bun 装进干净环境后能正常加载
（实测 5/5 通过）。

---

## 另一个坑：npm 和 bun 的锁文件冲突

我一开始用 `npm install` 往 magpie 的 plugins 目录装包，生成了
`package-lock.json`。magpie 用的是 bun，两个锁文件打架，
导致 bun 的安装结果被忽略。

**如果你动过 magpie 的 plugins 目录，清理办法：**

```powershell
$p = "$env:USERPROFILE\.config\magpie\plugins"
Remove-Item "$p\package-lock.json" -Force
Remove-Item "$p\node_modules\.package-lock.json" -Force
```

然后重跑 bun install。

---

## 完整安装脚本

```powershell
# install-magpie.ps1
$ErrorActionPreference = "Stop"
$TAG = "0.3.0-beta.1"
$PKG = "magpie-freebuff-provider"
$SRC = "D:\主工作区\freebuff-auth-monorepo\dist\$PKG-$TAG.tgz"
$CFG = "$env:USERPROFILE\.config\magpie"

# 1. tgz 放进 magpie 的 dist
Copy-Item $SRC "$CFG\plugins\dist\$PKG-$TAG.tgz" -Force

# 2. plugins.json 注册包名
node --input-type=module -e @"
import fs from 'node:fs'
import os from 'node:os'
const p = os.homedir() + '/.config/magpie/plugins.json'
const j = JSON.parse(fs.readFileSync(p, 'utf8'))
j.plugins = j.plugins.filter(x => !String(x.spec).includes('freebuff'))
j.plugins.push({ spec: '$PKG' })
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
"@

# 3. package.json 加本地依赖
node --input-type=module -e @"
import fs from 'node:fs'
import os from 'node:os'
const p = os.homedir() + '/.config/magpie/plugins/package.json'
const j = JSON.parse(fs.readFileSync(p, 'utf8'))
j.dependencies['$PKG'] = './dist/$PKG-$TAG.tgz'
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
"@

# 4. 清 npm 残留
Remove-Item "$CFG\plugins\package-lock.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$CFG\plugins\node_modules\.package-lock.json" -Force -ErrorAction SilentlyContinue

# 5. bun install
Push-Location "$CFG\plugins"
& "$env:USERPROFILE\.cache\magpie\bun\1.4.4\magpie-bun.exe" install
Pop-Location

# 6. 重启 magpie
Get-Process | Where-Object { $_.ProcessName -match 'magpie' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process "E:\Downloads\magpie-windows-amd64.exe"
Start-Sleep -Seconds 20
& "E:\Downloads\magpie-windows-amd64.exe" plugin list | Select-String "freebuff"
```

期望输出：

```
magpie-freebuff-provider  on
  freebuff (Freebuff, 8 models)  not signed in · magpie plugin login freebuff
```

---

## 如果将来发到 npm

包名能被 npm 解析时，就完全不需要本地 tgz 这套：

```powershell
magpie plugin add magpie-freebuff-provider@beta
```

magpie 会自己走 bun 从 registry 装。**这条路才是最终的形态**，
本地 tgz 只是 npm 发布前的过渡。
