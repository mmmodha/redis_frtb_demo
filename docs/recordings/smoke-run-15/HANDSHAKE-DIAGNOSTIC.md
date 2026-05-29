# Wave 5.15p — Redis-ready handshake diagnostic

In-container handshake measurement against the new standalone Redis Cloud DB
to size `REDIS_READY_TIMEOUT_MS` for `services/api/src/redis-ready.ts`.
Smoke-run-15 SUMMARY recorded `api` bootstrap-failed on the previously
hard-coded 5,000 ms timeout; this wave makes that timeout env-overridable and
documents the measured latency so Wave 5.15o-v2 can re-run cleanly.

## Method

- `docker compose run --rm --no-deps --entrypoint node api measure.mjs`,
  bind-mounting `docs/recordings/smoke-run-15/scripts/measure-handshake.mjs`
  at `/app/services/api/measure.mjs`.
- The script constructs the ioredis client from the same env the api reads
  (`REDIS_URL` / `REDIS_TLS` / `REDIS_CLUSTER`), awaits the `ready` event, and
  prints only `elapsed_ms=<N>`. No URL, host, or credential is ever logged.
- Three back-to-back runs to smooth out cold-start jitter. One PING-equivalent
  per run (cap: 3 PINGs total, observed).

## Measurements

| Run | elapsed_ms |
| --- | ---------- |
| 1   | 538        |
| 2   | 363        |
| 3   | 376        |

- max = **538 ms**
- mean ≈ 426 ms

Consistent with the task-note expectation of a sub-1.5 s host-side handshake.

## Chosen default

Per the procedure: `ceiling = max(3) × 2`, rounded up to next 5,000 ms, cap
60,000 ms.

- 538 × 2 = 1,076 ms
- next 5,000-ms boundary ≥ 1,076 = **5,000 ms**

The default in `services/api/src/redis-ready.ts` therefore stays at **5,000 ms**
(unchanged); the wave's contribution is the env-var override, not a default
bump. The measured network is comfortably fast enough for the existing
default — the smoke-run-15 timeout was a *configuration* gap (no way to widen
the gate per deployment), not a baseline-latency gap.

## Env-var contract

`REDIS_READY_TIMEOUT_MS` (integer milliseconds, optional):

1. If `opts.timeoutMs` is passed explicitly, it wins (test callers).
2. Else if `process.env.REDIS_READY_TIMEOUT_MS` parses to a finite number > 0,
   use it.
3. Else fall back to the literal `5_000`.

Invalid values (`NaN`, `≤ 0`, non-numeric) silently fall back to 5,000 — no
throw, no warning, to keep the bootstrap gate's failure semantics unchanged.

## Diff stat

`services/api/src/redis-ready.ts`: 1 line replaced with 2 lines (net **+1**).
The semantic change is a single expression — the rest of the file (cluster
`ready`/`error`/timeout race, standalone `.connect()` + already-connecting
tolerance) is byte-identical.

```
 services/api/src/redis-ready.ts | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)
```

`.env.example`: 4 lines appended after the `REDIS_CLUSTER` block (one blank,
three comments). `.env.local` untouched.

## Test results

`npm test --prefix services/api` → `tsc --noEmit && vitest run`:

```
 Test Files  20 passed | 2 skipped (22)
      Tests  124 passed | 3 skipped (127)
   Duration  3.44s
```

`tests/redis-ready.test.ts` — all 10 tests green, including the existing
`timeoutMs: 30` timeout-fires assertion that exercises the new ternary's
`opts.timeoutMs`-wins branch.

## Recommended `.env.local` entry

For Redis Cloud / cross-internet endpoints, set:

```
REDIS_READY_TIMEOUT_MS=30000
```

30 s leaves ≈55× headroom over the worst measured handshake (538 ms) and
covers occasional cluster-slot-discovery / TLS-handshake retries that
ioredis performs internally. The default 5,000 ms stays appropriate for
local docker-compose Redis.

## Secrets-clean

No file written by this wave contains a Redis URL value, a credential, or
any secret. The measurement script reads `process.env.REDIS_URL` but only
emits `elapsed_ms=<N>`; `.env.example` keeps only its pre-existing
`CHANGE_ME` placeholder.
