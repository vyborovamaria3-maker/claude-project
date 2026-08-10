# POTAPoff Intelligence Worker

The worker layer orchestrates asynchronous intelligence jobs without depending on any concrete external source.

## Job payload

Each job currently requires:

```json
{
  "provider": "github",
  "query": "owner/repository"
}
```

The provider name is resolved through `ProviderRegistry`. The query is passed only to that provider.

## Lifecycle

```text
queued
  -> running
      -> provider.collect(query)
      -> provider.normalize(document)
      -> deduplicate/store
  -> completed

Any validation/provider/storage failure -> failed
```

Completed jobs expose `result_document_ids` and execution timestamps. Failed jobs expose only sanitized domain errors; unknown implementation errors are collapsed to `internal_worker_error` so internal paths or secrets are not leaked.

## Responsibilities

- validate job payloads;
- resolve providers through the registry;
- call provider adapters;
- normalize returned documents;
- persist and deduplicate normalized evidence;
- store result document IDs and timing metadata.

## Boundaries

The worker must never:

- contain wallet secrets or trading credentials;
- invoke provider-specific APIs directly;
- perform AI scoring inside collectors;
- expose raw unknown exception text to callers.

Queue and storage are memory-backed during the foundation phase and will be replaced behind stable interfaces before production deployment.
