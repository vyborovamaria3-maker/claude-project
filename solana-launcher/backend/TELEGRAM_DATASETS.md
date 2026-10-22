# Telegram Collector: public dataset integration

The integration stages public channel metadata in the existing telegram_channels registry. The
existing public-web collector then fetches public previews, evaluates actual messages for
Solana/memecoin relevance, and stores matching messages through the current message pipeline.
Dataset rows are candidates, not trusted signals.

## Sources enabled by TG_PUBLIC_WEB_ENABLED=true

- **tgAtlas public Telegram channel snapshot (2026-W36)** — channels.csv plus the public
  recommendation graph. The sync keeps TG_DATASET_SYNC_TOPICS (default crypto,finance) and stages
  up to TG_DATASET_SYNC_MAX_CHANNELS rows per sync. License: CC BY 4.0; provenance and attribution
  are stored on each channel. This is a snapshot from 2026-08-31, not a live feed.
- **SmugCalls Solana memecoin calls** — stages the public SmugCalls channel as a seed. The linked
  historical call dataset is CC0; it is not treated as proof that a token is safe or profitable.
- **TGDataset (120,979 public channels)** — supported as a local import only. The archive is about
  71 GB compressed, so it is never downloaded automatically. The local importer streams large JSON
  files and extracts channel metadata without loading the nested message archive into memory.
- **tgparser JSON/CSV archives** — the existing telegram_import_tgparser command remains the path
  for importing archived messages for a channel already in the database. Dataset metadata import
  does not copy hundreds of millions of historical messages into production.

Restricted datasets and datasets that do not contain channel/message sources are not silently
mirrored. In particular, this integration does not download restricted TeraGram data or treat a
Telegram bot/tool directory as a channel list.

## Automatic sync

When public-web collection is enabled, the runtime syncs the small public metadata sources on
startup and then at TG_DATASET_SYNC_INTERVAL_SECONDS (default 86400 seconds). Failed remote sources
are retried after approximately one hour. Dataset candidates enter the same due registry as
graph-discovered channels, and TG_PUBLIC_WEB_REFRESH_BATCH_SIZE limits work per refresh. Existing
relevance filtering and retry/backoff rules still apply. If MTProto is actively monitoring, metadata
sync still runs but the public-web candidate queue waits until public-web collection is active; the
runtime does not run both collectors concurrently for the same workload.

Example environment settings:

    TG_PUBLIC_WEB_ENABLED=true
    TG_DATASET_SYNC_ENABLED=true
    TG_DATASET_SYNC_INTERVAL_SECONDS=86400
    TG_DATASET_SYNC_MAX_CHANNELS=1000
    TG_DATASET_SYNC_TOPICS=crypto,finance
    TG_PUBLIC_WEB_REFRESH_BATCH_SIZE=25

## Import an already-downloaded TGDataset or another CSV/JSON source

Run from solana-launcher/backend:

    python -m app.cli.telegram_import_datasets sync-public
    python -m app.cli.telegram_import_datasets import-local data/tgdataset --limit 1000
    python -m app.cli.telegram_import_datasets import-local data/tgdataset --limit 0 --dry-run

The limit defaults to 1000. A limit of 0 scans all local records and may take a long time for the
full TGDataset archive. The importer skips scam-marked channels, normalizes usernames and t.me URLs,
deduplicates by username, records source/license/topic/verification metadata, and marks new
candidates as due for normal public-web validation. It does not bypass Telegram access controls or
import private chats.

## Operational notes

- Public metadata may be stale or inaccurate; the collector verifies current posts before accepting
  a channel. A dataset verified flag is provenance, not a guarantee of legitimacy.
- Provenance is stored in TelegramChannel.meta.dataset_sources and
  TelegramChannel.meta.dataset_provenance; topic labels are stored in dataset_tags.
- The same channel can appear in multiple sources without creating duplicate registry rows.
- For public historical message archives, use the existing bounded telegram_import_tgparser
  command after selecting the matching channel. Do not ingest an entire multi-terabyte corpus into
  the production message table without an explicit retention/storage plan.
