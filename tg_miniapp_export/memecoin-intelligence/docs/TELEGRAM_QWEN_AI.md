# Telegram AI with Qwen2.5-7B-Instruct

## Scope boundary

This module is intentionally limited to Telegram data. It is not called by the X/Twitter provider, token lookup, X mention analysis, or X account graph.

The model is used for a second-stage interpretation after deterministic extraction has already identified contracts, tickers, links and message timing. AI output is treated as a hypothesis with evidence IDs, not as proof of ownership, payment, fraud or common control.

## Modes

### Free mock mode

Use this mode for development, tests and database integration. It needs no GPU, no model download and no paid API.

```env
TELEGRAM_AI_ENABLED=true
TELEGRAM_AI_MODE=mock
```

Run:

```bash
npm run db:migrate
npm run test:telegram-ai
npm run dev
npm run dev:worker
```

The fixture is `fixtures/telegram-messages.json`.

### Local Qwen mode

The included Python service exposes an OpenAI-compatible endpoint and loads `Qwen/Qwen2.5-7B-Instruct` with Transformers. The default `4bit` mode uses bitsandbytes NF4 and is intended for a CUDA-capable NVIDIA GPU.
The shipped defaults cap input at 8,192 tokens, output at 1,200 application tokens and inference concurrency at one to reduce KV-cache and runtime overhead on an 8 GB-class GPU. Actual memory use still depends on the CUDA stack, model revision and prompt length.

```env
TELEGRAM_AI_ENABLED=true
TELEGRAM_AI_MODE=openai-compatible
TELEGRAM_AI_MODEL=Qwen/Qwen2.5-7B-Instruct
QWEN_LOAD_MODE=4bit
```

Start infrastructure and the model:

```bash
docker compose --profile ai up -d postgres redis qwen
npm run db:migrate
npm run dev
npm run dev:worker
```

The first request downloads the model to the persistent `hf_cache` Docker volume. Model weights are not stored in this repository.

Check status:

```bash
curl http://localhost:8000/health
curl http://localhost:3001/api/telegram-ai/status
```

### CPU-only machines

The included Transformers service intentionally refuses `4bit` mode without CUDA, because that path is not a reliable low-memory CPU configuration. Keep `TELEGRAM_AI_MODE=mock` for free development, or run a Qwen2.5-compatible GGUF through llama.cpp/Ollama and set:

```env
TELEGRAM_AI_MODE=openai-compatible
TELEGRAM_AI_BASE_URL=http://localhost:YOUR_PORT/v1
TELEGRAM_AI_MODEL=your-local-qwen-model-name
```

The Node application only requires an OpenAI-compatible `/v1/chat/completions` endpoint.

## API

### Status

```http
GET /api/telegram-ai/status
```

### Synchronous analysis

```http
POST /api/telegram-ai/analyze
Content-Type: application/json

{
  "messages": [...],
  "context": {
    "tokenAddress": "...",
    "symbol": "TEST"
  },
  "persist": false
}
```

### Queued analysis

```http
POST /api/telegram-ai/enqueue
```

The payload is stored in PostgreSQL and only a `runId` is sent through BullMQ. This avoids sending large Telegram batches through Redis.

Read a queued result:

```http
POST /api/telegram-ai/job

{ "runId": "uuid" }
```

## Output contract

The model must return strict JSON validated by Zod. It includes:

- sentiment and dominant intent;
- tokens, contracts, channels, accounts and links;
- claims with verification status;
- account/channel relationships;
- coordination signals;
- campaign hypothesis and likely originators/amplifiers;
- risks and evidence message IDs;
- a short `reasoningSummary` containing conclusions only, never private chain-of-thought.

Invalid JSON or schema violations fail the job instead of silently storing malformed analysis.

## Database portability

Migration `db/migrations/004_telegram_qwen_ai.sql` is additive. It creates partitioned Telegram messages, deterministic features, AI runs, run-message links, results and cache metadata. It can be copied into another PostgreSQL project independently of the frontend.

## Operational limits

Tune these values before production:

```env
TELEGRAM_AI_MAX_MESSAGES=60
TELEGRAM_AI_MAX_CHARS=24000
TELEGRAM_AI_MAX_TOKENS=1200
TELEGRAM_AI_WORKER_CONCURRENCY=1
```

A 7B model should normally use one inference worker per GPU. Scale ingestion and deterministic analysis independently from model inference.

## Inference endpoint protection

For production, set the same random secret in `TELEGRAM_AI_API_KEY` for the Node application and `QWEN_SERVICE_API_KEY` for the Python service. Docker Compose maps them automatically. The model port is bound to `127.0.0.1` by default.
