# Build info endpoint

`GET /api/build-info` is intentionally uncached and exposes the frontend build SHA used by production health checks.
It does not expose secrets or runtime credentials.
