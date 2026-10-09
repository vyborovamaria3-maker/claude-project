# X Collector Integration Verification Script
# Uses native PowerShell commands

$PROJECT_DIR = "C:\Users\Рафаил\claude-project\solana-launcher"
$XCOL_DIR = Join-Path $PROJECT_DIR "..x-collector"

Write-Host "`n🔍 X Collector Integration Verification" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "1️⃣ Checking directory structure" -ForegroundColor Yellow
Write-Host "-------------------------------" -ForegroundColor Yellow
$dirs = @("app/api/integrations/x-collector", "app/settings", "lib")
foreach ($dir in $dirs) {
    $path = Join-Path $PROJECT_DIR $dir
    if (Test-Path -Path $path -PathType Container) {
        Write-Host "✅ $dir exists" -ForegroundColor Green
    } else {
        Write-Host "❌ $dir missing" -ForegroundColor Red
    }
}
Write-Host ""

Write-Host "2️⃣ Checking critical files" -ForegroundColor Yellow
Write-Host "------------------------" -ForegroundColor Yellow
$files = @(
    "app/settings/XCollectorTab.tsx",
    "app/api/integrations/x-collector/route.ts",
    "lib/xcollector.ts",
    "app/settings/page.tsx",
    "lib/i18n/messages/en.json",
    "lib/i18n/messages/ru.json",
    "lib/client-cache.ts",
    "lib/react-query.ts"
)
foreach ($file in $files) {
    $path = Join-Path $PROJECT_DIR $file
    if (Test-Path -Path $path) {
        $size = (Get-Item -Path $path).Length
        Write-Host "✅ $file ($([math]::Round($size/1KB, 2)) KB)" -ForegroundColor Green
    } else {
        Write-Host "❌ $file missing" -ForegroundColor Red
    }
}
Write-Host ""

Write-Host "3️⃣ Verifying i18n keys" -ForegroundColor Yellow
Write-Host "--------------------" -ForegroundColor Yellow
$enContent = Get-Content (Join-Path $PROJECT_DIR "lib/i18n/messages/en.json") -Raw
$ruContent = Get-Content (Join-Path $PROJECT_DIR "lib/i18n/messages/ru.json") -Raw
if ($enContent -match 'settings\.tab\.xCollector') {
    Write-Host "✅ settings.tab.xCollector in en.json" -ForegroundColor Green
} else {
    Write-Host "❌ Missing in en.json" -ForegroundColor Red
}
if ($ruContent -match 'settings\.tab\.xCollector') {
    Write-Host "✅ settings.tab.xCollector in ru.json" -ForegroundColor Green
} else {
    Write-Host "❌ Missing in ru.json" -ForegroundColor Red
}
Write-Host ""

Write-Host "4️⃣ Checking TypeScript imports" -ForegroundColor Yellow
Write-Host "----------------------------" -ForegroundColor Yellow
$tabContent = Get-Content (Join-Path $PROJECT_DIR "app/settings/XCollectorTab.tsx") -Raw
$routeContent = Get-Content (Join-Path $PROJECT_DIR "app/api/integrations/x-collector/route.ts") -Raw

if ($tabContent -match 'useQuery') {
    Write-Host "✅ useQuery imported in XCollectorTab" -ForegroundColor Green
} else {
    Write-Host "❌ useQuery missing" -ForegroundColor Red
}
if ($tabContent -match 'useCachedValue|writeCachedValue') {
    Write-Host "✅ client-cache used" -ForegroundColor Green
} else {
    Write-Host "❌ client-cache missing" -ForegroundColor Red
}
if ($routeContent -match '^import.*dotenv') {
    Write-Host "✅ dotenv imported in route" -ForegroundColor Green
} else {
    Write-Host "❌ dotenv missing in route" -ForegroundColor Red
}
if ($routeContent -match 'new Pool\(') {
    Write-Host "✅ pg Pool initialized" -ForegroundColor Green
} else {
    Write-Host "❌ pg Pool missing" -ForegroundColor Red
}
Write-Host ""

Write-Host "5️⃣ Validating API contracts" -ForegroundColor Yellow
Write-Host "---------------------------" -ForegroundColor Yellow
if ($routeContent -match 'export async function GET') {
    Write-Host "✅ GET endpoint defined" -ForegroundColor Green
} else {
    Write-Host "❌ GET endpoint missing" -ForegroundColor Red
}
if ($routeContent -match 'export async function POST') {
    Write-Host "✅ POST endpoint defined" -ForegroundColor Green
} else {
    Write-Host "❌ POST endpoint missing" -ForegroundColor Red
}
if ($routeContent -match 'runXCollectorAction') {
    Write-Host "✅ runXCollectorAction called" -ForegroundColor Green
} else {
    Write-Host "❌ runXCollectorAction not called" -ForegroundColor Red
}
Write-Host ""

