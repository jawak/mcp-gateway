# mcp-gateway

One MCP endpoint for many MCP servers. Point your AI client (Claude Code, Claude Desktop, Cursor, opencode, Windsurf) at a single URL + API key and get every upstream MCP tool the gateway admin has configured — stdio servers are spawned on the server, so nothing is installed and no credential ever lives on your laptop.

Specs and status: [`.agents/1-PRD.md`](./.agents/1-PRD.md) → [`.agents/2-TECH-SPEC.md`](./.agents/2-TECH-SPEC.md) → [`.agents/3-TASKS.md`](./.agents/3-TASKS.md) · NFR evidence: [`docs/nfr-report.md`](./docs/nfr-report.md)

## Stack

Bun ≥ 1.2 · SvelteKit 2 + adapter-node (one process; `/mcp` is mounted by a Bun `node:http` listener) · `bun:sqlite` + Drizzle · `@modelcontextprotocol/sdk` 1.30 · Tailwind 4 · self-host Docker + Caddy.

## Prerequisites

- Bun ≥ 1.2
- Node ≥ 20 and/or Python (`uvx`) / Docker — only needed for the **upstream** MCP servers you spawn via stdio
- Docker (for the production compose stack)

## Development

```sh
bun install
cp .env.example .env      # set MCPGW_MASTER_KEY + MCPGW_ADMIN_EMAIL/PASSWORD
bun run dev               # dashboard + /mcp at http://localhost:5173
```

`bun run dev` migrates the database itself and bootstraps the admin, so a fresh clone
runs with one command — `bun run db:migrate` is never required first. Only the
**worker** needs the schema to exist already, and it waits for it (up to
`MCPGW_WORKER_WAIT_S`, default 60 s) before doing anything, refusing to start rather
than sweeping a schema that is not there.

```sh
bun run dev         # dashboard + /mcp on http://localhost:5173
bun run worker:dev  # optional: health sweep, session GC, retention, snapshots
```

`worker` runs the built file (`build/worker.js`) because the container image ships only
build output; `worker:dev` runs the TypeScript source so a dev loop needs no build.

The dev server loads `.env` itself (`.env`, `.env.local`, `.env.development[.local]`),
because Vite never copies those files into `process.env` and Bun only auto-loads them for
the entrypoint it runs directly — `bun run dev` hands off to `vite`, so relying on that
autoloading left the entire configuration silently unset in development. A variable
already present in the environment always wins over the file, so a shell, systemd unit or
container environment overrides a stale file. Startup prints one line naming the files it
read and whether `MCPGW_MASTER_KEY` came from the file or the environment — "is my `.env`
being read?" should not require debugging to answer. Only `VITE_*`-prefixed variables are
ever exposed to the browser, so `MCPGW_*` stays server-side.

Production is the opposite on purpose: the web process migrates once at boot and
nothing else ever runs DDL, so N replicas can start without racing `ALTER TABLE`.
If the schema is ever missing or behind, `/mcp` answers `503` naming the one command
that fixes it and the dashboard says the same, while `/healthz` stays `200` with
`ok: false` and `schema: "no-schema"` — a container healthcheck reports the problem
without restart-looping a process that only needs a human.

Blank variables in `.env` count as unset, so the copied example file boots as-is.
Leaving `MCPGW_PUBLIC_URL` blank makes the dashboard derive the client-snippet URL from
the request host, which is what you want locally; set it explicitly in production.
`MCPGW_ADMIN_PASSWORD` shorter than 12 characters is reported at boot and the account
is not created — the gateway still starts, and the log tells you why.

| Script                                             | Purpose                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `bun run dev`                                      | Vite dev server (dashboard **and** `/mcp`, `/metrics`, `/healthz`) |
| `bun run build` / `bun run start`                  | Production build and Bun server                                    |
| `bun run worker`                                   | Health sweep, session GC, retention, daily snapshot                |
| `bun run worker:dev`                               | Same, from TypeScript source — no build needed                     |
| `bun run verify`                                   | check + lint + test + build (the CI gate)                          |
| `bun run check`                                    | `svelte-kit sync` + `svelte-check`                                 |
| `bun run lint` / `bun run format`                  | ESLint + Prettier                                                  |
| `bun run test` / `test:unit` / `test:integration`  | `bun:test`                                                         |
| `bun run db:generate` / `db:migrate` / `db:studio` | Drizzle Kit                                                        |
| `bun run smoke`                                    | Drives a running instance end to end with a real MCP client        |
| `bun run loadtest`                                 | Added-latency, concurrency and rate-limit measurement              |

`smoke` and `loadtest` talk to a built, running server:

```sh
MCPGW_DATA_DIR=/tmp/mcpgw MCPGW_ROOT_DIR=$PWD bun build/server.js &
bun run smoke     --base-url http://localhost:8080
bun run loadtest  --base-url http://localhost:8080 --sessions 200 --burst 200
```

If the instance was started with `MCPGW_METRICS_TOKEN`, export it for the script too —
otherwise `/metrics` correctly answers `401` and those checks are skipped, not failed.

## Deploy (VPS)

```sh
cd deploy && cp .env.example .env
docker build -f Dockerfile -t mcp-gateway:dev ..    # until a published image exists
MCPGW_IMAGE=mcp-gateway:dev docker compose up -d
```

