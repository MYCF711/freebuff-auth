# 修补 magpie 的市场缓存，让 Freebuff 在界面里显示正确
#
# 为什么需要：magpie 的标题/描述/许可证/源码按钮来自远程 registry.json，
# 我们的包不在里面。这个脚本在本地缓存里补一条，效果等同于 PR 被合并。
#
# 副作用：magpie 更新市场缓存时可能覆盖，重跑即可。
#
# 用法：.\patch-market.ps1

$ErrorActionPreference = "Stop"
$cache = "$env:USERPROFILE\.cache\magpie\plugin-market.json"

if (-not (Test-Path $cache)) {
    Write-Host "X 找不到 $cache —— 先启动一次 magpie" -ForegroundColor Red
    exit 1
}

Write-Host "=== 1. 停 magpie（防止启动时覆盖）===" -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -match 'magpie' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "=== 2. 写入 market 条目 ===" -ForegroundColor Cyan
$entry = Get-Content "$PSScriptRoot\registry-entry.json" -Raw | ConvertFrom-Json

$env:ENTRY_JSON = $entry | ConvertTo-Json -Depth 5 -Compress
node --input-type=module -e @"
import fs from 'node:fs';
import os from 'node:os';
const p = os.homedir() + '/.cache/magpie/plugin-market.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const e = JSON.parse(process.env.ENTRY_JSON);
const i = j.plugins.findIndex(x => x.package === e.package);
if (i >= 0) j.plugins[i] = e; else j.plugins.push(e);
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('  条目数:', j.plugins.length);
"@

Write-Host "=== 3. 去掉 homepage（避免多出「主页」按钮）===" -ForegroundColor Cyan
node --input-type=module -e @"
import fs from 'node:fs';
import os from 'node:os';
const p = os.homedir() + '/.cache/magpie/plugin-npm.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const e = j['magpie-freebuff-provider'];
if (e?.info) { delete e.info.homepage; fs.writeFileSync(p, JSON.stringify(j, null, 2)); console.log('  已删 homepage'); }
else console.log('  没有 npm 缓存条目（先让 magpie 抓一次）');
"@

Write-Host "=== 4. 启动 magpie ===" -ForegroundColor Cyan
Start-Process "E:\Downloads\magpie-windows-amd64.exe"
Start-Sleep -Seconds 22

Write-Host "=== 完成 ===" -ForegroundColor Green
Write-Host "验证："
$m = Get-Content $cache -Raw | ConvertFrom-Json
$mine = $m.plugins | Where-Object { $_.package -eq 'magpie-freebuff-provider' }
Write-Host "  market: $(if($mine){'OK name=' + $mine.name}else{'X 被覆盖，重跑本脚本'})"
