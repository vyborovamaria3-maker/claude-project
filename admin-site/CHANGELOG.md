# Changelog

## 1.0.3

- expanded Control Center tests from 13 to 25 scenarios;
- fixed SQLite `file:` URI write-mode bypass;
- replaced Host-derived CSRF trust with explicit production Origin allow-list;
- added production configuration validation;
- added reproducible deep test runner;
- added failure, concurrency, session, pagination and upstream-error regression tests;
- aligned VERSION and deployment example with v1.0.3.

## 1.0.2

- fixed test execution from the monorepo root;
- fixed client IP selection behind trusted proxy hops;
- removed unsafe shell command wrappers in reviewed integration code;
- moved browser session handling toward HttpOnly cookies.

## 1.0.1

- closed SQLite connection leaks;
- enforced read-only SQLite and PostgreSQL connections;
- added recursive secret masking and CSV formula-injection protection;
- added session lifetime validation and thread-safe login throttling;
- added Solana base58 validation before RPC requests.
