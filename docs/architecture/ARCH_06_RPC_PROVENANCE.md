# ARCH-06: offline collector-signed RPC provenance contract

Draft PR #150. No network transport, signer service, secret loading, API integration or confidence promotion is enabled. A dedicated SQLite challenge-store adapter is available only through an explicit file path.

## What is authenticated

`solana-launcher/scripts/blockchain-rpc-provenance.cjs` verifies an Ed25519 signature by an independently configured collector witness. It authenticates that configured witness's report, **not** a signature by the RPC provider, a TLS transcript, actual consensus finality, historical mint state, trade completeness or PnL. A dishonest/compromised witness can sign fabricated data. Synthetic signatures prove only the verifier contract.

Out-of-band trust configuration pins `{keyId, publicKey, endpointId, genesisHash}`. `publicKey` is Ed25519 SPKI PEM; no embedded key is accepted. `endpointId` is an opaque operator-configured label, never an arbitrary URL or credential. Remove/replace the pin to revoke/rotate a witness; there is no automatic trust discovery or fallback. A future collector must independently enforce the endpoint mapping, authenticated HTTPS, no redirects to other origins, cluster consistency, bounded requests/timeouts and secret redaction before signing.

## Package and binding

Envelope: `{payload: JSON string, signature: canonical base64}`. Sign exactly `UTF8("ARCH-06-RPC-OBSERVATION-v1\0") || UTF8(payload)` where `\0` denotes a NUL byte. Maximum payload: 256 KiB. This module deliberately exports no signing function.

Payload fields (version 1, no extras): `version, keyId, endpointId, genesisHash, challenge, eventKey, startedAt, completedAt, exchanges`. Clocks are integer epoch milliseconds. Collection duration must be at most 30 seconds; the start must be within five minutes of trusted verifier `now`; future completion is rejected. These bounds do not prove wall-clock accuracy of the witness.

Three ordered exchanges each contain exactly `{request,response}`:
1. `getGenesisHash`, params `[]`; result must equal the configured genesis hash.
2. Exact `buildVerificationPlan(event).signature` request.
3. Exact `buildVerificationPlan(event).mint` request.

