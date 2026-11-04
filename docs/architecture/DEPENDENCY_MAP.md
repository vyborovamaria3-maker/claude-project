# Dependency map

The current repository-wide dependency and data-flow inventory is maintained in [SYSTEM_DEPENDENCY_MAP_20261030.md](SYSTEM_DEPENDENCY_MAP_20261030.md).

The map distinguishes:
- independent X, Telegram and blockchain source stores;
- the separate Node Intelligence event/timeline destination;
- the distinct Python provider/NLP Intelligence runtime;
- standalone Memecoin Intelligence, Admin, Subscription and Telegram Mini App domains;
- shared packages that provide optional building blocks rather than automatic runtime wiring.

This file previously contained only a short X Collector dependency list. That historical collector-specific scope is superseded by the repository-wide map; see [ARCHITECTURE_BASELINE_20261012.md](ARCHITECTURE_BASELINE_20261012.md) for the old audit context.
