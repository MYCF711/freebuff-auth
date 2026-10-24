# 一键推送：仓库建好后直接跑这个
# 前置：在 https://github.com/new 建仓库 MYCF711/freebuff-auth（不要勾 README/.gitignore/LICENSE）

$ErrorActionPreference = "Stop"
cd "D:\主工作区\freebuff-auth-monorepo"

Write-Host "=== 1. 检查远端是否存在 ===" -ForegroundColor Cyan
$r = git ls-remote origin 2>&1 | Out-String
if ($r -match "not found|does not appear") {
    Write-Host "❌ 仓库还不存在，请先去 https://github.com/new 创建 MYCF711/freebuff-auth" -ForegroundColor Red
    exit 1
}
Write-Host "✅ 远端可访问" -ForegroundColor Green

Write-Host "`n=== 2. 推送 ===" -ForegroundColor Cyan
git push -u origin main

Write-Host "`n=== 3. 打 tag ===" -ForegroundColor Cyan
git tag -a v0.2.0 -m "v0.2.0 - Freebuff provider for magpie and DeepSeek Harness"
git push origin v0.2.0

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "仓库: https://github.com/MYCF711/freebuff-auth"
Write-Host "Release: https://github.com/MYCF711/freebuff-auth/releases/new"
