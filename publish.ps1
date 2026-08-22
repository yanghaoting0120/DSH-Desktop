# DSH-Desktop 一键发布脚本
# 用法：
#   1. 打开浏览器登录 GitHub，生成 Personal Access Token (PAT)：
#      https://github.com/settings/tokens
#      - 点 "Generate new token (classic)"
#      - 勾选 scopes: repo（推送代码与创建 Release 用）
#      - 生成后复制 token（形如 ghp_xxxxxxxx）
#   2. 在本目录运行：
#      .\publish.ps1 -Token "ghp_xxxxxxxx"
#   3. 脚本自动：创建 GitHub 仓库 -> 推送代码 -> 把 zip/exe 传为 Release 附件
# 可选参数：
#   -RepoName "DSH-Desktop"      仓库名（默认 DSH-Desktop）
#   -Visibility "public"         仓库可见性 public / private（默认 public）
#   -Tag "v0.3.0"                Release 标签（默认 v0.3.0）

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Token,
    [string]$RepoName = "DSH-Desktop",
    [string]$Visibility = "public",
    [string]$Tag = "v0.3.0"
)

$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\Git\cmd;C:\Users\Lenovo\gh-cli\bin;" + $env:Path

# ---- 走 UniClash 代理（若在跑）-----------------------------------------------
$proxyOk = Test-NetConnection -ComputerName 127.0.0.1 -Port 53331 -WarningAction SilentlyContinue
if ($proxyOk.TcpTestSucceeded) {
    $env:HTTPS_PROXY = "http://127.0.0.1:53331"
    $env:HTTP_PROXY  = "http://127.0.0.1:53331"
    $env:ALL_PROXY   = "http://127.0.0.1:53331"
    Write-Host "==> 已启用代理 127.0.0.1:53331"
}

$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $proj

# ---- 0. 用 token 登录 gh ------------------------------------------------------
Write-Host "==> 登录 GitHub..."
$env:GH_TOKEN = $Token
$login = gh api user --jq .login 2>&1
if (-not $login) {
    Write-Error "token 无效或网络不通：$login"
    exit 1
}
Write-Host "==> 已登录：$login"

# ---- 1. 配置 git 身份（用 GitHub 账号）---------------------------------------
git config user.name $login
$email = gh api user --jq .email 2>&1
if (-not $email -or $email -match "null") { $email = "$login@users.noreply.github.com" }
git config user.email $email
Write-Host "==> git 身份：$login <$email>"

# ---- 2. 创建仓库并推送 ---------------------------------------------------------
$remoteUrl = "https://github.com/$login/$RepoName.git"
Write-Host "==> 创建仓库 $RepoName ($Visibility)..."
gh repo create $RepoName --$Visibility --source . --remote origin --push 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "==> 仓库可能已存在，改用已有远程并推送..."
    git remote remove origin 2>$null
    git remote add origin $remoteUrl
    git push -u origin master 2>&1
    if ($LASTEXITCODE -ne 0) { git push -u origin main 2>&1 }
}
Write-Host "==> 代码已推送：$remoteUrl"

# ---- 3. 创建 Release 并上传大文件 ----------------------------------------------
Write-Host "==> 创建 Release $Tag ..."
$notes = @(
    "# DSH-Desktop v0.3.0"
    ""
    "DSH 桌面版：桌面通知、打开文件/网址、字号调节、定时提醒、OCR 识别。"
    ""
    "## 使用"
    "- 还没有 DSH：解压后运行 桌面版应用/DSH桌面版-0.3.0.exe"
    "- 已有 DSH：运行 install.ps1 或把 SKILL.md 放入技能目录"
) -join "`n"
gh release create $Tag --title "DSH-Desktop $Tag" --notes $notes 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "==> Release 已存在，更新附件..."
}

# ---- 4. 上传 Release 附件（zip + exe）-----------------------------------------
$zip = "release\DSH桌面版-0.3.0-完整发布包.zip"
$exe = "dsh-desktop-release\桌面版应用\DSH桌面版-0.3.0.exe"
foreach ($f in @($zip, $exe)) {
    if (Test-Path $f) {
        Write-Host "==> 上传 $f ..."
        gh release upload $Tag $f --clobber 2>&1
    } else {
        Write-Warning "找不到附件：$f"
    }
}

Write-Host ""
Write-Host "完成！仓库地址：https://github.com/$login/$RepoName"
Write-Host "Release 页：https://github.com/$login/$RepoName/releases/tag/$Tag"
