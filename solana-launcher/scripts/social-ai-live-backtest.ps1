param(
    [string]$Mint = "4gg5gpRC897sxsFBd5EXedTffepBNzcKfySB5opNxruM",
    [string]$Base = "http://127.0.0.1:3000"
)

$ErrorActionPreference = "Stop"
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Name, [string]$Status, [string]$Detail) {
    $row = [pscustomobject]@{ name = $Name; status = $Status; detail = $Detail }
    $results.Add($row)
    $color = if ($Status -eq "PASS") { "Green" } elseif ($Status -eq "WARN") { "Yellow" } else { "Red" }
    Write-Host ("[{0}] {1}: {2}" -f $Status, $Name, $Detail) -ForegroundColor $color
}

function Get-Json([string]$Uri, [int]$TimeoutSec = 30) {
    return Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec
}

Write-Host "=== POTAPoff Social + AI live backtest ===" -ForegroundColor Cyan
Write-Host "Mint=$Mint"

# 1. Container existence / state.
foreach ($name in @("potapoff-frontend", "potapoff-backend")) {
    try {
        $state = docker inspect $name --format '{{.State.Status}}' 2>$null
        if ($state -eq "running") { Add-Result "container:$name" "PASS" "running" }
        else { Add-Result "container:$name" "FAIL" "state=$state" }
    } catch {
        Add-Result "container:$name" "FAIL" "not found"
    }
}

# 2. Unified source health endpoint.
$health = $null
try {
    $health = Get-Json "$Base/api/trade/source-health" 20
    Add-Result "source-health" "PASS" "endpoint reachable"
} catch {
    Add-Result "source-health" "FAIL" $_.Exception.Message
}

if ($health) {
    if ($health.x.authSessionPresent) { Add-Result "x-auth" "PASS" "storage-state mounted" }
    else { Add-Result "x-auth" "FAIL" "storage-state missing inside frontend" }

    if ($health.x.chromiumPresent) { Add-Result "x-chromium" "PASS" "Chromium present" }
    else { Add-Result "x-chromium" "FAIL" "Chromium missing in frontend runtime" }

    $tg = $health.telegram
    if ($tg.available) { Add-Result "telegram-backend" "PASS" "monitor/status reachable" }
    else { Add-Result "telegram-backend" "FAIL" ("status=" + $tg.status) }

    if ($tg.configured) { Add-Result "telegram-collector-config" "PASS" ("mode=" + $tg.mode) }
    else { Add-Result "telegram-collector-config" "FAIL" "collector is not configured" }

    if ($tg.background_running) { Add-Result "telegram-scheduler" "PASS" "background loop running" }
    else { Add-Result "telegram-scheduler" "FAIL" "background loop stopped" }

    if ($tg.public_web_enabled -or $tg.session_configured) {
        Add-Result "telegram-ingest-path" "PASS" ("public_web=" + $tg.public_web_enabled + "; session=" + $tg.session_configured)
    } else {
        Add-Result "telegram-ingest-path" "FAIL" "no MTProto session and public web disabled"
    }

    if ($tg.last_error) { Add-Result "telegram-last-error" "WARN" ([string]$tg.last_error) }
    else { Add-Result "telegram-last-error" "PASS" "none" }

    $ai = $health.ai
    if ($ai.available) { Add-Result "ai-status" "PASS" "status endpoint reachable" }
    else { Add-Result "ai-status" "FAIL" ("status=" + $ai.status) }

    if ($ai.enabled) { Add-Result "ai-enabled" "PASS" "enabled" }
    else { Add-Result "ai-enabled" "FAIL" "disabled" }

    if ($ai.inference.configured) { Add-Result "ai-provider-config" "PASS" ("provider=" + $ai.inference.provider + "; model=" + $ai.inference.model) }
    else { Add-Result "ai-provider-config" "FAIL" ([string]$ai.inference.error) }

    if ($ai.inference.reachable -eq $true) { Add-Result "ai-provider-reachable" "PASS" "reachable" }
    elseif ($ai.inference.reachable -eq $false) { Add-Result "ai-provider-reachable" "FAIL" ([string]$ai.inference.error) }
    else { Add-Result "ai-provider-reachable" "WARN" "reachability unknown" }
}

