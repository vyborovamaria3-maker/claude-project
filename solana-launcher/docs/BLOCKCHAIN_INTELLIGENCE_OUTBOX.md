# Blockchain Collector → Intelligence raw wallet evidence outbox

This is an **opt-in local SQLite source emitter**, not an RPC collector, trade
decoder, PnL calculator or connected Intelligence consumer.

Default: BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED unset/false. Enable only after:
1. Taking a verified WAL-aware SQLite backup of the existing trade.db.
2. Reviewing the additive SQLite outbox table and a restoration rehearsal.
3. Deploying a working local/isolated Intelligence consumer, with event replay,
   retries and rate/credit budgets.
4. Running the offline test: node scripts/blockchain-intelligence-outbox-test.cjs

With the flag true, initDb adds an SQLite-compatible outbox_events table with
the same source schema as the common portable adapter. During persistEvents,
ONLY changed wallet-target raw events emit a revision keyed by wallet, Solana
signature and SHA-256 hash, inside the EXISTING better-sqlite3 transaction.
The enclosing processOne transaction is lease-fenced. If the SQLite source
transaction rolls back, the Outbox INSERT is rolled back as well.

No raw compressed transactions, RPC credentials, account cookies or arbitrary
provider response payload are included in the outbox envelope. The envelope
identifies a validated syntactic wallet public key and validated syntactic
64-byte Solana signature, not a trade or a proven wallet owner. It carries
occurredAt separately from first-observed timestamp. A revisioned duplicate
does not create another event. Invalid signatures fail closed when enabled.

Token/creator/dex-program target addresses are intentionally NOT exported as
canonical token entities; a queried token-account or provider result does not
prove that an address is a tradable token mint. An evidence-backed token
resolver and historical backfill remain necessary.

The Outbox requires an external bounded, idempotent consumer. Source ACK
happens only after the destination commits. No live requests or database
migrations are performed by the offline unit test.
