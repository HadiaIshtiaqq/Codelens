# Deploy CodeLens to a free Hugging Face Space, so it opens on any computer.
#
#   .\scripts\deploy-hf.ps1                     -> asks for your Hugging Face token (hidden), deploys to <you>/codelens
#   .\scripts\deploy-hf.ps1 -Space my-codelens  -> another Space name
#   .\scripts\deploy-hf.ps1 -AccessCode xyz     -> your own access code (default: a new random one)
#
# What it does: checks the token, creates the Space (Docker) if needed, stores GEMINI_API_KEY (from
# backend\.env) and the access code as Space *secrets*, uploads the committed code (git HEAD) with the
# Space Dockerfile, and prints the link for judges. Re-run it after new commits to update the Space.
#
# Token: https://huggingface.co/settings/tokens -> "Create new token" -> type "Write".
param([string]$Space = "codelens", [string]$AccessCode = "")
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # Windows PowerShell 5.1 defaults to old TLS
$root = Split-Path -Parent $PSScriptRoot
$api = "https://huggingface.co/api"

$token = $env:HF_TOKEN
if (-not $token) {
    $secure = Read-Host "Hugging Face token (Write access; it is not shown or saved)" -AsSecureString
    # Works in Windows PowerShell 5.1 and PowerShell 7.
    $token = (New-Object System.Management.Automation.PSCredential("hf", $secure)).GetNetworkCredential().Password
}
$token = $token.Trim()
$auth = @{ Authorization = "Bearer $token" }

function Invoke-Hf($method, $path, $body) {
    $json = if ($body) { $body | ConvertTo-Json -Compress } else { $null }
    Invoke-RestMethod -Method $method -Uri "$api$path" -Headers $auth -Body $json -ContentType "application/json"
}

# 1) Who am I?
$me = Invoke-Hf GET "/whoami-v2" $null
$owner = $me.name
Write-Host "Signed in to Hugging Face as $owner" -ForegroundColor Green

# 2) The Space (Docker SDK). An existing one is reused.
try {
    Invoke-Hf POST "/repos/create" @{ type = "space"; name = $Space; sdk = "docker"; private = $false } | Out-Null
    Write-Host "Created the Space $owner/$Space" -ForegroundColor Green
} catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 409) { throw }
    Write-Host "Updating the existing Space $owner/$Space" -ForegroundColor Cyan
}
$hostName = ("$owner-$Space").ToLower() -replace "[^a-z0-9-]", "-"
$hostName = "$hostName.hf.space"

# 3) Settings: secrets stay encrypted in the Space; variables are plain settings.
if (-not $AccessCode) { $AccessCode = [guid]::NewGuid().ToString("N").Substring(0, 12) }
$envFile = Join-Path $root "backend\.env"
$dotenv = @{}
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $dotenv[$Matches[1]] = $Matches[2].Trim() }
    }
}
Invoke-Hf POST "/spaces/$owner/$Space/secrets" @{ key = "CODELENS_ACCESS_CODE"; value = "judges:$AccessCode" } | Out-Null
foreach ($name in "GEMINI_API_KEY", "NEBIUS_API_KEY") {
    if ($dotenv[$name]) { Invoke-Hf POST "/spaces/$owner/$Space/secrets" @{ key = $name; value = $dotenv[$name] } | Out-Null; Write-Host "  secret $name set" }
}
$variables = @{ CODELENS_MCP_PUBLIC_HOSTS = $hostName; CODELENS_CORS_ORIGINS = "https://$hostName" }
foreach ($name in "GEMINI_MODEL", "CODELENS_LLM_TIMEOUT") { if ($dotenv[$name]) { $variables[$name] = $dotenv[$name] } }
foreach ($kv in $variables.GetEnumerator()) {
    Invoke-Hf POST "/spaces/$owner/$Space/variables" @{ key = $kv.Key; value = $kv.Value } | Out-Null
}
Write-Host "  access code and settings stored" -ForegroundColor Green

# 4) Upload the committed code with the Space's Dockerfile and README header.
$work = Join-Path $root "tools\hf-space"
$zip = Join-Path $root "tools\hf-space.zip"
New-Item -ItemType Directory -Force (Join-Path $root "tools") | Out-Null
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
git -C $root archive --format=zip -o $zip HEAD
Expand-Archive -Path $zip -DestinationPath $work
Remove-Item $zip
Copy-Item (Join-Path $root "deploy\hosted\Dockerfile") (Join-Path $work "Dockerfile") -Force
$readme = (Get-Content (Join-Path $root "deploy\hosted\SPACE_HEADER.md") -Raw) + (Get-Content (Join-Path $work "README.md") -Raw)
[IO.File]::WriteAllText((Join-Path $work "README.md"), $readme, (New-Object Text.UTF8Encoding $false))

Push-Location $work
try {
    git init -q -b main
    git add -A
    git -c user.name="CodeLens deploy" -c user.email="deploy@codelens.local" commit -q -m "Deploy CodeLens $(git -C $root rev-parse --short HEAD)"
    Write-Host "Uploading to Hugging Face..." -ForegroundColor Cyan
    git push -q --force "https://${owner}:${token}@huggingface.co/spaces/$owner/$Space" main 2>&1 | ForEach-Object { $_ -replace [regex]::Escape($token), "***" }
    if ($LASTEXITCODE -ne 0) { throw "git push to Hugging Face failed" }
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  Deployed. The Space builds for a few minutes, then:" -ForegroundColor Green
Write-Host "    Link for judges (code included): https://$hostName/#access=$AccessCode" -ForegroundColor Green
Write-Host "    Plain address:                   https://$hostName   (access code: $AccessCode)"
Write-Host "    Alexa+ / MCP endpoint:           https://$hostName/mcp   (Authorization: Bearer $AccessCode)"
Write-Host "    Build progress and logs:         https://huggingface.co/spaces/$owner/$Space"
