# mcp-gateway

One MCP endpoint for many MCP servers. Point your AI client (Claude Code, Claude Desktop, Cursor, opencode, mcp-remote) at a single URL + API key and get every upstream MCP tool the gateway admin has configured — stdio servers are spawned on the server, so nothing is installed and no credential ever lives on your laptop.

Docs: specs in [`.agents/1-PRD.md`](./.agents/1-PRD.md) → [`.agents/2-TECH-SPEC.md`](./.agents/2-TECH-SPEC.md) → [`.agents/3-TASKS.md`](./.agents/3-TASKS.md)

> Status: under construction (V1.0, tracked in `.agents/3-TASKS.md`).

## Stack

Bun ≥ 1.2 · SvelteKit 2 + adapter-node (monolith, MCP endpoint mounted in a custom `handle` router) · `bun:sqlite` + Drizzle · `@modelcontextprotocol/sdk` 1.30.0 · Tailwind 4 · self-host Docker + Caddy.

## Prerequisites

- Bun ≥ 1.2
- Node ≥ 20 and/or Python (`uvx`) / Docker — only needed for the **upstream** MCP servers you spawn via stdio
- Docker (for the production compose stack)

## Development

```sh
bun install
cp .env.example .env      # set MCPGW_MASTER_KEY + MCPGW_ADMIN_EMAIL/PASSWORD
bun run db:migrate        # create ./data/mcpgw.db + bootstrap admin
bun run dev               # gateway + dashboard at http://localhost:5173
```

| Script                                             | Purpose                               |
| -------------------------------------------------- | ------------------------------------- |
| `bun run dev`                                      | Vite dev server (gateway + dashboard) |
| `bun run build` / `bun run start`                  | Production build and Bun server       |
| `bun run worker`                                   | Health-check / GC / backup scheduler  |
| `bun run check`                                    | `svelte-kit sync` + `svelte-check`    |
| `bun run lint` / `bun run format`                  | Prettier + ESLint                     |
| `bun run test` / `test:unit` / `test:integration`  | Vitest                                |
| `bun run db:generate` / `db:migrate` / `db:studio` | Drizzle Kit                           |

## Deploy (VPS)

```sh
cd deploy && cp .env.example .env && docker compose up -d
```

## Client setup (once the gateway runs)

```jsonc
// opencode.json / Cursor mcp.json — same shape for any Streamable HTTP client
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

## Project layout

```
src/entrypoints/   Bun server + scheduler
src/handle.ts      router: /mcp | /metrics | /healthz | SvelteKit
src/lib/server/    mcp, upstream, registry, governance, security, observability
src/routes/        login + /admin dashboard (form actions for all mutations)
drizzle/           SQL migrations   templates/  bundled upstream templates
deploy/            Dockerfile, docker-compose.yml, Caddyfile
```