Write-Host "6️⃣ Checking module click handlers" -ForegroundColor Yellow
Write-Host "--------------------------------" -ForegroundColor Yellow
if ($tabContent -match 'handleModuleClick') {
    Write-Host "✅ handleModuleClick function defined" -ForegroundColor Green
} else {
    Write-Host "❌ handleModuleClick missing" -ForegroundColor Red
}
if ($tabContent -match 'id="overview"') {
    Write-Host "✅ Overview section has id" -ForegroundColor Green
} else {
    Write-Host "❌ Overview section missing id" -ForegroundColor Red
}
if ($tabContent -match 'handleModuleClick' -and $tabContent -match 'window\.location\.href') {
    Write-Host "✅ Anchor navigation implemented" -ForegroundColor Green
} else {
    Write-Host "❌ Anchor navigation missing" -ForegroundColor Red
}
Write-Host ""

Write-Host "7️⃣ Checking process lifecycle" -ForegroundColor Yellow
Write-Host "----------------------------" -ForegroundColor Yellow
$xcolContent = Get-Content (Join-Path $PROJECT_DIR "lib/xcollector.ts") -Raw
if ($xcolContent -match 'spawnXProcess') {
    Write-Host "✅ spawnXProcess function exists" -ForegroundColor Green
} else {
    Write-Host "❌ spawnXProcess missing" -ForegroundColor Red
}
if ($xcolContent -match 'stopXProcess') {
    Write-Host "✅ stopXProcess function exists" -ForegroundColor Green
} else {
    Write-Host "❌ stopXProcess missing" -ForegroundColor Red
}
if ($xcolContent -match 'cleanupManagedProcesses') {
    Write-Host "✅ cleanupManagedProcesses defined" -ForegroundColor Green
} else {
    Write-Host "❌ cleanupManagedProcesses missing" -ForegroundColor Red
}
Write-Host ""

Write-Host "8️⃣ Checking error handling" -ForegroundColor Yellow
Write-Host "--------------------------" -ForegroundColor Yellow
if ($tabContent -match 'actionError') {
    Write-Host "✅ Action error state exists" -ForegroundColor Green
} else {
    Write-Host "❌ Action error state missing" -ForegroundColor Red
}
if ($tabContent -match 'isPending') {
    Write-Host "✅ Loading state used" -ForegroundColor Green
} else {
    Write-Host "❌ Loading state missing" -ForegroundColor Red
}
if ($routeContent -match 'try' -and $routeContent -match 'catch') {
    Write-Host "✅ Try/catch error handling in route" -ForegroundColor Green
} else {
    Write-Host "❌ Error handling missing in route" -ForegroundColor Red
}
Write-Host ""

Write-Host "9️⃣ Checking env configuration" -ForegroundColor Yellow
Write-Host "-----------------------------" -ForegroundColor Yellow
if ($xcolContent -match 'DATABASE_URL') {
    Write-Host "✅ DATABASE_URL check exists" -ForegroundColor Green
} else {
    Write-Host "❌ DATABASE_URL check missing" -ForegroundColor Red
}
if ($xcolContent -match 'MASTER_KEY') {
    Write-Host "✅ MASTER_KEY check exists" -ForegroundColor Green
} else {
    Write-Host "❌ MASTER_KEY check missing" -ForegroundColor Red
}
if ($xcolContent -match 'REQUIRED_MIGRATIONS') {
    Write-Host "✅ Migration checks defined" -ForegroundColor Green
} else {
    Write-Host "❌ Migration checks missing" -ForegroundColor Red
}
Write-Host ""

Write-Host "🔟 Examining git history" -ForegroundColor Yellow
Write-Host "----------------------" -ForegroundColor Yellow
git --git-dir="$($PROJECT_DIR)\.git" --work-tree="$PROJECT_DIR" log --oneline -5
Write-Host ""

Write-Host "1️⃣1️⃣ Ready verification" -ForegroundColor Yellow
Write-Host "----------------------" -ForegroundColor Yellow
if (Test-Path "$($PROJECT_DIR)\.next") {
    Write-Host "✅ .next build directory exists" -ForegroundColor Green
} else {
    Write-Host "⚠️ .next not built yet (npm run build would run)" -ForegroundColor Yellow
}
if (Test-Path "$($PROJECT_DIR)\.next\static") {
    Write-Host "✅ Build artifacts present" -ForegroundColor Green
} else {
    Write-Host "⚠️ No build artifacts found" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "✅ Verification Complete" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan
