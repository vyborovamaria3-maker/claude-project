# POTAPoff Intelligence Worker

The worker layer is responsible for asynchronous intelligence jobs.

Lifecycle:

```
queued -> collecting -> normalizing -> analyzing -> completed
                         |
                         -> failed
```

Responsibilities:

- consume jobs
- call provider adapters
- normalize documents
- persist results
- expose health information

The worker must never contain wallet secrets or trading credentials.
