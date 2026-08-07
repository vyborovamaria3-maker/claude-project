# Security hardening applied

- Production start paths fixed for TypeScript output layout.
- PostgreSQL is no longer exposed on all interfaces.
- Redis is bound locally and requires password configuration.
- Default database password removed from compose configuration.

Remaining items require application-level implementation: authentication, authorization, audit logging and rate limits per user.
