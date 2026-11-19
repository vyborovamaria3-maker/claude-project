# ARCH-06: offline collector-signed RPC provenance contract

Offline provenance verifier integrated into `main` through PR #133 (original PR #150); two-witness offline report acceptance was added by merged PR #159. No network transport, signer service, secret loading, API integration or confidence promotion is enabled. A dedicated SQLite challenge-store adapter is available only through an explicit file path.

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

Still required before production: reviewed acquisition implementation and endpoint policy, operational key custody/rotation, operational isolation/backup policy for the separate generation authority, independent RPC disagreement/reorg policy and historical-state uncertainty. This preparatory offline contract establishes none of those live properties and must not increase existing user-facing trade/PnL confidence.


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


## Separate persistent generation authority

The recommended serving interface is now `blockchain-rpc-recovery-authority.cjs`. It keeps the generation in a **second dedicated SQLite file**, separate from the challenge DB. Both use WAL and synchronous FULL. The authority file and its WAL must be outside the challenge snapshot/restore set. Being a different file does not itself establish a different filesystem/host failure domain.

- `createRpcRecoveryAuthority(authorityFilename,{challengeFilename,clock})` is explicit exclusive bootstrap. It pins canonical file paths, rejects the same file (including hardlinks), generates an initial random public epoch and writes append-only epoch history. It never replaces an existing authority. No signing key, RPC payload or secret is stored.
- `openRpcRecoveryAuthority(authorityFilename,{clock})` opens only an existing recognized authority at its pinned path. Missing, corrupt, foreign or partial files fail closed. It never recreates missing authority state, reads epoch from the challenge backup, or falls back to caller-supplied old epochs.
- `authority.createChallenges()` explicitly provisions a new challenge file once; `authority.openChallenges()` requires an existing recognized challenge schema matching the active epoch. Empty restored files are not automatically initialized. Use the returned store's `issue` and `consumeChallenge` methods with the existing `acceptRpcProvenance` adapter; close challenge handles before closing the authority.
- Every managed issue/consume holds an immediate authority transaction while checking active epoch and committing the conditional challenge write. Lock ordering is authority then challenge. `beginRecovery` cannot pass that boundary concurrently. Existing managed handles check authority on **each operation**, so pending recovery, stale handles, unavailable control storage or epoch mismatch cannot accept a report. The older low-level helpers remain migration/testing primitives; do not bypass the managed interface in serving workers.

Recovery protocol:
1. Stop serving workers and close all challenge handles. Read `authority.status()` and call `beginRecovery(expectedActiveEpoch)`. Its compare-and-set commits a new random, never-imported epoch and durable `recovering` phase **before** any challenge restore. Competing begins cannot both win. Do not restore or roll back the authority file.
2. Restore a consistent challenge SQLite snapshot to its pinned closed path, handling WAL safely. File copying is an operator action, not performed by this module. While `recovering`, all managed issuance/acceptance is blocked even before SQLite has been rotated.
3. Call `finishRecovery(expectedPendingEpoch,expectedSnapshotEpoch)` (`null` only for legacy v1). With the authority lock held, it first checks whether SQLite already has the target generation. Otherwise it performs the existing compare-and-rotate challenge recovery. Only after SQLite commits does it commit authority phase `active`.
4. Restart managed workers using `openChallenges`. Old challenge rows and valid old signed receipts remain ineligible. Issue new challenges/reports.

Crash windows are deliberate: a crash after begin leaves a durable pending gate; a crash after challenge commit but before authority commit also leaves pending. Resume recognizes the already committed target generation and completes the authority update. A lost final acknowledgement can retry finish idempotently without selecting another generation. A failed lock/compare or missing/empty/wrong challenge DB keeps the gate closed. There is no cross-database atomic transaction; the durable pending phase and commit ordering supply fail-closed recovery. This remains at-most-once acceptance, not exactly-once downstream delivery.

Tests (`blockchain-rpc-recovery-authority-test.cjs`) create separate temporary control/data directories and synthetic bindings. They cover competing begin calls, lock failure, process exit immediately after authority change, process exit immediately after challenge commit (test-only interception), pending-state restart/resume, repeated rollback with intact authority, old live handles, absent/corrupt/foreign authority, empty restored data files and hardlink isolation. The signed receipt suite exercises managed acceptance before/during/after recovery. No production fault hooks, RPC calls or real DB paths are used.

**Remaining trust boundary:** rolling back the authority together with challenge data, unannounced rollback within an unchanged active generation, filesystem replacement beneath live connections, bypassing the managed interface, or old workers against independent clones cannot be detected automatically by these local files. Keep one canonical authority, isolate its custody/backups, stop workers during recovery and retain its epoch history. No hardware monotonic counter, distributed lease or provider-origin/finality/PnL proof is claimed.


