# Legacy intelligence compatibility layer

This directory intentionally contains only the small set of legacy intelligence
modules that are still reachable from active CLI entrypoints.

The primary current intelligence implementation lives under `src/intelligence/`.
Do not add new analytics, graph, entity, signal or agent modules here. New
functionality belongs in the corresponding `src/intelligence/*` layer.

Before deleting or moving a remaining legacy module, check:
- `package.json` CLI entrypoints;
- static and dynamic imports;
- stored-data compatibility;
- full typecheck, tests and build.
