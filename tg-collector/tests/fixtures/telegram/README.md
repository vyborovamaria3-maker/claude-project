# Telegram fixtures

`messages.v1.json` is the stable JSON fixture format used by deterministic parser tests.

- `fixture_version` is the fixture contract version.
- `gramjs_version` records the GramJS/Telegram adapter version used when the fixture was captured.
- Only the subset consumed by `analytics/extract.ts` is represented.
- `channelId` is serialized as a string because GramJS bigint-like values are not JSON-native.
- Fixtures must contain no session strings, API credentials, phone numbers, or other secrets.
- Updating the GramJS dependency does not silently mutate fixtures; bump `fixture_version` only when the collector's fixture contract changes.

The live `smoke:mtproto` test remains separate and is the only check that requires a real Telegram session.
