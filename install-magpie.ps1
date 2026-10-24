# 安装 magpie-freebuff-provider 到本机 magpie
#
# 为什么不用 magpie plugin add <tgz>：magpie 会把 tgz 当 JS 文件 import，
# 报 "exports no OpenCode plugin function"。详见 docs/magpie-装本地tgz的正确写法.md
$ErrorActionPreference = "Stop"

$TAG   = "0.3.0-beta.1"
$PKG   = "magpie-freebuff-provider"
$ROOT  = "D:\主工作区\freebuff-auth-monorepo"
$SRC   = "$ROOT\dist\$PKG-$TAG.tgz"
$CFG   = "$env:USERPROFILE\.config\magpie"
$MAGPIE = "E:\Downloads\magpie-windows-amd64.exe"

if (-not (Test-Path $SRC)) { Write-Host "X 找不到 $SRC，先跑 npm run pack:all" -ForegroundColor Red; exit 1 }

Write-Host "=== 1. 复制 tgz ===" -ForegroundColor Cyan
Copy-Item $SRC "$CFG\plugins\dist\$PKG-$TAG.tgz" -Force
Write-Host "  -> $CFG\plugins\dist\$PKG-$TAG.tgz"

Write-Host "=== 2. 注册到 plugins.json ===" -ForegroundColor Cyan
$script:pkgName = $PKG
node --input-type=module -e "
import fs from 'node:fs';
import os from 'node:os';
const p = os.homedir() + '/.config/magpie/plugins.json';
const j = JSON.parse(fs.readFileSync(p,'utf8'));
j.plugins = j.plugins.filter(x => !String(x.spec).includes('freebuff'));
j.plugins.push({ spec: process.env.PKG_NAME });
fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
console.log('  ok');
"
Write-Host "=== 3. 加本地依赖 ===" -ForegroundColor Cyan
$env:PKG_NAME = $PKG
$env:PKG_TGZ = "./dist/$PKG-$TAG.tgz"
node --input-type=module -e "
import fs from 'node:fs';
import os from 'node:os';
const p = os.homedir() + '/.config/magpie/plugins/package.json';
const j = JSON.parse(fs.readFileSync(p,'utf8'));
j.dependencies[process.env.PKG_NAME] = process.env.PKG_TGZ;
fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
console.log('  ok');
"

Write-Host "=== 4. 清 npm 残留 ===" -ForegroundColor Cyan
Remove-Item "$CFG\plugins\package-lock.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$CFG\plugins\node_modules\.package-lock.json" -Force -ErrorAction SilentlyContinue
Write-Host "  ok"

Write-Host "=== 5. bun install ===" -ForegroundColor Cyan
$bun = "$env:USERPROFILE\.cache\magpie\bun\1.4.4\magpie-bun.exe"
Push-Location "$CFG\plugins"
& $bun install
Pop-Location

Write-Host "=== 6. 重启 magpie ===" -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -match 'magpie' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process $MAGPIE
Start-Sleep -Seconds 20

Write-Host "=== 7. 验证 ===" -ForegroundColor Cyan
& $MAGPIE plugin list 2>&1 | Select-String "freebuff"
