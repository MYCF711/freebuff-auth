# npm 发布（beta 通道）
#
# 前置：npm login
# 用法：.\publish-npm.ps1
#
# 这条通道把包发到 npm 的 `beta` 标签，`latest` 不受影响：
#   npm install magpie-freebuff-provider        → 装不到（还没有 latest）
#   npm install magpie-freebuff-provider@beta   → 装 beta
#
# tool calling 尚未在真账号上验证，所以先只发 beta。

$ErrorActionPreference = "Stop"
$TAG = "beta"
cd "D:\主工作区\freebuff-auth-monorepo"

Write-Host "=== 0. 检查登录 ===" -ForegroundColor Cyan
$who = npm whoami 2>&1
if ($who -notmatch "^[a-z0-9_-]+$") {
    Write-Host "X 未登录。先跑: npm login" -ForegroundColor Red
    exit 1
}
Write-Host "OK 已登录: $who" -ForegroundColor Green

Write-Host "`n=== 1. 跑测试 ===" -ForegroundColor Cyan
node scripts/test.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "X 测试失败，中止发布" -ForegroundColor Red
    exit 1
}

Write-Host "`n=== 2. 检查包名可用 ===" -ForegroundColor Cyan
foreach ($n in @("freebuff-core", "magpie-freebuff-provider", "dsh-freebuff-provider")) {
    $v = npm view $n version 2>&1 | Out-String
    if ($v -match "E404|404") {
        Write-Host "  OK $n 未被占用" -ForegroundColor Green
    } else {
        Write-Host "  ! $n 已存在 v$($v.Trim()) —— 会追加一个 beta 版本，不影响 latest" -ForegroundColor Yellow
    }
}

Write-Host "`n=== 3. 发布 freebuff-core（依赖）===" -ForegroundColor Cyan
npm publish --workspace freebuff-core --access public --tag $TAG

Write-Host "`n=== 4. 发布 magpie-freebuff-provider ===" -ForegroundColor Cyan
npm publish --workspace magpie-freebuff-provider --access public --tag $TAG

Write-Host "`n=== 5. 发布 dsh-freebuff-provider ===" -ForegroundColor Cyan
npm publish --workspace dsh-freebuff-provider --access public --tag $TAG

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host ""
Write-Host "验证："
Write-Host "  npm view freebuff-core dist-tags"
Write-Host "  npm view magpie-freebuff-provider dist-tags"
Write-Host "  npm view dsh-freebuff-provider dist-tags"
Write-Host ""
Write-Host "安装（beta）："
Write-Host "  magpie plugin add magpie-freebuff-provider@beta"
Write-Host "  dsh plugin --profile desktop add dsh-freebuff-provider@beta"
Write-Host ""
Write-Host "真机验证通过后，把 beta 提升为 latest："
Write-Host "  npm dist-tag add freebuff-core@beta latest"
Write-Host "  npm dist-tag add magpie-freebuff-provider@beta latest"
Write-Host "  npm dist-tag add dsh-freebuff-provider@beta latest"
