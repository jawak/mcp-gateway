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
bun run db:migrate        # create ./data/mcpgw.db + bootstrap admin
bun run dev               # dashboard + /mcp at http://localhost:5173
```

| Script                                            | Purpose                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `bun run dev`                                     | Vite dev server (dashboard **and** `/mcp`, `/metrics`, `/healthz`) |
| `bun run build` / `bun run start`                 | Production build and Bun server                                    |
| `bun run worker`                                  | Health sweep, session GC, retention, daily snapshot                |
| `bun run verify`                                  | check + lint + test + build (the CI gate)                          |
| `bun run check`                                   | `svelte-kit sync` + `svelte-check`                                 |
| `bun run lint` / `bun run format`                 | ESLint + Prettier                                                  |
| `bun run test` / `test:unit` / `test:integration` | `bun:test`                                                         |
| `bun run db:generate` / `db:migrate` / `db:studio` | Drizzle Kit                                                        |
| `bun run smoke`                                   | Drives a running instance end to end with a real MCP client        |
| `bun run loadtest`                                | Added-latency, concurrency and rate-limit measurement              |

`smoke` and `loadtest` talk to a built, running server:

```sh
MCPGW_DATA_DIR=/tmp/mcpgw MCPGW_ROOT_DIR=$PWD bun build/server.js &
bun run smoke     --base-url http://localhost:8080
bun run loadtest  --base-url http://localhost:8080 --sessions 200 --burst 200
```

## Deploy (VPS)

```sh
cd deploy && cp .env.example .env && docker compose up -d
```

Three services: Caddy (TLS, SSE-safe proxying), the gateway, and a separate worker so
maintenance never delays a request. `/data` holds the SQLite database and snapshots —
back that volume up.

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
