# npm 发布（自动 2FA）
#
# 背景：账号开了双重认证，npm publish 需要一次性密码。
# 本脚本用 D:\MyKey\totp.py 算 TOTP，自动传给 npm，不需要人工点浏览器。
#
# 前置（一次性）：
#   把 npm 的 2FA setup key（Base32，形如 ABCD1234EFGH5678）存到
#   D:\MyKey\npm\npm_totp_secret.txt
#
#   在 npmjs.com 哪里拿这个 key：
#     Account → Two-Factor Authentication → 重新配置 TOTP
#     （或「Add authenticator app」时显示的那串 setup key）
#
# 用法：
#   .\publish-npm-2fa.ps1

$ErrorActionPreference = "Stop"

$TAG      = "beta"
$SECRET_F = "D:\MyKey\npm\npm_totp_secret.txt"
$TOTP_PY  = "D:\MyKey\totp.py"
$ROOT     = "D:\主工作区\freebuff-auth-monorepo"

# ── 0. 检查前置 ──
Write-Host "=== 0. 检查前置 ===" -ForegroundColor Cyan

$who = (npm whoami 2>&1 | Out-String).Trim()
if ($who -notmatch "^[a-z0-9_-]+$") {
    Write-Host "X npm 未登录。检查 ~/.npmrc 里有没有 _authToken" -ForegroundColor Red
    exit 1
}
Write-Host "  OK npm: $who" -ForegroundColor Green

if (-not (Test-Path $SECRET_F)) {
    Write-Host "X 缺 TOTP secret: $SECRET_F" -ForegroundColor Red
    Write-Host ""
    Write-Host "  在 https://www.npmjs.com/settings/$who/tfa 重新配置 TOTP，" -ForegroundColor Yellow
    Write-Host "  把显示的 setup key（Base32）存进那个文件，再跑本脚本。" -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path $TOTP_PY)) {
    Write-Host "X 缺 totp.py: $TOTP_PY" -ForegroundColor Red
    exit 1
}
Write-Host "  OK totp.py 存在" -ForegroundColor Green

# ── 1. 算 TOTP 并自检 ──
Write-Host "`n=== 1. 算 TOTP ===" -ForegroundColor Cyan
$secret = (Get-Content $SECRET_F -Raw).Trim()
if (-not $secret) {
    Write-Host "X secret 文件是空的" -ForegroundColor Red
    exit 1
}

# 先跑自检，确认 totp.py 本身没问题
$st = python $TOTP_PY --selftest 2>&1 | Out-String
if ($st -notmatch "ALL PASS") {
    Write-Host "X totp.py 自检失败：" -ForegroundColor Red
    Write-Host $st
    exit 1
}
Write-Host "  OK totp.py 自检通过" -ForegroundColor Green

$otpOut = python $TOTP_PY $secret 2>&1 | Out-String
if ($otpOut -match "CODE:\s*(\d{6})") {
    $otp = $Matches[1]
    Write-Host "  OTP: $otp（30 秒内有效）" -ForegroundColor Green
} else {
    Write-Host "X 算不出 OTP：" -ForegroundColor Red
    Write-Host $otpOut
    exit 1
}

# ── 2. 跑测试 ──
Write-Host "`n=== 2. 跑测试 ===" -ForegroundColor Cyan
Push-Location $ROOT
node scripts/test.mjs
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Write-Host "X 测试失败，中止" -ForegroundColor Red
    exit 1
}
Pop-Location

# ── 3. 发布 ──
Write-Host "`n=== 3. 发布到 npm (tag: $TAG) ===" -ForegroundColor Cyan
Push-Location $ROOT

# OTP 只有 30 秒寿命，三个包要连续发。
# 每个包发布前重算一次，避免前两个用完时间。
foreach ($w in @("freebuff-core", "magpie-freebuff-provider", "dsh-freebuff-provider")) {
    Write-Host "`n-- $w --" -ForegroundColor Yellow

    $code = (python $TOTP_PY $secret 2>&1 | Out-String)
    if ($code -notmatch "CODE:\s*(\d{6})") {
        Write-Host "  X 算 OTP 失败" -ForegroundColor Red
        continue
    }
    $otpNow = $Matches[1]

    npm publish --workspace $w --access public --tag $TAG --otp=$otpNow
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  OK $w 已发布" -ForegroundColor Green
    } else {
        Write-Host "  X $w 发布失败" -ForegroundColor Red
    }
}

Pop-Location

# ── 4. 验证 ──
Write-Host "`n=== 4. 验证 ===" -ForegroundColor Cyan
foreach ($n in @("freebuff-core", "magpie-freebuff-provider", "dsh-freebuff-provider")) {
    $tags = (npm view $n dist-tags --json 2>&1 | Out-String).Trim()
    Write-Host "  $n  $tags"
}

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "安装："
Write-Host "  magpie plugin add magpie-freebuff-provider@beta"
Write-Host "  dsh plugin --profile desktop add dsh-freebuff-provider@beta"
Write-Host ""
Write-Host "真机验证通过后提升为 latest："
Write-Host "  npm dist-tag add freebuff-core@beta latest"
Write-Host "  npm dist-tag add magpie-freebuff-provider@beta latest"
Write-Host "  npm dist-tag add dsh-freebuff-provider@beta latest"
