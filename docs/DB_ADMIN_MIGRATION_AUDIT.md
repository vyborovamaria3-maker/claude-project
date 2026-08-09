# Database tab migration audit

Status: preparation branch only. Do not deploy until server source configuration is verified.

## Intended end state

- `solana-launcher` has no visible Database navigation.
- Legacy `/database` and `/database/wallets` URLs are compatibility redirects to `https://admin.potapoff.fun/#database` only.
- Public Next.js `/api/database/*` endpoints are removed.
- Database browsing/analytics are available only from the authenticated `admin-site` application.
- Product data sources remain read-only from the admin container.
- No product DB credentials are committed to Git; production `admin-site/sources.json` stays server-local.

## Existing admin capabilities

The admin console already provides authenticated read-only source/table APIs, search, sorting, pagination, CSV export, source health, combined users, blockchain datasets, Telegram datasets, X/Twitter datasets, global search and audit logging. The `database-migrated-v8.js` UI is loaded by the admin console and deep-links from legacy routes to `#database`.

## Remaining migration work

1. Remove Database entries from `solana-launcher/lib/siteDesign.ts` and simplify `SidebarNav.tsx` so hiding is structural, not a runtime filter.
2. Remove public `solana-launcher/app/api/database/*` route handlers.
3. Remove dead legacy Database React components and data aggregation modules after import checks.
4. Verify the production admin `sources.json` exposes the launcher analytics SQLite source and production PostgreSQL sources using read-only credentials.
5. Port any legacy-only aggregate views that are still desired (migration rollups, smart-wallet scoring, dev forensics, integrity/FK summary) into authenticated admin endpoints instead of exposing them on the product frontend.
6. Rebuild/deploy `admin-site` and `solana-launcher` directly on the VPS; GitHub Actions are not required.

## Security invariant

Admin data access must remain read-only. Do not move mutation/maintenance scripts such as merge/import tools into a browser-accessible admin endpoint unless they are explicitly designed with separate authorization and audit controls.
