param(
    [string]$Username = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path $PSScriptRoot -Parent
$Container = "potapoff-frontend"
$Db = "/app/data/twscrape/accounts.db"

Set-Location $Root

if ([string]::IsNullOrWhiteSpace($Username)) {
    $Username = Read-Host "X username without @"
}

$Username = $Username.Trim().TrimStart("@")

if ($Username -notmatch "^[A-Za-z0-9_]{1,32}$") {
    throw "Invalid X username"
}

$safe = $Username.ToLowerInvariant()

$stateDir = Join-Path $Root "data\x-auth\sessions"
$state = Join-Path $stateDir "$safe-storage-state.json"
$profileRoot = Join-Path $Root "data\x-auth\chrome-profiles"
$profile = Join-Path $profileRoot $safe
$captureScript = Join-Path $Root ".tmp-x-pool-capture.cjs"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null

Write-Host ""
Write-Host "=== POTAPOFF X POOL ADD ==="
Write-Host "USERNAME=$Username"
Write-Host ""

$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromeCandidates |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1

if (-not $chrome) {
    throw "Google Chrome not found"
}

Write-Host "CHROME=$chrome"


New-Item -ItemType Directory -Force -Path $profile | Out-Null
Write-Host "PROFILE=$profile"

$listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
)

$listener.Start()

try {
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
}
finally {
    $listener.Stop()
}

Write-Host "DEBUG_PORT=$port"

$loginUrl = "https" + "://x.com/login"

$chromeArgs = @(
    "--remote-debugging-port=$port",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=$profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    $loginUrl
)

