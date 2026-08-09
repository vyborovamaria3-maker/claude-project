# POTAPoff Intelligence Layer

Foundation for off-chain intelligence collection.

## Goals

- isolate external data collection from product code;
- normalize web/social/developer evidence into one model;
- provide health checks and fallback providers;
- feed Control Center queues, alerts and analysis runs.

## Phase 1

Initial providers:

- Web
- GitHub
- YouTube
- RSS

Future providers:

- X/Twitter
- Reddit
- additional social sources

## Architecture

```
Agent-Reach/providers
        |
        v
Provider adapters
        |
        v
Intelligence jobs
        |
        v
Normalized documents
        |
        v
Risk/social/developer analysis
```

The intelligence layer must never contain trading keys, wallet secrets or private application credentials.
