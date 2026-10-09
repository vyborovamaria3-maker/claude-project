#!/bin/bash
# Automated Integration Verification Script

echo "🔍 X Collector Integration Verification"
echo "========================================"
echo ""

# Define paths
PROJECT_DIR="C:/Users/Рафаил/claude-project/solana-launcher"
X_COLLECTOR_DIR="$PROJECT_DIR/../x-collector"
X_COLLECTOR_TSDIR="$PROJECT_DIR/app/api/integrations/x-collector"

echo "1️⃣ Checking directory structure"
echo "-------------------------------"
for dir in "app/api/integrations/x-collector" "app/settings" "lib"; do
    if [ -d "$PROJECT_DIR/$dir" ]; then
        echo "✅ $dir exists"
    else
        echo "❌ $dir missing"
    fi
done
echo ""

echo "2️⃣ Checking critical files"
echo "------------------------"
for file in \
    "app/settings/XCollectorTab.tsx" \
    "app/api/integrations/x-collector/route.ts" \
    "lib/xcollector.ts" \
    "app/settings/page.tsx" \
    "lib/i18n/messages/en.json" \
    "lib/i18n/messages/ru.json"
do
    if [ -f "$PROJECT_DIR/$file" ]; then
        size=$(stat -s "$PROJECT_DIR/$file" | wc -l)
        echo "✅ $file ($size bytes)"
    else
        echo "❌ $file missing"
    fi
done
echo ""

echo "3️⃣ Verifying i18n keys"
echo "--------------------"
grep -q "settings.tab.xCollector" "$PROJECT_DIR/lib/i18n/messages/en.json" && echo "✅ settings.tab.xCollector in en.json" || echo "❌ Missing in en.json"
grep -q "settings.tab.xCollector" "$PROJECT_DIR/lib/i18n/messages/ru.json" && echo "✅ settings.tab.xCollector in ru.json" || echo "❌ Missing in ru.json"
echo ""

echo "4️⃣ Checking TypeScript imports"
echo "----------------------------"
cd "$PROJECT_DIR"
grep -q "useQuery" "app/settings/XCollectorTab.tsx" && echo "✅ useQuery imported" || echo "❌ useQuery missing"
grep -q "useCachedValue" "app/settings/XCollectorTab.tsx" && echo "✅ useCachedValue imported" || echo "❌ useCachedValue missing"
grep -q "dotenv" "app/api/integrations/x-collector/route.ts" && echo "✅ dotenv imported" || echo "❌ dotenv missing"
grep -q "Pool" "app/api/integrations/x-collector/route.ts" && echo "✅ Pool imported" || echo "❌ Pool missing"
echo ""

echo "5️⃣ Validating API contracts"
echo "---------------------------"
grep -q "export async function GET" "app/api/integrations/x-collector/route.ts" && echo "✅ GET endpoint exists" || echo "❌ GET missing"
grep -q "export async function POST" "app/api/integrations/x-collector/route.ts" && echo "✅ POST endpoint exists" || echo "❌ POST missing"
grep -q "runXCollectorAction" "app/api/integrations/x-collector/route.ts" && echo "✅ runXCollectorAction called" || echo "❌ action not called"
echo ""

echo "6️⃣ Checking module click handlers"
echo "--------------------------------"
grep -q "handleModuleClick" "app/settings/XCollectorTab.tsx" && echo "✅ handleModuleClick defined" || echo "❌ handler missing"
grep -q "id=.overview" "app/settings/XCollectorTab.tsx" && echo "✅ Overview section has id" || echo "❌ Sections missing ids"
grep -q "window.location.href" "app/settings/XCollectorTab.tsx" && echo "✅ Anchor navigation implemented" || echo "❌ Navigation missing"
echo ""

echo "7️⃣ Checking process lifecycle"
echo "----------------------------"
grep -q "spawnXProcess" "lib/xcollector.ts" && echo "✅ spawnXProcess function" || echo "❌ spawn missing"
grep -q "stopXProcess" "lib/xcollector.ts" && echo "✅ stopXProcess function" || echo "❌ stop missing"
grep -q "cleanupManagedProcesses" "lib/xcollector.ts" && echo "✅ cleanup function present" || echo "❌ cleanup missing"
echo ""

echo "8️⃣ Checking error handling"
echo "--------------------------"
grep -q "actionError" "app/settings/XCollectorTab.tsx" && echo "✅ Action errors tracked" || echo "❌ No error state"
grep -q "isPending" "app/settings/XCollectorTab.tsx" && echo "✅ Loading state used" || echo "❌ Loading missing"
grep -q "try.*catch" "app/settings/XCollectorTab.tsx" && echo "✅ Error catch implemented" || echo "❌ No catch"
echo ""

echo "9️⃣ Checking env configuration"
echo "-----------------------------"
grep -q "DATABASE_URL" "lib/xcollector.ts" && echo "✅ DATABASE_URL check" || echo "❌ Missing"
grep -q "MASTER_KEY" "lib/xcollector.ts" && echo "✅ MASTER_KEY check" || echo "❌ Missing"
grep -q "REQUIRED_MIGRATIONS" "lib/xcollector.ts" && echo "✅ Migration checks" || echo "❌ Migration checks missing"
echo ""

echo "🔟 Examining git status"
echo "----------------------"
git --git-dir="$PROJECT_DIR/.git" --work-tree="$PROJECT_DIR" status --porcelain | head -20
echo ""

echo "✅ Verification Complete"
echo "========================"