Three services: Caddy (TLS, SSE-safe proxying), the gateway, and a separate worker so
maintenance never delays a request. `/data` holds the SQLite database and snapshots —
back that volume up.

`deploy/docker-compose.yml` defaults `MCPGW_IMAGE` to `ghcr.io/your-org/mcp-gateway`,
which only exists once the release workflow has run against a repository with a
remote and a published package. Building locally avoids pulling an image that is not
there. Edit the Caddyfile's `mcp.example.com` to your hostname first.

## Client setup

The dashboard issues a key and shows copy-paste config for each client. The generic shape:

```jsonc
// opencode.json / Cursor's .cursor/mcp.json — any Streamable HTTP client
{
	"mcp": {
		"gateway": {
			"type": "http",
			"url": "https://mcp.example.com/mcp",
			"headers": { "Authorization": "Bearer mcpgw_<your-key>" }
		}
	}
}
```

Clients that only speak stdio can bridge through `npx mcp-remote <url> --header "Authorization: Bearer …"`.

## Two databases, one server type

The same MCP server against a dev and a prod database is the normal way to use this:
uniqueness is enforced on the **slug**, never on the command, so two rows may run the
identical binary. The slug becomes the tool namespace, which is what keeps them apart.

| Upstream  | Command                                        | Reference                                     | Clients see      |
| --------- | ---------------------------------------------- | --------------------------------------------- | ---------------- |
| `pg-dev`  | `npx -y @modelcontextprotocol/server-postgres` | `DATABASE_URL → secret:pg-dev__database_url`  | `pg-dev__query`  |
| `pg-prod` | identical                                      | `DATABASE_URL → secret:pg-prod__database_url` | `pg-prod__query` |

Each upstream gets its **own child process** — the pool is keyed by slug, not by command,
so identical binaries are never shared or deduplicated, and editing one connection string
only reconnects that one.

Isolate them with two profiles rather than one profile with deny rules: create `dev-only`
linked to `pg-dev` and `prod-only` linked to `pg-prod`, then issue one API key per profile.
Scope is re-evaluated on every request at both `tools/list` and `tools/call`, so a dev key
that guesses `pg-prod__query` is refused rather than merely hidden from the listing.

Slugs must match `^[a-z0-9-]{2,32}$` — `pg-dev`, not `pg_dev`. Point the prod connection at
a read-only role, and a replica if you have one; the gateway forwards what the model asks
for, it does not know that a query was meant to be read-only.

Credentials live in the vault, referenced as `secret:<name>` (or `${ENV_VAR}` to read the
gateway's own environment). A credential typed into an env line is refused on every path —
dashboard form, template install, manifest import — and `renderManifest()` will refuse to
export a file that contains one, naming the upstream instead of quietly redacting it.

## Project layout

```
src/entrypoints/        Bun server + worker scheduler
src/handle.ts           router: /mcp | /metrics | /healthz | SvelteKit
src/middleware/auth.ts  bearer auth, budgets, origin checks for /mcp
src/lib/server/
  mcp/                  gateway server, session registry, catalog, namespacing
  upstream/             stdio + remote transports, pool, health
  registry/             config snapshot cache, CRUD, manifest import/export
  governance/           api keys, profiles, rate limits, users, secrets, RBAC
  security/             vault (AES-256-GCM), SSRF guard, redaction, argon2
  observability/        metrics, structured log, call log, audit trail
src/routes/             login + /admin dashboard (form actions for all mutations)
drizzle/                SQL migrations
scripts/                migrate, backup, smoke, loadtest
deploy/                 Dockerfile, compose, Caddyfile
docs/                   NFR report
```

## Notes for contributors

- Tests run on `bun:test`, not Vitest: the data layer uses `bun:sqlite`, which Node
  cannot load. Vite runs with `csp: { mode: 'nonce' }` because the CSP otherwise blocks
  SvelteKit's bootstrap script — and only in production, where no test looks.
- The Bun entrypoint bundle and the SvelteKit server bundle are **separate module
  instances**. Anything shared between them must go through the database, not process
  memory — the registry snapshot is a cache keyed on `kv.config_version` for exactly
  this reason.
- A test that migrates in `beforeAll` cannot see a broken first run. Any 485-test suite
  once passed while a fresh clone could not start, because nothing ever looked at a
  database with no tables. When you change startup, readiness, or the registry, add a
  case that starts from an **empty** database file.
- Readiness is a decision, not an exception: `schemaIsPresent()`/`assertMigrated()`
  return a value instead of throwing, `readiness` is injected into the router so the
  routing layer never opens a database, and `/mcp` answers 503 with a hint rather than
  500 with a stack. Keep it that way — a missing schema is an expected state that one
  command fixes.
- stdio children are spawned in a neutral directory (`<dataDir>/workdir`), never the
  gateway's own. A child started in the app directory re-reads the gateway's `.env`
  from disk, which hands every upstream package `MCPGW_MASTER_KEY` no matter how
  carefully the spawn environment is filtered. Set `cwd` explicitly when an upstream
  genuinely needs a project directory.
- Subprocess tests pass `--no-env-file`: bun loads `.env` automatically, so a developer's
  local `.env` would otherwise decide whether a test passes.
