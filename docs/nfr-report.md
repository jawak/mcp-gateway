# NFR report — V1.0 gate (T-44)

Measured on a development laptop (Apple Silicon, 16 GB, dev machine also running the
build, the test suite and a browser — numbers on a 2 vCPU VPS will be worse, which is
why the PRD's targets are treated as ceilings, not as what this machine happens to do).

Reproduce:

```sh
bun run build
MCPGW_DATA_DIR=/tmp/mcpgw MCPGW_ROOT_DIR=$PWD bun build/server.js &
bun run scripts/smoke.ts    --base-url http://localhost:8080
bun run scripts/loadtest.ts --base-url http://localhost:8080 --sessions 200 --burst 200
```

## Latency and throughput

| Measurement                                                       | Target (PRD)               | Measured                              | Verdict       |
| ----------------------------------------------------------------- | -------------------------- | ------------------------------------- | ------------- |
| `tools/list`, cache hit                                           | p95 ≤ 100 ms               | p50 1.4 ms / p95 5.1 ms               | pass          |
| Added latency, `tools/call` (gateway − direct to the same server) | p50 ≤ 100 ms, p95 ≤ 300 ms | p50 0.9 ms / p95 3.1 ms               | pass          |
| `tools/list` with 200 concurrent sessions                         | p95 ≤ 100 ms               | p95 37.7 / 49.8 / 73.1 ms over 3 runs | pass          |
| Session establishment                                             | —                          | 200 sessions in ~345 ms (≈ 580/s)     | informational |
| Loadtest process RSS                                              | —                          | ~97 MB                                | informational |

Added latency is measured as a **difference** against the same upstream reached
directly over Streamable HTTP, so upstream execution time is not credited to the
gateway. Measuring absolute gateway latency would have looked flattering and meant
nothing.

## Rate limiting

Burst of 200 requests against a profile limited to 30 rpm: `429=170`, and the
refusals carry `Retry-After` and `X-RateLimit-Remaining: 0`. The remaining 30 are
`400` from the MCP transport (a raw `tools/list` without a session is not a valid
post-initialize request) — they passed authentication and the limiter, which is what
this check is about.

## Findings during this audit

None of the findings below were visible to the unit/integration tests — the first two
rounds were found by running the thing, which is the only way a first-run defect can be
found.

1. **One `UPDATE` per MCP request.** `SessionRegistry.get()` wrote `last_seen_at` on
   every request. That column only feeds the idle collector — minute-level precision —
   but it sits on the hot path of every request. Under 200 concurrent requests it became
   200 serialized `UPDATE`s on a single SQLite connection and pushed `tools/list` to
   p95 143 ms, over budget. Now throttled to one write per 15 s per session, with the
   true final timestamp flushed when the session closes. Regression test added.
   After the fix: p95 37–73 ms across three runs.

2. **A freshly minted key could look like a bad credential.** The entrypoint bundle
   and the SvelteKit bundle hold separate copies of the registry cache, so for up to
   `STALE_MS` a key created in the dashboard was answered `no-profile` (401) by the
   authenticator — and that refusal was counted as an authentication failure, which
   after ten of them locked the operator's own IP out for 60 seconds, immediately after
   they did the one thing they were supposed to be able to do. Two fixes:
   `getProfileAssumingFresh()` treats a miss as suspected staleness and reloads once,
   and only genuinely bad/unknown credentials count against a source address — an
   expired, revoked or suspended key is a real credential that merely no longer works,
   and a cache race is a server-side condition, not a guess.

### First-run cluster (found by running `bun run dev` on a fresh database)

A fresh clone could not start: every request returned 500. Four defects, one symptom.

3. **`vite dev` never migrated.** The production entrypoint migrates before accepting a
   request; the dev path has no entrypoint and nobody added the call. Fixed by running
   migrations and the admin bootstrap in the dev hook — and by clearing the cached init
   promise on rejection, which had made a failed first request fatal for the lifetime of
   the process, so migrating in a second terminal would not have helped.
4. **The registry turned "no schema" into a 500.** Making every read path refresh its
   cache (finding 1's companion) put `SELECT … FROM kv` in front of the very first query
   of a fresh install. `currentConfigVersion()` and `reload()` now treat an absent schema
   as "nothing configured yet" and log once per transition. The catch is deliberately
   narrowed to the missing-schema condition: a failing disk must still fail loudly,
   because an empty catalog would send an operator looking in the wrong place.
5. **The worker never waited.** `migrate.ts` had documented since T-04 that the worker
   polls for the schema, and `waitForMigrations()` had zero call sites — it was dropped
   when the worker was rewritten. Restored, with a non-zero exit on timeout: a worker that
   deletes retention data against the wrong schema is worse than one that never started.
   Readiness is now a value (`schemaIsPresent`/`assertMigrated`) rather than an exception,
   injected into the router so `/mcp` returns `503` with the command that fixes it, the
   dashboard says the same, and `/healthz` stays `200 ok:false` so a container
   healthcheck reports the state instead of restart-looping it.
6. **A copied `.env` could not boot.** `MCPGW_METRICS_TOKEN=` in the example file is an
   empty _string_, not unset, so `min(16)` rejected it — the first thing a new operator
   does failed validation. Blank now means unset. Related: `MCPGW_ADMIN_PASSWORD` strength
   was checked in the whole-process schema, so a weak bootstrap password stopped unrelated
   processes (including the worker) from starting; the policy now lives where the value is
   used, and a skipped bootstrap is logged instead of silent.

### Security finding during test maintenance

7. **stdio children inherited the gateway's `.env`.** The spawn environment is allowlisted,
   but the child's _working directory_ was the gateway's own, and Bun re-reads `./.env` at
   startup — so any upstream package could read `MCPGW_MASTER_KEY` regardless of filtering.
   Children now start in a neutral `<dataDir>/workdir` unless `cwd` is set explicitly. The
   existing environment-hygiene test caught this; it had been green only because no `.env`
   existed in that checkout yet, which is itself the lesson: a test that depends on the
   absence of a file the developer is expected to create is not a test.

### Configuration loading (found by a user running `bun run dev`)

8. **`.env` was never read in development.** The symptom was a gateway that started
   happily and reported `MCPGW_MASTER_KEY is unset`, `MCPGW_PUBLIC_URL is unset`,
   `MCPGW_ADMIN_EMAIL/ADMIN_PASSWORD not set` — with a correct `.env` sitting in the
   directory. Bun loads `.env` for the entrypoint it runs directly, but `bun run dev`
   hands off to `vite`, and Vite/SvelteKit never copy `.env` into `process.env`; they
   expose only `VITE_*` to the browser via `import.meta.env`. Every value this gateway
   reads lives in `process.env`, so in development the configuration was entirely unset:
   an ephemeral master key, no admin bootstrap, a public URL pointing at a port that was
   not being used. The dev server now loads the files itself, before the server modules
   are imported, with the environment taking precedence over the file — so it works for
   `bun run dev`, `npx vite dev` and IDE launchers equally, and a container environment
   is never overridden by a stale file in the image.

   Two details that would otherwise be traps: `loadEnv` with an empty prefix returns the
   **entire** `process.env` merged with the files, so "what came from the file" has to be
   computed from the names actually declared there or the startup report is fiction; and
   only `VITE_*` may ever reach the client, which is now asserted by a test rather than
   trusted, because `envPrefix: ''` would publish the master key in the browser bundle.

   **Why 500-odd tests missed this**: every one of them either set variables explicitly
   or ran under `bun test`/`bun file.ts`, where Bun _does_ load `.env`. The only path that
   reveals the defect is starting the dev server with nothing but a `.env` file — which is
   precisely what a new operator does. Same lesson as the first-run cluster: the tests
   exercised the mechanism, not the entrypoint a human uses.

### Credential boundary (found while answering "can I register two Postgres upstreams?")

9. **BR-09 was enforced in the wrong layer.** The dashboard form refused a credential
   typed into an env line, but the form is not the only writer: templates, manifest
   apply and any future API call the registry directly, and `createUpstream` stored
   `envRefs` verbatim. One of those paths was in fact broken — the template install
   wrote a bare secret name, which reads back as a _literal_, so the spawned server
   received the secret's name as its `DATABASE_URL`. The rule now lives at the registry
   boundary, and `renderManifest()` runs the same detection on the way out: previously
   the check existed only on import, so a bad value could leave the building inside a
   file that gets committed, emailed and pasted into tickets.

   Two details worth recording because they are easy to get wrong again: the detector
   fires on the colon in `secret:pg-dev__url`, so it may only be applied to literal
   values — an anti-false-positive test locks that; and secret _existence_ is
   deliberately not checked at the boundary, because applying a manifest to an empty
   box legitimately references secrets that arrive later.

## Security checklist

| Item                         | Requirement                                      | Status | Evidence                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key storage              | hash only, shown once                            | done   | `tests/integration/apikey-lifecycle.test.ts` asserts the plaintext is absent from the DB and from a later page read; smoke test confirms one-time display           |
| Revocation latency           | seconds, not idle timeout                        | done   | smoke: live session → revoke → next request `401 revoked`                                                                                                           |
| Password storage             | argon2id                                         | done   | `tests/unit/vault.test.ts`, login tests assert hash shape                                                                                                           |
| Enumeration resistance       | same message and timing                          | done   | dummy-hash verify on unknown accounts; test compares both message and time ratio                                                                                    |
| IP backoff                   | 10 bad guesses/min → cooldown, per address       | done   | `tests/integration/auth-mcp.test.ts`                                                                                                                                |
| Secrets at rest              | AES-256-GCM, never returned                      | done   | `tests/unit/vault.test.ts`; API surface only ever lists names                                                                                                       |
| Secrets in spawned children  | allowlisted env **and** neutral cwd              | done   | `tests/integration/stdio-upstream.test.ts` asserts the child sees neither `MCPGW_MASTER_KEY` nor the gateway's `.env`                                               |
| First-run / degraded schema  | one actionable answer, never a stack trace       | done   | `tests/unit/migrate-readiness.test.ts`, `worker-wait.test.ts`; verified by dropping the schema under a running server: `/mcp` 503 + hint, `/healthz` 200 `ok:false` |
| No child-process secret leak | allowlisted env                                  | done   | `tests/integration/gateway-e2e.test.ts` proves `MCPGW_MASTER_KEY` is invisible to the spawned child                                                                 |
| Manifest cannot carry tokens | reject inlined credentials                       | done   | `tests/integration/manifest.test.ts` (import rejected, nothing written) + smoke asserts the export has no credential shapes                                         |
| SSRF guard                   | https, private ranges, metadata IP, no redirects | done   | `tests/unit/ssrf.test.ts`, `tests/integration/remote-upstream.test.ts`                                                                                              |
| CSRF                         | origin check on form actions                     | done   | smoke: cross-origin form action → `403`                                                                                                                             |
| RBAC                         | viewer cannot mutate                             | done   | `tests/unit/rbac.test.ts` policy matrix + hook tests                                                                                                                |
| Admin lockout                | 5 failures → 15 min                              | done   | `tests/integration/login.test.ts`                                                                                                                                   |
| Audit trail                  | append-only, covering config writes              | done   | `tests/integration/audit.test.ts`; no update/delete path exists in the module                                                                                       |
| Header hygiene               | CSP, nosniff, DENY, referrer, permissions        | done   | `tests/unit/rbac.test.ts`                                                                                                                                           |
| Non-root container           | —                                                | done   | `deploy/Dockerfile` creates and switches to `mcpgw`                                                                                                                 |
| Metrics not public           | token required, closed when unset                | done   | smoke: `/metrics` 404 without a configured token                                                                                                                    |

## Known gaps (accepted for V1.0)

- **TLS terminates at Caddy**, not in the gateway; the compose stack assumes it. A
  bare `bun run start` is plain HTTP and must sit behind a proxy.
- **`/healthz` is unauthenticated by design** (container healthcheck), exposing counts
  only — no key names, no upstream URLs.
- **Single node.** Redis-backed shared state, HA and per-user OAuth are deliberately
  deferred to v2 (T-47, T-48).
- **Load figures are one machine, not a certified capacity number.** The suite is in
  the repo so a VPS figure can be produced on demand; publishing a capacity promise
  from a laptop would be misleading.
- **The 1.000-concurrent-session figure from the PRD was not measured here** — 200
  concurrent sessions were, and the cost per session is dominated by the per-request
  auth query plus one throttled liveness write, so it scales linearly with connections
  rather than quadratically.
