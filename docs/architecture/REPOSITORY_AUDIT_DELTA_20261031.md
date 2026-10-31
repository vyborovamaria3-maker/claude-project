# Repository audit delta — 2026-10-31

This document records corrections and clarifications verified against the
repository snapshot below. It is a code/GitHub metadata review, not a production
deployment certification.

## Snapshot

- Observed `main`: `9f4a7e88afa80774633ee4a43221a621fe5f1922`.
- Recursive Git tree: 4,791 entries = 4,065 file blobs + 725 tree entries +
  one submodule entry; the tree response was not truncated.
- Workflow definitions under `.github/workflows`: 38.
- GitHub branch metadata reported `main.protected=false`; no repository rulesets
  were returned by the available API read.
- PRs #204, #205, #206 and #207 were open at the time of this snapshot. #204 was
  draft; #205–#207 were not merged. Recheck GitHub before acting on any PR.

## Verified corrections and boundaries

### Admin Control Center entrypoint

The Dockerfile runs `admin-site/scripts/run_admin.py`. That script starts
`uvicorn app.main_admin:app`. `app.main_admin` imports
`app.main.create_app` as its base factory and adds the production/admin routers,
including X Collector. Therefore:

- `admin-site/app/main.py` is the base application factory;
- `admin-site/app/main_admin.py` is the application entrypoint used by the
  container;
- `admin-site/scripts/run_admin.py` is the process launcher.

Do not describe `app.main:app` as the container entrypoint.

### Two AI gateway locations

`packages/ai-gateway` and `intelligence/ai-gateway` are separate paths with
different ownership and integration context. The existence of one does not imply
the other is absent, nor does either path alone prove that every product uses it.
Keep package-level shared code distinct from the Intelligence runtime's gateway.

### Two X outbox families

The legacy `x-collector` table `outbox` and the cross-source
`outbox_events` pipeline are separate delivery mechanisms. For example,
`x-collector/scripts/outbox-publisher.ts` serves the legacy notification/
publishing queue, while the Intelligence source persistence code emits the
cross-source event contract. Do not treat them as one queue or assume that the
legacy publisher delivers events to Node Intelligence.

### Telegram MiniApp is not one deployable backend

The repository contains multiple related but distinct implementations:

- The user-facing POTAPoff Mini App page and its `/api/miniapp/create-invoice`
  and `/api/miniapp/verify-payment` routes live in `solana-launcher`.
- The Node Telegram bot lives in `telegram-miniapp/bot` and opens the URL
  configured by `WEBAPP_URL`.
- `telegram-miniapp/frontend` is a separate Vite prototype. Its current
  `App.tsx` calls the `/api/miniapp/*` routes on the same origin; the Vite
  config does not provide a proxy to the Next.js API. It is not the canonical
  deployed page by itself.
- `telegram-miniapp/backend-new` is a separate Express/Prisma experiment with
  `/api/subscription/*` endpoints. Its Prisma schema explicitly uses SQLite,
  not PostgreSQL. It is not the API implementation used by the Vite
  `App.tsx` or by the `solana-launcher/app/miniapp/page.tsx` flow.
- The old `telegram-miniapp/backend` Python path referenced by legacy scripts
  and documentation is absent from the current tree.
- The standalone `PayButton` and `useSubscription` components are not imported
  by the current Vite `App.tsx`; their request shape also does not match the
  Express controller's Telegram `initData` authentication contract.

Do not merge these variants or claim a single end-to-end payment flow without
choosing and testing one architecture.

### X Collector editor mutation scope

The X Collector explorer may read the dedicated database, but broad table writes
are not appropriate for an operational console. The implementation in this
change restricts mutations to an explicit application allowlist on
`public.feature_flags`: INSERT and UPDATE only, with a column-level allowlist;
DELETE and all other table mutations are denied. See
[the editor policy](../../admin-site/X_COLLECTOR_EDITOR_POLICY.md).

This does not prove that the configured PostgreSQL role has least-privilege
grants. An operator must separately verify role memberships, inherited grants
and effective table privileges before enabling the editor against a live DB.

## Verification boundaries

The snapshot and code review did not connect to production databases, change
database grants, run migrations, rotate credentials, use real X/TG sessions,
call paid RPC providers, deploy services, restore backups or change GitHub
branch protection. CI success is evidence only for the commit and checks that
actually ran. Keep live source validation, backup/restore, secret rotation,
branch governance and production deployment as separate operator gates.
