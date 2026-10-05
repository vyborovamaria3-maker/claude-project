# POTAPoff Social + AI Backtest / Repair v2

Scope: `/trade/analysis` Telegram, X/Twitter, source-specific AI, runtime source health, and GMGN regression safety.

## Root causes found

1. **Source UI was blocked by the slow AI/on-chain phase.** `SocialIntelligencePanel` used one global loading state and waited for the chain stream before releasing Telegram/X rendering. A working Telegram/X HTTP response could therefore look like a dead/empty UI.
2. **X production runtime lacked the browser path.** The frontend image did not install Chromium and did not mount `data/x-auth/storage-state.json`, so `auto` fell back to public Nitter and returned zero posts when Nitter had no result.
3. **X collection order was fragile.** `auto` tried public collection instead of preferring an authenticated browser session. It now prefers authenticated Playwright and uses Nitter only as fallback.
4. **Telegram HTTP 200 did not prove ingestion was active.** The backend proxy/auth path worked, but collector session/public-web runtime inputs were not fully forwarded by Compose. Public-web collection is now enabled by default in Compose and Telegram collector state is shown in the UI.
5. **Telegram restart/bootstrap could remain empty.** Public-web refresh previously required explicit configured seeds/registry state. It can now bootstrap from Telegram channels already stored in the database.
6. **Short lookback created false-empty social tabs.** The default lookback is widened to 168h and an empty scoped result retries once without the `hours` restriction.
7. **Suspicious X posts were hidden by default.** They are now retained as evidence and risk-tagged instead of silently removed.
8. **AI could hide real source data.** Source loading and AI loading are now separate. Telegram/X data renders as soon as the source response is ready while AI continues independently.
9. **Source-specific AI could be misleading.** Telegram/X/Blockchain source tabs no longer substitute a generic cross-source summary when the provider did not return a source-specific assessment.
10. **No unified runtime diagnostics existed.** Added `/api/trade/source-health` plus a live PowerShell backtest that checks X auth/browser, Telegram collector, AI provider reachability/inference, six tabs, and GMGN regression.

## Files changed

- `Dockerfile.frontend.prod`
- `docker-compose.yml`
- `lib/trade/twitter-scraper.ts`
- `lib/trade/social-intelligence.ts`
- `components/trade/SocialIntelligencePanel.tsx`
- `backend/app/services/telegram_runtime.py`
- `app/api/trade/source-health/route.ts` (new)
- `scripts/social-ai-regression.mjs` (new)
- `scripts/social-ai-live-backtest.ps1` (new)
- `package.json`

## Offline/static backtest executed against the supplied running-project snapshot

PASS:

- `node scripts/analysis-regression.mjs`
- `node scripts/live-intelligence-regression.mjs`
- `node scripts/social-ai-regression.mjs`
- `package.json` JSON parse
- `python3 -m py_compile backend/app/services/telegram_runtime.py`
- TypeScript parser/transpile syntax check for all changed TS/TSX files
- Compose YAML parse

The final production Docker build and live provider tests must run on the Windows host because this analysis container does not have the user's Docker daemon or authenticated external sessions.

## Live backtest behavior

Run `scripts/social-ai-live-backtest.ps1` after rebuilding/recreating the containers. It writes a safe report to:

`data/social-ai-backtest-report.json`

It does not print API keys or session contents.

A `WARN` for zero token matches is not automatically a transport failure. A `FAIL` means a required runtime/provider path is broken and should be fixed before considering Social/AI healthy.
