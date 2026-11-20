# Memecoin Intelligence v3.3.0

Standalone macro-analysis platform for Solana memecoins, prepared for high-volume ingestion, account-network analysis and an optional local Telegram AI layer.

## Stack

- React + Vite + TanStack Query
- Fastify REST API
- PostgreSQL 16 with partitioned event tables and precomputed features
- Redis result cache
- BullMQ analysis workers
- fixture providers for free deterministic tests
- optional X data providers
- optional local `Qwen/Qwen2.5-7B-Instruct` inference service for Telegram only
- Docker Compose

## Local start

```bash
cp .env.example .env
docker compose up -d postgres redis
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

For asynchronous analysis also run:

```bash
npm run dev:worker
```

## Production Compose and database roles

Production Compose uses separate PostgreSQL identities: bootstrap for initialization/provisioning, `memecoin_migrator` for one-shot schema migrations, `memecoin_app` for API/worker DML, and `memecoin_readonly` for Admin inspection.

For a **new empty database**, configure the role passwords in `.env`, ensure the shared external Docker network `potapoff_default` exists, then run:

```bash
docker compose -f docker-compose.production.yml --profile migrate run --rm migrator
docker compose -f docker-compose.production.yml up -d
```

The API and worker never connect as `POSTGRES_USER`. For existing persistent volumes, do not run the migration profile until object ownership has been inventoried and the backup/restore and forward/rollback rehearsal is approved. Follow [the role cutover runbook](../docs/operations/MEMECOIN_SOLSUB_DB_ROLE_CUTOVER.md).

## Free testing

Keep `DATA_PROVIDER=fixture`. No X account, browser cookie or paid API is required.

```bash
npm test
npm run benchmark:small
```

The included X fixture contract is:

```text
3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump
```

## Telegram AI

The AI module is disabled by default and cannot be called by the X analysis pipeline.

Free deterministic test:

```env
TELEGRAM_AI_ENABLED=true
TELEGRAM_AI_MODE=mock
```

```bash
npm run db:migrate
npm run test:telegram-ai
```

Local Qwen service on a CUDA-capable machine:

```env
TELEGRAM_AI_ENABLED=true
TELEGRAM_AI_MODE=openai-compatible
QWEN_LOAD_MODE=4bit
```

```bash
docker compose --profile ai up -d postgres redis qwen
npm run db:migrate
npm run dev
npm run dev:worker
```

The model downloads into the persistent `hf_cache` volume on first inference. Weights are not included in the project archive.

See `docs/TELEGRAM_QWEN_AI.md` for the API, output schema, GPU/CPU options and database design.

## Performance tests

```bash
npm run benchmark:small
npm run benchmark:medium
```

See:

- `docs/PERFORMANCE_ENGINE.md`
- `docs/DATABASE_INTEGRATION.md`
- `docs/TELEGRAM_QWEN_AI.md`
