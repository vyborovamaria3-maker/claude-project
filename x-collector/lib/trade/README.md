# Trade directory boundary

This directory is the compatibility/infrastructure layer for the X Collector:
PostgreSQL access, task/account state, retries, schemas, sessions and related
persistence helpers.

The analytics and graph implementations that still exist here are legacy
compatibility modules. New analytics, graph, entity and signal functionality
must be implemented under `src/intelligence/`.

Do not create another `analytics-*.ts`, `graph-*.ts` or intelligence engine
here. When changing a legacy module, preserve its old import path unless a
dedicated compatibility migration updates all callers.