$chromeProcess = Start-Process `
    -FilePath $chrome `
    -ArgumentList $chromeArgs `
    -PassThru

Write-Host "CHROME_LAUNCH_PID=$($chromeProcess.Id)"

$cdpUrl = "http" + "://127.0.0.1:$port/json/version"
$cdpOk = $false
$deadline = [DateTime]::UtcNow.AddSeconds(20)

do {
    try {
        $version = Invoke-RestMethod `
            -Uri $cdpUrl `
            -TimeoutSec 2

        if ($version.webSocketDebuggerUrl) {
            $cdpOk = $true
            break
        }
    }
    catch {
        # Chrome can need a moment before CDP starts listening.
    }

    Start-Sleep -Milliseconds 250
}
while ([DateTime]::UtcNow -lt $deadline)

if (-not $cdpOk) {
    Write-Host "CDP_START=FAILED"
    throw "Chrome started but CDP did not become available on port $port"
}

Write-Host "CDP_START=OK"
Write-Host "BROWSER=$($version.Browser)"
Write-Host ""
Write-Host "REAL_CHROME_STARTED=YES"
Write-Host "Login manually to $Username"
Write-Host "Wait until X home/profile is fully loaded."
Write-Host ""

Read-Host "When login is complete, press ENTER here"

# Verify CDP again after manual X login.
$cdpAlive = $false

try {
    $probe = Invoke-RestMethod -Uri $cdpUrl -TimeoutSec 2

    if ($probe.webSocketDebuggerUrl) {
        $cdpAlive = $true
    }
}
catch {
    $cdpAlive = $false
}

if ($cdpAlive) {
    Write-Host "CDP_BEFORE_CAPTURE=OK"
}
else {
    Write-Host "CDP_BEFORE_CAPTURE=DEAD"
    Write-Host "RESTARTING_SAME_PROFILE=YES"

    # Stop ONLY Chrome processes using this dedicated X profile.
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf(
                $profile,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0
        } |
        ForEach-Object {
            Stop-Process `
                -Id $_.ProcessId `
                -Force `
                -ErrorAction SilentlyContinue
        }

    Start-Sleep -Seconds 1

    # Allocate a fresh localhost debug port.
    $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        0
    )

    $listener.Start()

    try {
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }

    Write-Host "RESTART_DEBUG_PORT=$port"

    $homeUrl = "https" + "://x.com/home"

    $chromeArgs = @(
        "--remote-debugging-port=$port",
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=$profile",
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        $homeUrl
    )

    $chromeProcess = Start-Process `
        -FilePath $chrome `
        -ArgumentList $chromeArgs `
        -PassThru

    Write-Host "RESTART_CHROME_PID=$($chromeProcess.Id)"

    $cdpUrl = "http" + "://127.0.0.1:$port/json/version"

    $cdpOk = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(20)

    do {
        try {
            $version = Invoke-RestMethod `
                -Uri $cdpUrl `
                -TimeoutSec 2

            if ($version.webSocketDebuggerUrl) {
                $cdpOk = $true
                break
            }
        }
        catch {
        }

        Start-Sleep -Milliseconds 250
    }
    while ([DateTime]::UtcNow -lt $deadline)

    if (-not $cdpOk) {
        throw "Same-profile Chrome restart failed"
    }

    Write-Host "CDP_RESTART=OK"
    Write-Host "BROWSER=$($version.Browser)"
    Write-Host ""
    Write-Host "Same Chrome profile reopened."
    Write-Host "Wait until X Home/profile is fully loaded."
    Write-Host ""

    Read-Host "Then press ENTER again"
}

$js = @"
const { chromium } = require("playwright");

(async () => {
    const port = process.argv[2];
    const statePath = process.argv[3];

    const endpoint =
        "http" + "://127.0.0.1:" + port;

    const browser =
        await chromium.connectOverCDP(endpoint);

    const contexts = browser.contexts();

    if (!contexts.length) {
        throw new Error("No Chrome context found");
    }

    const context = contexts[0];
    const cookies = await context.cookies();

    const names = new Set(
        cookies.map(c => c.name)
    );

    console.log(
        "HAS_AUTH_TOKEN=" +
        names.has("auth_token")
    );

    console.log(
        "HAS_CT0=" +
        names.has("ct0")
    );

    if (
        !names.has("auth_token") ||
        !names.has("ct0")
    ) {
        throw new Error(
            "X login is incomplete: auth_token/ct0 missing"
        );
    }

    await context.storageState({
        path: statePath
    });

    console.log("STATE_SAVED=YES");

    await browser.close();
})().catch(err => {
    console.error("ERROR=" + err.message);
    process.exit(1);
});
"@

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    $captureScript,
    $js,
    $utf8
)

Write-Host ""
Write-Host "=== CAPTURE SESSION ==="

node $captureScript $port $state

if ($LASTEXITCODE -ne 0) {
    throw "Browser session capture failed"
}

$d = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
$names = $d.cookies.name

if (
    -not ($names -contains "auth_token") -or
    -not ($names -contains "ct0")
) {
    throw "Saved session is missing auth_token/ct0"
}

Write-Host "STATE_OK=YES"
Write-Host "HAS_AUTH_TOKEN=YES"
Write-Host "HAS_CT0=YES"

$containerState = "/app/data/x-auth/sessions/$safe-storage-state.json"

docker exec $Container python3 -c "import json; d=json.load(open('$containerState',encoding='utf-8')); n={c.get('name','') for c in d.get('cookies',[])}; assert 'auth_token' in n and 'ct0' in n; print('CONTAINER_STATE_OK=YES')"

if ($LASTEXITCODE -ne 0) {
    throw "Container cannot read captured state"
}

Write-Host ""
Write-Host "=== IMPORT INTO PERSISTENT POOL ==="
# Explicit re-auth uses add_account_cookies UPSERT; do not delete first.
$importPy = @"
import asyncio
import json
from twscrape import API

DB = "$Db"
STATE = "$containerState"
USERNAME = "$Username"

async def main():
    with open(STATE, "r", encoding="utf-8") as f:
        state = json.load(f)

    cookies = state.get("cookies") or []

    names = {
        str(c.get("name", ""))
        for c in cookies
        if isinstance(c, dict)
    }

    if "auth_token" not in names or "ct0" not in names:
        raise RuntimeError("required cookies missing")

    # X_IDENTITY_DUP_GUARD_V10_36
    import sqlite3
    import urllib.parse

    def cookie_value(items, wanted):
        for item in items:
            if (
                isinstance(item, dict)
                and str(item.get("name", "")) == wanted
            ):
                return str(item.get("value", "") or "")
        return ""

    incoming_twid = cookie_value(cookies, "twid")

    if not incoming_twid:
        raise RuntimeError(
            "twid missing from captured X session"
        )

    incoming_twid = urllib.parse.unquote(incoming_twid)

    sql = sqlite3.connect(DB)

    try:
        existing_rows = sql.execute(
            "SELECT username, cookies FROM accounts"
        ).fetchall()
    finally:
        sql.close()

    duplicate_username = None

    for existing_username, existing_raw in existing_rows:
        # Re-auth of the SAME pool account is allowed.
        if existing_username == USERNAME:
            continue

        try:
            existing_cookies = json.loads(
                existing_raw or "[]"
            )

            if isinstance(existing_cookies, dict):
                existing_cookies = [
                    {
                        "name": k,
                        "value": v,
                    }
                    for k, v in existing_cookies.items()
                ]

            existing_twid = cookie_value(
                existing_cookies,
                "twid",
            )

            if (
                existing_twid
                and urllib.parse.unquote(existing_twid)
                == incoming_twid
            ):
                duplicate_username = existing_username
                break

        except Exception:
            continue

    if duplicate_username:
        print("DUPLICATE_X_IDENTITY=YES")
        print(
            "EXISTING_ACCOUNT="
            + duplicate_username
        )
        print("IMPORT_BLOCKED=YES")

        raise RuntimeError(
            "same X account already exists "
            "under another pool username"
        )

    print("DUPLICATE_X_IDENTITY=NO")

    api = API(DB)

    await api.pool.add_account_cookies(
        USERNAME,
        json.dumps(
            cookies,
            separators=(",", ":")
        )
    )

    a = await api.pool.get_account(USERNAME)

    if a is None:
        raise RuntimeError("account not created")

    print("ACCOUNT=" + a.username)
    print("ACTIVE=" + ("YES" if a.active else "NO"))
    print("LOGIN_METHOD=" + str(a.login_method))
    print("HAS_SESSION=" + ("YES" if a.has_session else "NO"))

asyncio.run(main())
"@

$importPy | docker exec -i $Container python3 -

if ($LASTEXITCODE -ne 0) {
    throw "Persistent pool import failed"
}

Write-Host ""
Write-Host "=== ISOLATED SEARCHTIMELINE TEST ==="

$testDb = "/tmp/x-pool-test-$safe.db"

$backupPy = @"
import sqlite3
import os

src = "$Db"
dst = "$testDb"

if os.path.exists(dst):
    os.remove(dst)

source = sqlite3.connect(src)
target = sqlite3.connect(dst)

source.backup(target)

target.close()
source.close()
"@

$backupPy | docker exec -i $Container python3 -

$keepPy = @"
import sqlite3

db = "$testDb"
keep = "$Username"

con = sqlite3.connect(db)

con.execute(
    "DELETE FROM accounts WHERE username <> ?",
    (keep,)
)

con.commit()
con.close()
"@

$keepPy | docker exec -i $Container python3 -

$searchPy = @"
import asyncio
from twscrape import API

async def main():
    api = API("$testDb")

    count = 0

    async for tweet in api.search(
        "solana",
        limit=2
    ):
        count += 1

        if count >= 2:
            break

    print("RESULT_COUNT=" + str(count))

    if count < 1:
        raise RuntimeError(
            "SearchTimeline returned no results"
        )

    print("SEARCHTIMELINE_OK=YES")

asyncio.run(main())
"@

$searchPy | docker exec -i $Container python3 -

$smokeExit = $LASTEXITCODE

docker exec -u 0 $Container rm -f `
    $testDb `
    "$testDb-wal" `
    "$testDb-shm"

if ($smokeExit -eq 0) {
    Write-Host "SMOKE_TEST=OK"
} else {
    Write-Host "SMOKE_TEST=FAILED"
}

if (Test-Path $captureScript) {
    [System.IO.File]::Delete($captureScript)
}

Write-Host ""
Write-Host "=== PERSISTENT X POOL ==="

docker exec $Container twscrape `
    --db $Db `
    accounts

Write-Host ""
Write-Host "POOL_ADD_COMPLETE=YES"
