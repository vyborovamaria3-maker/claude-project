# Legacy intelligence compatibility layer

Only modules still reachable from active legacy CLI entrypoints remain here.
The primary current intelligence implementation is under `src/intelligence/`.

Do not add new analytics, graph, entity, signal or agent modules here.
Before removing a remaining module, verify package scripts, dynamic imports,
stored-data compatibility, and the full test/build matrix.
