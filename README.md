# claude-project

This repository contains several experiments and product codebases related to Solana tooling, Telegram integrations, internal Codex skills, and deployment helpers.

## Primary deployment target

The cleanest production candidate in this repository is `solana-subscription-service`.

It already includes:

- a multi-app Node.js workspace
- Express API
- Next.js web app
- Telegram bot
- Prisma + PostgreSQL
- Redis for queues and session-related state
- Dockerfiles for API, web, and bot

## Repository layout

- `solana-subscription-service/`: subscription product with API, frontend, bot, Prisma, and Docker support
- `solana-launcher/`: larger Solana product workspace with frontend, backend, analytics, and research tooling
- `telegram-miniapp/`: Telegram mini app prototype
- `mcp-servers/`: local MCP server implementations
- `.agents/skills/`: custom Codex skills and references
- `scripts/`: root utility scripts

## Recommended deployment path

For a real test deployment with Docker and a database, deploy `solana-subscription-service` on:

- Oracle Cloud Always Free VM
- Coolify
- Docker Compose
- PostgreSQL and Redis on the same VM

Deployment files for that flow live here:

- `solana-subscription-service/docker-compose.prod.yml`
- `solana-subscription-service/docs/oracle-coolify.md`

## Local publishing notes

The root repository intentionally ignores:

- `.env` files
- local databases
- build output
- `node_modules`
- Python cache files
- temporary logs
- nested throwaway repositories inside `repo/` and `work/free-test-deploy/`

## Next step

If you want to run the actual product on a free Oracle VM, start with `solana-subscription-service` instead of the whole monorepo.