Each request contains `jsonrpc:"2.0"`, distinct string `id`, method and params. Response contains exactly `jsonrpc:"2.0"`, matching `id`, and `result`. Error envelopes, substituted signature/mint/commitment, unknown fields and mismatched cluster are refused. The existing offline validator then checks status consistency and mint layout. `eventKey` and validated revision envelope bind the raw revision/hash, wallet, signature and mint. Genesis binding follows the official [getGenesisHash contract](https://solana.com/docs/rpc/http/getgenesishash); a signed claimed genesis response alone cannot prove which server was contacted.

## Replay and acceptance

`verifyRpcProvenance(event,envelope,trust,{challenge,now})` is a pure inspection function. Its positive result includes `requiresAtomicChallengeConsumption:true`; it is **not acceptance**.

The verifier must issue an unpredictable 32-byte hex challenge independently, persist it with the event key, key/source/cluster pins and an expiry, and retain consumed state across restarts/workers. Never take expected challenge/time/trust from the package. `acceptRpcProvenance(...,consumeChallenge)` requires an injected trusted atomic compare-and-consume operation. It receives `{challenge,eventKey,keyId,endpointId,genesisHash,now}` and must return literal `true` only for an issued, matching, unexpired, unused record. Missing hook, storage error, unknown/replayed challenge or non-boolean result fails closed. No default in-memory store is supplied. The dedicated SQLite adapter below implements persistent compare-and-consume; the older Set fixture tests the injection contract only.

Consumption must precede any use of the result. A crash after consumption may lose a report; retry requires a newly issued challenge and newly collected/signed report. Acceptance remains `configured_collector_attested_rpc_observation`, with historical mint state unknown and trade status `not_a_confirmed_trade_tape`. No Outbox, Timeline, API verified badge or PnL is produced.

## Verification and remaining gates

Run `node scripts/blockchain-rpc-provenance-test.cjs` and `node scripts/blockchain-swap-proof-validation-test.cjs` from solana-launcher. Both are included in `blockchain:test`; the fast blockchain workflow explicitly watches these modules.

All new fixtures are synthetic. Keys are generated ephemerally in process and never written/logged. Tests cover tampering/foreign keys/domain, pin/cluster mismatch, invalid clocks/expiry, request/response substitution, source revision changes, contradictory status, missing atomic storage, storage failure and concurrent replay.

Still required before production: reviewed acquisition implementation and endpoint policy, operational key custody/rotation, operational challenge-store deployment/backup policy, independent RPC disagreement/reorg policy and historical-state uncertainty. This preparatory offline contract establishes none of those live properties and must not increase existing user-facing trade/PnL confidence.


## Dedicated persistent challenge store (Draft #150 continuation)

`openRpcChallengeStore(absoluteFilename, {clock,recoveryEpoch})` from `blockchain-rpc-challenge-store.cjs` opens an explicitly named **dedicated** SQLite file. There is no environment lookup, default path or automatic collector DB migration. A new empty file receives an application ID and schema version 2; an existing foreign schema or unsupported version is refused before WAL setup. Version 1 requires explicit recovery migration and revokes all legacy challenges. The handle stays private. SQLite WAL and synchronous FULL are required. Storage is local to one host; this is not a distributed cross-host replay store.

- `store.issue({eventKey,keyId,endpointId,genesisHash}, ttlMs=60000)` generates a cryptographically random 32-byte hex challenge, commits its SHA-256 and immutable binding/issuance/expiry, then returns the nonce and clocks. TTL is 1..300000 milliseconds. The public key, endpoint credentials, raw RPC data and signing keys are not stored. Do not reuse key IDs for different signing keys.
- Pass `store.consumeChallenge` into `acceptRpcProvenance`. A single autocommitted conditional UPDATE matches the nonce hash and all pins/event key, checks unused state and expiry, and marks consumption. An independently reread store clock controls expiry; stale verifier time cannot extend it. A verifier time before issuance or in the future is rejected. The function returns true only after the write commits. Lock/storage errors throw and are converted by the acceptance adapter to insufficient evidence.
- `store.close()` closes the private connection. Reopening the same file retains both unused and consumed rows. Triggers reject rebinding, unconsuming, deletion and replacement of an existing identity. There is no purge API, reset or nonce-import fallback.

The trusted clock must be maintained by the caller/host; injected clocks are for deterministic tests, not receipt-supplied timestamps. Administrative DDL/file replacement is outside the protection boundary. A stale backup, cloned DB on another host or filesystem rollback can restore unused records and break global replay protection. Keep the canonical store unique, preserve WAL safely for backup, restrict filesystem access, and retire outstanding challenges/pins on disaster recovery. The explicit generation-based recovery API below implements revocation; file replacement, external pin custody and whole-host recovery remain operator responsibilities. Do not point this module at real databases during this Draft work.

A crash after durable consumption but before acknowledgement leaves the challenge consumed. Downstream use is not in the SQLite transaction: this provides at-most-once acceptance, not exactly-once trade/event delivery. A retry must obtain a new challenge and newly signed observation. No event/Timeline/API writes are introduced.

`blockchain-rpc-challenge-store-test.cjs` uses only freshly created temporary files and synthetic bindings. It checks separate-process issuance/consumption/restart, process exit after commit without acknowledgement, two independent worker connections racing through a barrier, expiry using current store time, binding substitutions, unknown nonce, lock rollback/retry, immutable consumed history and foreign-schema refusal. The existing signed-provenance suite also accepts a synthetic package through this store and rejects it after reopen. Both suites run in `blockchain:test` and its watched CI workflow. All temporary DBs/WAL files are removed by the fixtures.


## Recovery revocation and rollback boundary (schema v2)

`recoveryEpoch` is now a mandatory 32-byte hex **public generation identifier** supplied from trusted configuration outside the SQLite backup/rollback domain. It is not a signing secret. Generate a fresh random value for each recovery, never reuse an earlier generation, never read the trusted value from the restored DB, and never back up/restore it together with that DB. This library deliberately has no automatic trust fallback or default epoch. Existing initialization callers must provide this pin explicitly.

Each issued row carries its immutable generation. Opening an existing v2 store checks its current generation against the supplied pin. Every consumption additionally checks both the row generation and the DB's current generation within the atomic UPDATE. Issuance checks the generation in an immediate transaction, fencing old open handles after rotation. Old rows are retained unchanged for audit; revocation does not invent a historical consumed timestamp.

Recovery sequence (offline / no workers serving requests):
1. Stop **all** accepting/issuing workers and retire old instances. Keep acceptance disabled throughout recovery.
2. Publish/persist a newly generated `recoveryEpoch` in the independent trusted configuration. Do not revert this pin if the following operation fails. Restore a consistent SQLite snapshot only while its target is closed, handling WAL correctly.
3. Call `recoverRpcChallengeStore(absoluteFilename, {previousEpoch, recoveryEpoch, clock})`. `previousEpoch` is the expected generation in the restored snapshot (use `null` only for v1). The new generation must differ. A compare mismatch aborts. The existing dedicated file is required; recovery never creates a missing store or adopts a foreign schema.
4. The immediate transaction rotates the current DB generation (or explicitly migrates v1 rows with NULL generation). It preserves old rows but makes **all** old challenge hashes ineligible. New challenge issuance uses only the new generation.
5. Close the recovery handle; start workers with the independent new pin. An interruption between external publication and DB rotation leaves pin mismatch and acceptance blocked. If rotation committed but the response was lost, ordinary open with the new pin works; blindly repeating recovery with the old expected generation fails. Do not reopen with a fallback old pin.

A restored pre-consumption snapshot contains old nonces as unused; they still fail consumption after rotation. A correctly signed old RPC package fails through the existing acceptance adapter as well. Tests use temporary consistent SQLite backups/copies, a separate trusted synthetic epoch, stale open handles, restart, legacy migration and repeated rollback. New issuance/consumption resumes under the new generation. They are included in `blockchain:test` through `blockchain-rpc-challenge-store-recovery-test.cjs`.

**Limit:** SQLite alone cannot detect an unannounced rollback within the same generation, rollback of the external pin itself, or a rogue old worker running an old pin against a separate old database clone. Recovery must follow the sequence above, with one canonical store and external pin custody. This is revocation for explicit recovery, not hardware-backed rollback detection or a distributed fencing service. The implementation does not copy backups, manage external configuration, collect RPC, alter API confidence or establish finalized trades/PnL.
