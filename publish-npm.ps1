# npm 发布：三个包按依赖顺序发
# 前置：npm login

$ErrorActionPreference = "Stop"
cd "D:\主工作区\freebuff-auth-monorepo"

Write-Host "=== 0. 检查登录 ===" -ForegroundColor Cyan
$who = npm whoami 2>&1
if ($who -notmatch "^[a-z0-9_-]+$") {
    Write-Host "❌ 未登录，先跑 npm login" -ForegroundColor Red
    exit 1
}
Write-Host "✅ 已登录: $who" -ForegroundColor Green

Write-Host "`n=== 1. 测试 ===" -ForegroundColor Cyan
node scripts/test.mjs
if ($LASTEXITCODE -ne 0) { Write-Host "❌ 测试失败" -ForegroundColor Red; exit 1 }

Write-Host "`n=== 2. 发布 freebuff-core（依赖）===" -ForegroundColor Cyan
npm publish --workspace freebuff-core --access public

Write-Host "`n=== 3. 发布 magpie-freebuff-provider ===" -ForegroundColor Cyan
npm publish --workspace magpie-freebuff-provider --access public

Write-Host "`n=== 4. 发布 dsh-freebuff-provider ===" -ForegroundColor Cyan
npm publish --workspace dsh-freebuff-provider --access public

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "验证:"
Write-Host "  npm view freebuff-core version"
Write-Host "  npm view magpie-freebuff-provider version"
Write-Host "  npm view dsh-freebuff-provider version"
