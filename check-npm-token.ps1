# 检查 npm token 是否具备发布条件
# 用法：.\check-npm-token.ps1

$t = (Get-Content "D:\MyKey\npm\npm_token.txt" -Raw).Trim()
if (-not $t) { Write-Host "X token 文件是空的" -ForegroundColor Red; exit 1 }

try {
    $r = Invoke-RestMethod -Uri "https://registry.npmjs.org/-/npm/v1/tokens" `
         -Headers @{Authorization="Bearer $t"} -TimeoutSec 20
} catch {
    Write-Host "X token 无效（HTTP $($_.Exception.Response.StatusCode.value__)）" -ForegroundColor Red
    exit 1
}

$tok = $r.objects[0]
$ok = $true

Write-Host "=== npm token 检查 ===" -ForegroundColor Cyan
Write-Host "  name      : $($tok.name)"
Write-Host "  expiry    : $($tok.expiry)"

$write = $tok.permissions | Where-Object { $_.name -eq "package" -and $_.action -eq "write" }
if ($write) {
    Write-Host "  package:write : OK" -ForegroundColor Green
} else {
    Write-Host "  package:write : X 缺失" -ForegroundColor Red
    $ok = $false
}

if ($tok.bypass_2fa -eq $true) {
    Write-Host "  bypass_2fa    : OK" -ForegroundColor Green
} else {
    Write-Host "  bypass_2fa    : X false（发布时会要 OTP）" -ForegroundColor Red
    $ok = $false
}

Write-Host ""
if ($ok) {
    Write-Host "可以发布。跑 .\publish-npm.ps1" -ForegroundColor Green
} else {
    Write-Host "请重建 token，勾上 Allow this token to bypass 2FA" -ForegroundColor Yellow
    Write-Host "  https://www.npmjs.com/settings/mycf711/tokens"
    exit 1
}