## Independent rollback anchor (conditional external-witness guarantee)

`blockchain-rpc-rollback-anchor.cjs` supplies a persistent reference implementation of a monotonic compare-and-append witness. It uses a third dedicated file, append-only sequence/hash-chain records, an unpredictable anchor identity and per-record salt. No secrets or RPC are involved. The **independence is a deployment trust assumption**, not a property created by adding a third local SQLite file: its file/WAL, storage administration and retained history must be outside the rollback domain of both the challenge and generation databases. An authenticated external CAS witness can implement the same synchronous adapter contract. No such external service or hardware counter is provisioned by this Draft.

Bootstrap explicitly with `createRpcRollbackAnchor(anchorFilename,{authorityFilename})`, then pass that object as `anchor` to `createRpcRecoveryAuthority(authorityFilename,{challengeFilename,anchor,clock})`. The authority pins anchor ID/head/sequence and canonical authority scope. A reference anchor must be fresh (sequence zero) at bootstrap and physically distinct from both DBs. Reopen via `openRpcRollbackAnchor(anchorFilename)` and `openRpcRecoveryAuthority(authorityFilename,{anchor,clock})`. An anchored authority cannot open without the witness or with a substituted/regressed witness. No default path, automatic rebootstrap or repinning is provided.

Serving order for each managed mutation is now: hold authority lock; compare its saved witness checkpoint; preflight generation/phase; commit the witness's next CAS record; verify that committed head; commit the challenge mutation; commit the authority checkpoint. Both issuance and **every consumption attempt** advance the witness, even when consumption returns false. This detects a joint snapshot rollback inside one unchanged generation, not just rollback across recovery generations. Opening a challenge handle and reading normal status also verify the witness. Failed/pending/stale generation preflights do not advance it. Lock order is authority -> witness -> challenge; the witness transaction commits before challenge work begins.

A witness failure or malformed adapter acknowledgement cannot authorize a challenge write. A successful witness append followed by any local failure leaves the two-store checkpoint behind: subsequent operations fail with `joint_store_rollback_or_interrupted_commit`. The mechanism intentionally cannot distinguish a crashed commit from rollback, and never silently moves the checkpoint forward. It does not give a cross-database exactly-once transaction.

Explicit repair with all workers stopped:
1. Preserve the witness; restore only consistent, closed challenge/authority DB snapshots if necessary. Never copy the witness from those snapshots.
2. Open the authority with `{anchor,clock,allowAnchorRecovery:true}`. This permits diagnostic opening when the witness is ahead, while serving remains blocked. `recoveryStatus()` returns the restored epoch/phase and independently read current witness head. Anchor ID/scope mismatch or witness regression still fails closed.
3. Call `beginAnchoredRecovery(restoredEpoch,currentWitnessHead)`. It compares the acknowledged independent head, appends a new witness record and commits a newly generated recovering epoch. Prior challenges are revoked on completion.
4. Call the normal `finishRecovery(newEpoch,expectedSnapshotChallengeEpoch)`; then reopen managed challenge handles. If a new failure advances the witness without committing the authority checkpoint, repeat explicit anchored recovery with another fresh epoch. Do not synchronize a checkpoint without revocation.

Older unanchored authority APIs remain for compatibility with the earlier Draft fixtures and do **not** detect joint rollback. Supplying an anchor to an old unanchored DB is refused rather than silently blessing a restored snapshot. To adopt anchoring, stop workers, preserve the old authority for audit, explicitly bootstrap a new pinned authority/anchor pair, then run recovery against the existing challenge file to revoke all old nonces. No live migration or deployment was performed here.

Tests use only temporary directories: consistent snapshots of both DBs are restored after successful consumption in the same epoch, while the independent witness is preserved. Serving fails before replay; explicit anchored repair revokes the old nonce. Separate child processes exit after witness append and after challenge commit before authority commit. Restart, unavailable/malformed witness, foreign/substituted/regressed anchor, immutable log and scope binding are checked. The existing synthetic signed-receipt test also uses the anchored managed consumer. Run `blockchain-rpc-rollback-anchor-test.cjs`; it and all earlier suites are included in `blockchain:test`/CI.

**Limit:** a silent challenge-only rewind within an unchanged generation (the authority checkpoint did not rewind), joint rollback of all three stores, administrative forging of DB/checkpoint contents, rollback of executable/configuration trust, bypassing the anchored serving API, or replacing files beneath live handles remains outside this local reference guarantee. Every declared restore, including a challenge-only restore, must still use generation-revoking recovery. The anchor tests specifically prove joint two-store rollback detection. Strong protection against whole-host rollback requires a genuinely independent service/WORM/hardware trust boundary. No provider-origin authentication, finalized trade proof or PnL confidence is added.
