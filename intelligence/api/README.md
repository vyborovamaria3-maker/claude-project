# Intelligence API

Planned endpoints:

```
GET  /api/intelligence/token/{id}
GET  /api/intelligence/token/{id}/timeline
GET  /api/intelligence/token/{id}/risk
GET  /api/intelligence/sources/health

POST /api/intelligence/analyze
GET  /api/intelligence/jobs/{id}
```

The frontend consumes normalized intelligence only.
Providers are hidden behind adapters.
