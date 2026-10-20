#requires -Version 5.1
<#
  Windows Acer -> private GitHub Codespaces BERT inference smoke.
  Explicit on-demand test, not a production worker or database sync.
  No pip, PyTorch, model weights, real collector texts or local AI inference.
#>
param(
    [string]$CodespaceName = "didactic-chainsaw-5v454v99rjqg2pvx7"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
if (-not (Test-Path -LiteralPath (Join-Path $repo "intelligence\nlp\remote.py"))) {
    throw "Remote client missing: use gh pr checkout 142 in the laptop clone first."
}
if ($env:CODESPACES -eq "true") {
    throw "Use this script in Windows PowerShell on the laptop, not inside Codespaces."
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) is missing. Install gh and authenticate with codespace scope."
}
if ($CodespaceName -notmatch '^[a-z][a-z0-9-]{4,100}$') {
    throw "Invalid Codespace name."
}

function Try-Python {
    param([string]$Command, [string[]]$Args)
    try {
        & $Command @Args -c "import sys; assert (3, 11) <= sys.version_info[:2] <= (3, 12)" 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    catch { return $false }
}

$command = $null
$prefix = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($version in @("-3.12", "-3.11")) {
        if (Try-Python -Command "py" -Args @($version)) {
            $command = "py"
            $prefix = @($version)
            break
        }
    }
}
if (-not $command -and (Get-Command python -ErrorAction SilentlyContinue)) {
    if (Try-Python -Command "python" -Args @()) {
        $command = "python"
    }
}
if (-not $command) {
    throw "Python 3.11 or 3.12 not detected on Windows. Install Python 3.12 first."
}

$venv = Join-Path $repo ".venv-sentiment-client"
$python = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    Write-Host "Creating isolated standard-library Python client (no pip packages)..."
    & $command @prefix -m venv $venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python)) {
        throw "Could not create isolated Python client environment."
    }
}

$restore = @{}
$vars = @(
    "SENTIMENT_REMOTE_ENABLED",
    "SENTIMENT_REMOTE_ENDPOINT",
    "SENTIMENT_REMOTE_TOKEN",
    "SENTIMENT_CRYPTOBERT_REVISION",
    "SENTIMENT_FINTWITBERT_REVISION",
    "SENTIMENT_RUBERT_REVISION",
    "SENTIMENT_BATCH_SIZE",
    "SENTIMENT_DEVICE"
)
foreach ($key in $vars) {
    $restore[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}
Push-Location -LiteralPath $repo
try {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/healthz" -TimeoutSec 6
    }
    catch {
        throw "No private port-forward: keep Codespaces API running and run gh codespace ports forward 8765:8765 in another Windows terminal."
    }
    if ($health.status -ne "ready") {
        throw "Codespaces health check did not return ready."
    }

    # gh SSH fetches a token into process memory. It is NEVER displayed, passed
    # on a command line or persisted to a file. Codespace must be owned.
    $token = (& gh codespace ssh -c $CodespaceName -- "cat /workspaces/claude-project/.local/sentiment/api-token" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $token -notmatch '^[A-Za-z0-9_-]{40,512}$') {
        throw "Codespaces API token unavailable; verify gh auth scopes and Codespace name."
    }

    $env:SENTIMENT_REMOTE_ENABLED = "true"
    $env:SENTIMENT_REMOTE_ENDPOINT = "http://127.0.0.1:8765/v1/sentiment/predict"
    $env:SENTIMENT_REMOTE_TOKEN = $token
    # Immutable SHAs verified by real Codespaces model download and forward pass.
    $env:SENTIMENT_CRYPTOBERT_REVISION = "9e37c910fe87727cb842a9ac55c6388256fe0f15"
    $env:SENTIMENT_FINTWITBERT_REVISION = "da059da3b3bbcb43f9ed1aeb5ae61644010c7e1e"
    $env:SENTIMENT_RUBERT_REVISION = "ad9be38671d4444945734cce7cdaadacc5002cc4"
    $env:SENTIMENT_BATCH_SIZE = "2"
    $env:SENTIMENT_DEVICE = "cpu"

    Write-Host "Private Codespaces tunnel is ready. Running three synthetic X/TG messages..."
    & $python -m intelligence.nlp.windows_smoke
    if ($LASTEXITCODE -ne 0) {
        throw "Private Windows remote sentiment smoke failed. Collector databases were not touched."
    }
}
finally {
    foreach ($key in $vars) {
        [Environment]::SetEnvironmentVariable($key, $restore[$key], "Process")
    }
    if (Get-Variable token -Scope Local -ErrorAction SilentlyContinue) {
        $token = $null
    }
    Pop-Location
}
