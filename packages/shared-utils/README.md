# Shared utilities (PR-3)

Small optional module for logger sanitization, bounded transient retries with
rate-limit delays, AES-256-GCM proxy credential envelopes, error classes and a
LOCAL token bucket. No existing collector code is rewired by this change.

- Do not log message bodies, full provider URLs or raw HTTP headers that may
  contain credentials. Structured key redaction supplements, but does not
  replace, strict caller-side secret hygiene.
- rotateKey is a primitive; durable key rotation needs migrations, backup and
  transactional re-encryption logic.
- TokenBucket is per process only, NOT a distributed provider budget.
- Unknown error classes fail closed; do not infinitely retry authentication.
- FloodWait is a platform-specific retry policy to be added at TG integration.

Run `npm install --prefix packages/shared-utils --ignore-scripts --no-package-lock`
then `npm --prefix packages/shared-utils run check`.
