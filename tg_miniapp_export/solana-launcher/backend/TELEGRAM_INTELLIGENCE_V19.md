# Telegram Intelligence v19

This module integrates the v18 Telegram crawler into the existing `solana-launcher` FastAPI/PostgreSQL backend.

## What changed from v18

v18 used a standalone SQLite database. v19 keeps the Telethon/MTProto idea and Solana parser, but stores intelligence in the main SQLAlchemy database and adds realtime monitoring, sender identity, call outcomes, channel/caller scoring and a shared Telegram/X event timeline.

The crawler also reads channel descriptions, follows explicit `t.me` links, detects Telegram-linked discussion chats and stores TG↔TG/X graph edges with chronological first/last-seen timestamps.

## Telegram user session

Telegram Intelligence uses a **user MTProto session**, not `TELEGRAM_BOT_TOKEN`.

Configure:

```env
TG_API_ID=123456
TG_API_HASH=...
TG_SESSION_STRING=...
TG_MONITOR_CHANNELS=channel_one,channel_two
TG_AUTOSTART=false
TG_HISTORY_LIMIT=300
TG_GRAPH_DEPTH=1
TG_ENTITY_LIMIT=100
TG_EVALUATE_INTERVAL_SECONDS=300
```

Generate a StringSession locally from `solana-launcher/backend`:

```bash
python -m app.cli.telegram_login
```

The generated `TG_SESSION_STRING` is equivalent to an active Telegram login. Keep it secret, never commit it, and revoke the Telegram session if it leaks.

`TG_SESSION_PATH` is supported for local development, but `TG_SESSION_STRING` is preferred in containers because it survives container replacement without mounting the Telethon session file.

## API

Read endpoints:

- `GET /api/v1/telegram/channels`
- `GET /api/v1/telegram/calls`
- `GET /api/v1/telegram/token/{mint}`
- `GET /api/v1/telegram/top-callers`
- `GET /api/v1/social/token/{mint}` — combined Telegram + X timeline
- `GET /api/v1/social/relations` — Telegram/Twitter discovery graph

Admin endpoints (normal POTAPoff superuser JWT required):

- `GET /api/v1/telegram/session/status`
- `GET /api/v1/telegram/monitor/status`
- `POST /api/v1/telegram/scan`
- `POST /api/v1/telegram/monitor/start`
- `POST /api/v1/telegram/monitor/stop`
- `POST /api/v1/telegram/calls/evaluate`
- `POST /api/v1/social/x/refresh/{mint}`
- `POST /api/v1/telegram/session/login` — attaches an already-authorized StringSession to the running process; it does not perform phone/SMS login.

Internal endpoint:

- `POST /api/v1/social/x/ingest` with `X-Backend-API-Key` equal to `BACKEND_API_KEY`.
- `token_mint` is required and validated as a real 32-byte Base58 Solana address.

## Historical crawling

Example request:

```json
POST /api/v1/telegram/scan
{
  "seeds": ["pumpfun_calls", "solana_alpha"],
  "max_depth": 2,
  "post_limit": 300,
  "entity_limit": 100
}
```

The crawler resolves public channels/groups visible to the authorized account, saves message history, extracts valid 32-byte Base58 Solana addresses, `$TICKER`s, explicit `t.me` / X links and grows the Telegram discovery graph up to the requested depth.

Bare `@mentions` are stored as relations but are not automatically crawled. This prevents a busy chat from turning every mentioned user into a crawl job. Explicit `t.me` links and Telegram-linked discussion chats are eligible for graph expansion.

Historical rescans are idempotent for stored messages and do not inflate relation counts. Channel scoring is recalculated once at the end of a history scan instead of after every CA message.

## Realtime

`POST /api/v1/telegram/monitor/start` attaches a Telethon `NewMessage` handler to the requested channels/groups. New messages pass through the same parser/storage path as historical messages.

The in-process monitor is intentionally optional. `TG_AUTOSTART=true` starts `TG_MONITOR_CHANNELS` during FastAPI lifespan. If the Telegram session is expired, the backend still starts; Telegram monitoring remains disabled until the session is fixed.

### Recommended production worker

Production Compose contains a dedicated optional service named `telegram-intelligence`, using the same backend image but running:

```bash
python -m app.cli.telegram_monitor
```

Start it with the Compose profile:

```bash
docker compose -f docker-compose.production.yml --profile telegram-intelligence up -d telegram-intelligence
```

The worker:

1. scans `TG_MONITOR_CHANNELS` and the configured discovery graph;
2. loads recent history using `TG_HISTORY_LIMIT`;
3. follows explicit Telegram links/discussion chats up to `TG_GRAPH_DEPTH` / `TG_ENTITY_LIMIT`;
4. starts realtime monitoring for successfully discovered channels/groups;
5. periodically reevaluates pending call outcomes every `TG_EVALUATE_INTERVAL_SECONDS`.

When the dedicated worker is enabled, keep `TG_AUTOSTART=false` on the FastAPI service to avoid duplicate Telethon clients.

## Tables

- `telegram_channels`
- `telegram_users`
- `telegram_messages`
- `telegram_token_mentions`
- `telegram_calls`
- `telegram_channel_scores`
- `social_events`
- `social_relations`

`social_events` is the common timeline. Telegram token mentions are mirrored there, and X events can be refreshed from the existing `/api/trade/dev-twitter` analyzer or ingested internally.

## Calls and scores

A Solana address mention becomes a `telegram_call`; `is_explicit_call` distinguishes messages containing call-like language (`gem`, `entry`, `100x`, `ape`, etc.). The call evaluator correlates calls with existing `tokens` / `token_metrics` data:

- `win`: observed peak is at least 2x the call snapshot;
- `loss`: below 2x after at least six hours of observed metrics;
- `rug`: token status is `rugged`;
- otherwise `pending`.

Channel and caller scores combine sample confidence, win rate, average ROI, early-call ratio (market cap <= $50k) and a rug penalty. These scores are heuristics and should be calibrated against a historical labeled dataset before they are used as trading signals.

## Frontend

The Next.js page is available at:

```text
/telegram-intelligence
```

It is linked from the main trade sidebar and can scan channel graphs, start/stop in-process monitoring, evaluate calls, inspect channel/caller rankings, and query a combined Telegram/X token timeline. Mutating/control actions reuse the existing `potapoff.access_token` JWT stored by the current login flow.

## Security notes

- Never commit `TG_SESSION_STRING`, `.session` files, Telegram codes or 2FA passwords.
- `/session/login` accepts only an already-authorized session and never echoes it back.
- Telegram session/monitor status endpoints require a superuser JWT.
- Internal X ingestion is disabled unless `BACKEND_API_KEY` is configured.
- Crawling is limited to entities the configured Telegram account can legitimately access.
- The root `.gitignore` explicitly excludes Telethon `*.session` and `*.session-journal` files.
