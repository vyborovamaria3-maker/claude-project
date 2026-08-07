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
