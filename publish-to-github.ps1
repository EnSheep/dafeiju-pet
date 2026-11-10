# 把 cat-pet 发布到 GitHub
#
# 用法（在 cat-pet 目录下执行）：
#   powershell -ExecutionPolicy Bypass -File .\publish-to-github.ps1 -Token <你的PAT>
#
# 可选：
#   -RepoName  仓库名，默认 dafeiju-pet
#   -Private   建私有仓库（默认公开）
#
# 注意：Token 只在内存里用一次，不会写进 .git/config。
#       建议用 Fine-grained token，权限只勾 "Repository permissions → Contents: Read and write"
#       和 "Administration: Read and write"（建仓库需要）。

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$RepoName = 'dafeiju-pet',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$api = 'https://api.github.com'
$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'cat-pet-publish'
  'X-GitHub-Api-Version' = '2022-11-28'
}

# 1) 我是谁
Write-Host '[1/5] 校验 token...' -ForegroundColor Cyan
$me = Invoke-RestMethod -Uri "$api/user" -Headers $headers
Write-Host "      登录为：$($me.login)" -ForegroundColor Green

# 2) 建仓库（已存在就复用）
Write-Host "[2/5] 创建仓库 $($me.login)/$RepoName ..." -ForegroundColor Cyan
$body = @{
  name        = $RepoName
  description = '大肥橘猫 · 桌面 AI 陪伴宠物：Electron 桌宠 + 本地大模型 + 三层记忆库 + 克隆音色 TTS'
  private     = [bool]$Private
  has_issues  = $true
  has_wiki    = $false
} | ConvertTo-Json

try {
  $repo = Invoke-RestMethod -Uri "$api/user/repos" -Method Post -Headers $headers -Body $body -ContentType 'application/json'
  Write-Host "      已创建：$($repo.html_url)" -ForegroundColor Green
}
catch {
  $msg = $_.ErrorDetails.Message
  if ($msg -match 'already exists') {
    Write-Host '      仓库已存在，复用' -ForegroundColor Yellow
    $repo = Invoke-RestMethod -Uri "$api/repos/$($me.login)/$RepoName" -Headers $headers
  }
  else { throw }
}

# 3) 配 remote（不把 token 写进 config）
Write-Host '[3/5] 配置 remote...' -ForegroundColor Cyan
$remoteUrl = "https://github.com/$($me.login)/$RepoName.git"
git remote remove origin 2>$null
git remote add origin $remoteUrl
Write-Host "      origin -> $remoteUrl" -ForegroundColor Green

# 4) 推送（token 通过一次性 header 传，不落盘）
Write-Host '[4/5] 推送 main 分支（66 MB，首次可能要几分钟）...' -ForegroundColor Cyan
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
git -c http.extraheader="AUTHORIZATION: basic $basic" push -u origin main
if ($LASTEXITCODE -ne 0) { throw "推送失败（exit $LASTEXITCODE）" }

# 5) 设置 topics
Write-Host '[5/5] 设置仓库标签...' -ForegroundColor Cyan
$topics = @{
  names = @('electron', 'desktop-pet', 'llm', 'rag', 'sqlite', 'tts', 'voice-clone',
            'ollama', 'qwen', 'typescript', 'ai-companion', 'vector-search')
} | ConvertTo-Json
try {
  Invoke-RestMethod -Uri "$api/repos/$($me.login)/$RepoName/topics" -Method Put -Headers $headers -Body $topics -ContentType 'application/json' | Out-Null
  Write-Host '      已设置' -ForegroundColor Green
}
catch { Write-Host '      标签设置失败（不影响仓库）' -ForegroundColor Yellow }

Write-Host ''
Write-Host "完成：$($repo.html_url)" -ForegroundColor Green
Write-Host '建议随后在仓库 Settings 里补充 About 和 Release。'