# 3. Telegram real token data (all-history first; avoids false negatives from a narrow window).
$telegramPayload = $null
try {
    $telegramPayload = Get-Json ("$Base/api/trade/social-token?mint=$Mint&platform=telegram&limit=200") 30
    $mentions = [int]($telegramPayload.mentions)
    $timelineCount = @($telegramPayload.timeline).Count
    if ($mentions -gt 0 -or $timelineCount -gt 0) {
        Add-Result "telegram-token-data" "PASS" ("mentions=$mentions; timeline=$timelineCount")
    } else {
        $mode = [string]$telegramPayload.meta.telegramCollector.mode
        $configured = [bool]$telegramPayload.meta.telegramCollector.configured
        Add-Result "telegram-token-data" "WARN" ("HTTP works but no token matches; collector mode=$mode configured=$configured")
    }
} catch {
    Add-Result "telegram-token-data" "FAIL" $_.Exception.Message
}

# 4. X forced Playwright verifies the browser/session path; auto verifies fallback routing.
try {
    $xForced = Get-Json ("$Base/api/trade/dev-twitter?mint=$Mint&strategy=playwright&limit=20&excludeSuspicious=false") 120
    Add-Result "x-playwright-runtime" "PASS" ("tweets=" + $xForced.totalTweets + "; strategy=" + $xForced.collectionStrategy)
} catch {
    Add-Result "x-playwright-runtime" "FAIL" $_.Exception.Message
}

try {
    $xAuto = Get-Json ("$Base/api/trade/dev-twitter?mint=$Mint&strategy=auto&limit=20&excludeSuspicious=false") 120
    if ([int]$xAuto.totalTweets -gt 0) {
        Add-Result "x-token-data" "PASS" ("tweets=" + $xAuto.totalTweets + "; strategy=" + $xAuto.collectionStrategy)
    } else {
        Add-Result "x-token-data" "WARN" ("collector works but no posts matched; strategy=" + $xAuto.collectionStrategy)
    }
} catch {
    Add-Result "x-token-data" "FAIL" $_.Exception.Message
}

# 5. Real AI bridge test through the same Next route used by the UI.
try {
    $timeline = @()
    if ($telegramPayload -and @($telegramPayload.timeline).Count -gt 0) {
        $timeline = @($telegramPayload.timeline | Select-Object -First 8)
    } else {
        $timeline = @(
            [pscustomobject]@{
                source_handle = "backtest"
                source_name = "POTAPoff runtime backtest"
                text = "Synthetic connectivity probe for AI inference. Do not treat this as token evidence."
                occurred_at = [DateTime]::UtcNow.ToString("o")
                metrics = @{}
            }
        )
    }
    $body = @{ mint = $Mint; timeline = $timeline } | ConvertTo-Json -Depth 12
    $aiBridge = Invoke-RestMethod -Method Post -Uri "$Base/api/trade/social-ai" -ContentType "application/json" -Body $body -TimeoutSec 300
    $summary = [string]$aiBridge.result.summary
    if ($aiBridge.available -and $summary) {
        Add-Result "ai-bridge-inference" "PASS" ("provider=" + $aiBridge.provider + "; model=" + $aiBridge.model + "; summary=present")
    } else {
        Add-Result "ai-bridge-inference" "FAIL" "response returned without usable AI summary"
    }
} catch {
    Add-Result "ai-bridge-inference" "FAIL" $_.Exception.Message
}

# 6. Six tab routes must remain routable.
foreach ($tab in @("overview", "blockchain", "telegram", "twitter", "kols", "ai")) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ("$Base/trade/analysis?mint=$Mint&tab=$tab") -TimeoutSec 20
        if ($response.StatusCode -eq 200) { Add-Result "tab:$tab" "PASS" "HTTP 200" }
        else { Add-Result "tab:$tab" "FAIL" ("HTTP " + $response.StatusCode) }
    } catch {
        Add-Result "tab:$tab" "FAIL" $_.Exception.Message
    }
}

# 7. GMGN regression guard (do not fail on empty live feed).
try {
    $k = Get-Json ("$Base/api/trade/kols?mint=$Mint") 90
    if ($k.configured -and $k.available) {
        Add-Result "gmgn-regression" "PASS" ("kol=" + @($k.kolTrades).Count + "; smart=" + @($k.smartMoneyTrades).Count)
    } else {
        Add-Result "gmgn-regression" "FAIL" ([string]$k.error)
    }
} catch {
    Add-Result "gmgn-regression" "FAIL" $_.Exception.Message
}

$reportDir = Join-Path (Get-Location) "data"
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$reportPath = Join-Path $reportDir "social-ai-backtest-report.json"
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8

$failCount = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$warnCount = @($results | Where-Object { $_.status -eq "WARN" }).Count
$passCount = @($results | Where-Object { $_.status -eq "PASS" }).Count
Write-Host ""
Write-Host ("SUMMARY PASS={0} WARN={1} FAIL={2}" -f $passCount, $warnCount, $failCount) -ForegroundColor Cyan
Write-Host "REPORT=$reportPath"
if ($failCount -gt 0) { exit 1 }
