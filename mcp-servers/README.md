# MCP Servers for this project

This folder contains three ready-to-run MCP servers tailored to `C:\Users\Рафаил\claude-project`:

- `solana-rpc-mcp` — Solana JSON-RPC tools
- `x-api-mcp` — X/Twitter API tools
- `pumpfun-mcp` — local Pump.fun/SQLite tools over `solana-launcher\data\trade.db`

## Layout

```text
mcp-servers/
  package.json
  tsconfig.json
  src/
    shared.ts
    solana-server.ts
    x-server.ts
    pumpfun-server.ts
```

## Install

```bash
cd C:\Users\Рафаил\claude-project\mcp-servers
npm install
```

## Environment

Create a local `.env` or set environment variables in your MCP client:

```bash
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_BASE_URL=https://mainnet.helius-rpc.com/v0
HELIUS_API_KEYS=key1,key2,key3,key4,key5
X_BEARER_TOKEN=your_x_bearer_token
PUMPFUN_DB_PATH=C:\Users\Рафаил\claude-project\solana-launcher\data\trade.db
```

## Run locally

```bash
npm run solana
npm run x
npm run pumpfun
```

## Codex `config.toml`

Use this in `C:\Users\Рафаил\.codex\config.toml` or project `.codex\config.toml`:

```toml
[mcp_servers.solana]
command = "npx"
args = ["--yes", "tsx", "C:/Users/Рафаил/claude-project/mcp-servers/src/solana-server.ts"]
env = { SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com", HELIUS_BASE_URL = "https://mainnet.helius-rpc.com/v0", HELIUS_API_KEYS = "PASTE_KEY_1,PASTE_KEY_2,PASTE_KEY_3,PASTE_KEY_4,PASTE_KEY_5" }

[mcp_servers.x]
command = "npx"
args = ["--yes", "tsx", "C:/Users/Рафаил/claude-project/mcp-servers/src/x-server.ts"]
env = { X_BEARER_TOKEN = "PASTE_YOUR_X_BEARER_TOKEN_HERE" }

[mcp_servers.pumpfun]
command = "npx"
args = ["--yes", "tsx", "C:/Users/Рафаил/claude-project/mcp-servers/src/pumpfun-server.ts"]
env = { PUMPFUN_DB_PATH = "C:/Users/Рафаил/claude-project/solana-launcher/data/trade.db" }
```

## Notes

- `pumpfun-mcp` reads your existing SQLite data directly from `trade.db`.
- If you keep the project in a different location, update the hard-coded paths in the config or pass the env vars explicitly.
- `x-api-mcp` requires a valid X API bearer token.
- `solana-rpc-mcp` works without extra dependencies beyond a reachable RPC endpoint.
