# Tech Spec: mcp-gateway

> **Status:** Ready for Tasking · **Versi:** 1.0 · **Tanggal:** 2026-09-21
> **Sumber:** `.agents/1-PRD.md` (PRD v1.0)
> **Stack:** Bun ≥1.2 (monolith) · SvelteKit 2 + adapter-node · `bun:sqlite` + Drizzle · `@modelcontextprotocol/sdk` 1.30.0 · Self-host Docker/VPS

## Keputusan Teknis yang Sudah Dikonfirmasi

| Keputusan | Pilihan |
|---|---|
| Topologi | **Monolith**: 1 proses Bun, SvelteKit + adapter-node, MCP endpoint di-mount lewat custom `handle` hook |
| Database | **`bun:sqlite` (WAL) + Drizzle ORM** + drizzle-kit untuk migrasi |
| Hosting V1 | **Self-host Docker di VPS** (gateway + Caddy TLS, volume untuk SQLite & secret file) |
| Akun admin | **1 admin bootstrap via env var** + manajemen user (`admin`/`viewer`) lewat UI |

## Verifikasi Dependency (sudah dicek di node_modules)

| Fakta | Detail |
|---|---|
| `@modelcontextprotocol/sdk@1.30.0` | `dist/esm/server/webStandardStreamableHttp.js` **ada** → `WebStandardStreamableHTTPServerTransport` |
| Transport opsi | `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`, `enableJsonResponse`, `eventStore` (resumability), `keepAliveMs` (default 15000), `retryInterval` |
| `handleRequest` | `handleRequest(req: Request, resInit?, opts?: { parsedBody?, authInfo? })` → `Response`; **`authInfo` dipakai menyuntik identitas API key ke request handler** |
| Client transport | `client/streamableHttp.js` (`StreamableHTTPClientTransport`), `client/webStandardStreamableHttp.js`, `client/stdio.js` (`StdioClientTransport`) |
| DNS-rebinding opsi internal | ditandai `@deprecated` → validasi Origin/Host dilakukan sendiri di middleware |
| Versi terverifikasi | SvelteKit 2.70.3 · adapter-node 5.5.7 · Svelte 5.57.1 · Hono 4.13.8 (tidak dipakai di V1) |

---

# BAGIAN 1: Tech Stack & Arsitektur

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Bun (HTTP server, spawn, test, bundler) | ≥ 1.2 |
| Web framework | SvelteKit + adapter-node (router di custom `handle`) | 2.70.3 / 5.5.7 |
| Language | TypeScript (strict) | 5.x |
| UI | Svelte 5 (runes) | 5.57.1 |
| Styling | Tailwind CSS 4 + Flowbite/DaisyUI (dark/light) | 4.x |
| State | Svelte runes + SvelteKit `load`/`$derived` (tanpa lib eksternal) | — |
| MCP protocol | `@modelcontextprotocol/sdk` (server + client) | 1.30.0 |
| Database | SQLite via `bun:sqlite`, mode WAL | Bun built-in |
| ORM | Drizzle ORM + drizzle-kit | latest |
| Validation | Zod (sekaligus sumber JSON Schema input tool) | 3.x |
| Auth admin | argon2id + session cookie signed (`HttpOnly Secure SameSite=Lax`) | — |
| Auth MCP | Bearer API key (hash SHA-256) | — |
| Secrets | AES-256-GCM (`node:crypto`) dari `MCPGW_MASTER_KEY` | — |
| Charts / Editor | Chart.js · CodeMirror 6 (YAML) | — |
| Metrics / Log | `prom-client` · `pino` | — |
| Infra | Docker multi-stage · Caddy · GitHub Actions | — |
| Caching | In-memory (catalog per profil, LRU upstream pool) — Redis → v2 | — |

## Arsitektur Sistem

```
Klien MCP (Claude Code / Cursor / opencode / mcp-remote)
   │  Authorization: Bearer mcpgw_…                       browser (admin)
   ▼                                                          │
┌──────────────── Bun.serve() :8080 ──────────────────────────▼─────────────┐
│ fetch(req) → src/handle.ts                                                 │
│  /mcp      → authMiddleware → McpGatewayServer                            │
│              └ WebStandardStreamableHTTPServerTransport                   │
│  /metrics  → prom-client (Bearer MCPGW_METRICS_TOKEN)                     │
│  /healthz  → { ok, upstreams, sessions, version }                         │
│  /*        → SvelteKit handler (dashboard + form actions)                 │
│                                                                           │
│ Core: registry · catalog(namespacing+filter) · router · pool(stdio/http)  │
│       health · ratelimit · vault · audit · usage · manifest               │
│ Workers: healthCheck loop 30s · GC (session, log, quota) · backup harian  │
└──────┬──────────────────────────┬─────────────────────────┬───────────────┘
       │ bun:sqlite (WAL)         │ stdio spawn             │ HTTPS
       ▼                          ▼                         ▼
  ./data/mcpgw.db          upstream lokal            upstream remote
  ./data/backups           (npx / uvx / docker)      Streamable HTTP / SSE
```

**Prinsip degradasi:** upstream `down`/`unconfigured` hanya dikeluarkan dari catalog; gateway tetap 200. Satu upstream tidak pernah memblokir upstream lain (timeout + semaphore per upstream).

## Struktur Folder (best practice SvelteKit + Bun)

```
mcp-gateway/
├─ src/
│  ├─ entrypoints/
│  │  ├─ server.ts            # migrate → Bun.serve({ fetch: handleFetch })
│  │  └─ worker.ts            # scheduler: health check, GC, backup
│  ├─ handle.ts               # router: mcp | metrics | healthz | sveltekit
│  ├─ hooks.server.ts         # request-id, CSP, auth admin, CSRF, rate-limit admin
│  ├─ lib/
│  │  ├─ server/
│  │  │  ├─ db/{index.ts,schema.ts,migrate.ts,seed.ts}
│  │  │  ├─ mcp/{gateway.ts,session.ts,aggregator.ts,namespacing.ts,
│  │  │  │        resources.ts,prompts.ts,event-store.ts,upstream-ctx.ts}
│  │  │  ├─ upstream/{stdio.ts,remote-http.ts,pool.ts,health.ts,ssrf-fetch.ts}
│  │  │  ├─ registry/{index.ts,manifest.ts,events.ts}
│  │  │  ├─ governance/{apikey.ts,profile.ts,ratelimit.ts,rbac.ts}
│  │  │  ├─ security/{vault.ts,env-resolve.ts,password.ts,redact.ts}
│  │  │  ├─ observability/{usage.ts,audit.ts,metrics.ts,logger.ts}
│  │  │  └─ templates/index.ts
│  │  └─ shared/{schemas.ts,types.ts,glob.ts,ids.ts,snippet.ts}
│  ├─ routes/
│  │  ├─ +layout.svelte  +layout.server.ts  +error.svelte
│  │  ├─ login/+page.svelte +page.server.ts
│  │  └─ admin/
│  │     ├─ +layout.svelte +layout.server.ts   # shell, nav, guard role
│  │     ├─ +page.svelte +page.server.ts       # dashboard
│  │     ├─ upstreams/+page.svelte
│  │     ├─ upstreams/new/+page.server.ts      # form + template picker
│  │     ├─ upstreams/[slug]/+page.svelte +page.server.ts
│  │     ├─ profiles/+page.server.ts  profiles/[id]/+page.server.ts
│  │     ├─ keys/+page.server.ts      keys/[id]/+page.server.ts
│  │     ├─ logs/+page.svelte +page.server.ts
│  │     ├─ usage/+page.svelte +page.server.ts
│  │     ├─ templates/+page.server.ts
│  │     ├─ manifest/+page.svelte +page.server.ts
│  │     ├─ users/+page.server.ts
│  │     └─ settings/+page.server.ts
│  └─ app.d.ts
├─ drizzle/                                     # SQL migrations
├─ templates/                                   # katalog bundled (≥10 JSON)
├─ tests/{unit,integration,e2e}/
├─ deploy/{Dockerfile,docker-compose.yml,Caddyfile,.dockerignore}
├─ scripts/{backup.ts,smoke.ts}
├─ gateway.example.yaml  .env.example
├─ svelte.config.js  vite.config.ts  drizzle.config.ts
└─ package.json
```

## Justifikasi

- **Bun:** satu runtime untuk HTTP, `bun:sqlite` (tanpa native dep), spawn child process stdio, test runner, dan bundler — ideal untuk gateway I/O-bound 1.000 SSE session.
- **Monolith SvelteKit + custom `handle`:** MCP endpoint, `/metrics`, dan dashboard dalam 1 proses & 1 origin (tanpa CORS, tanpa internal auth). Router di `handle.ts` membuat `/mcp` memakai transport Web-standard tanpa menyentuh `node:http`.
- **`WebStandardStreamableHTTPServerTransport`:** satu-satunya transport SDK yang native `Request → Response` (Bun/SvelteKit). `authInfo` = jalur bersih untuk scope + audit; `eventStore` = resumability (FR-10).
- **bun:sqlite + Drizzle:** data kecil tapi relasional & butuh transaksi → SQLite WAL cukup; Drizzle memberi type-safety + migrasi versioned, dan jalur migrasi ke Postgres (v2 HA) tetap terbuka.
- **Docker + Caddy:** stdio spawn (shell/Node/Python/Docker di host) mustahil di serverless; Caddy memberi ACME/TLS/HSTS tanpa config nginx.
- **Tanpa Redis di V1:** catalog & pool koneksi bersifat proses-lokal; ekternalisasi state dilakukan bersamaan dengan HA multi-replica (v2).

---

# BAGIAN 2: Database Design

## Ringkasan

| Item | Detail |
|---|---|
| Database | SQLite 3 (file `./data/mcpgw.db`), `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON` |
| Driver/ORM | `bun:sqlite` + Drizzle ORM (`drizzle-orm/bun-sqlite`) |
| Pendekatan | Relational; config sebagai JSON kolom (bukan EAV) |
| Migrasi | `drizzle-kit generate` → SQL di `drizzle/`; dijalankan `src/lib/server/db/migrate.ts` saat boot **server** (worker menunggu) |
| ID | `TEXT` UUIDv7 (time-sortable) dari `lib/shared/ids.ts` |
| Waktu | ISO-8601 UTC TEXT; index selalu bersama kolom waktu |
| Retensi | `tool_calls` detail 30 hari · `audit_log` 180 hari · `upstream_health` 7 hari (cron GC) |

## Entity Overview

| Entity | Key Fields | Relasi |
|---|---|---|
| `users` | id, email, password_hash, role(`admin`\|`viewer`), status, failed_attempts, locked_until | → web_sessions |
| `web_sessions` | id, user_id, expires_at, revoked_at | → users |
| `upstreams` | id, slug, name, transport(`stdio`\|`http`), enabled, `connection` JSON, `env_refs` JSON, headers_ref, caps/tools_count/status JSON, timeout_ms, `pin`(`pinned`\|`lazy`), last_error | → profile_upstreams, tool_calls, upstream_health |
| `secret_refs` | id, name, cipher, iv, tag, key_ver | ← upstreams.env_refs (by name), ← upstreams.headers_ref |
| `upstream_health` | id, upstream_id, status, latency_ms, ok, error, checked_at | → upstreams |
| `profiles` | id, name, rate_limit_rpm, daily_call_quota, max_concurrency, default_timeout_ms | → profile_upstreams, api_keys |
| `profile_upstreams` | profile_id, upstream_id, allow_globs[], deny_globs[] | → profiles, upstreams |
| `api_keys` | id, key_hash(uniq), key_prefix, key_tail4, name, profile_id, status, expires_at, last_used_at, created_by | → profiles, mcp_sessions, tool_calls |
| `mcp_sessions` | id(=Mcp-Session-Id), api_key_id, profile_id, protocol_version, client_info JSON, last_seen_at, closed_at | → api_keys |
| `tool_calls` | id, request_id, api_key_id, upstream_id, tool, status(`ok`\|`error`\|`timeout`\|`rejected`\|`rate_limited`), duration_ms, req_bytes, res_bytes, error, debug JSON, called_at | → api_keys, upstreams |
| `usage_hourly` | bucket_hour, api_key_id, upstream_id, tool, calls, errors, p50_ms, p95_ms | agregasi dari tool_calls |
| `audit_log` | id, actor_type(`user`\|`api_key`\|`system`), actor_id, action, target_type, target_id, ip, request_id, meta JSON, created_at | append-only |
| `kv` | key, value — meta: `schema_version`, `quota_day`, `quota_used`, `last_backup_at` | — |
| `templates_applied` | template_id, upstream_id, applied_at, applied_by | → upstreams |

## Skema (referensi implementasi)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT, user_agent TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);

CREATE TABLE upstreams (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio','http')),
  enabled INTEGER NOT NULL DEFAULT 1,
  connection JSON NOT NULL,          -- {command,args,cwd} | {url,authStyle,authName}
  env_refs JSON NOT NULL DEFAULT '{}',-- {ENV_NAME:"secret-ref-name"}
  headers_ref TEXT,                  -- secret_ref name (upstream remote)
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  pin TEXT NOT NULL DEFAULT 'pinned' CHECK (pin IN ('pinned','lazy')),
  caps JSON, tools_count INTEGER NOT NULL DEFAULT 0, status JSON,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE secret_refs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, cipher TEXT NOT NULL,
  iv TEXT NOT NULL, tag TEXT NOT NULL, key_ver INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, rotated_at TEXT);

CREATE TABLE upstream_health (
  id TEXT PRIMARY KEY, upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  status TEXT NOT NULL, latency_ms INTEGER, ok INTEGER NOT NULL,
  error TEXT, checked_at TEXT NOT NULL);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  rate_limit_rpm INTEGER NOT NULL DEFAULT 120,
  daily_call_quota INTEGER NOT NULL DEFAULT 1000,
  max_concurrency INTEGER NOT NULL DEFAULT 10,
  default_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE profile_upstreams (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  allow_globs JSON NOT NULL DEFAULT '["*"]', deny_globs JSON NOT NULL DEFAULT '[]',
  PRIMARY KEY (profile_id, upstream_id));

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL, key_tail4 TEXT NOT NULL,
  name TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profiles(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  ip_allowlist JSON, expires_at TEXT, last_used_at TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL,
  rotated_from_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL, revoked_at TEXT);

CREATE TABLE mcp_sessions (
  id TEXT PRIMARY KEY, api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id), protocol_version TEXT,
  client_info JSON, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, closed_at TEXT);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  upstream_id TEXT REFERENCES upstreams(id) ON DELETE SET NULL,
  tool TEXT NOT NULL, upstream_tool TEXT,
  status TEXT NOT NULL, duration_ms INTEGER NOT NULL,
  req_bytes INTEGER, res_bytes INTEGER, error TEXT, debug JSON,
  called_at TEXT NOT NULL);

CREATE TABLE usage_hourly (
  bucket_hour TEXT NOT NULL, api_key_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL, tool TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
  p50_ms INTEGER, p95_ms INTEGER, PRIMARY KEY (bucket_hour, api_key_id, upstream_id, tool));

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT,
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT,
  ip TEXT, request_id TEXT, meta JSON, created_at TEXT NOT NULL);
-- tanpa UPDATE/DELETE via API (append-only), write hanya lewat observability/audit.ts

CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

## Index Strategy

- `upstream_health(upstream_id, checked_at DESC)` — timeline & status terkini
- `tool_calls(called_at)`, `(api_key_id, called_at)`, `(upstream_id, called_at)`, `(status, called_at)`, `(request_id)` — log UI, usage per key/upstream, trace 1 request
- `api_keys(key_hash)` (UNIQUE, jalur auth tiap request), `(profile_id)`, `(status, expires_at)`
- `profile_upstreams(upstream_id)` — reverse lookup "profil mana yang pakai upstream ini" (FR-15 guard)
- `mcp_sessions(api_key_id)`, `(last_seen_at)` — GC + revoke-close
- `web_sessions(user_id)`, `(expires_at)`
- `audit_log(created_at)`, `(actor_id, created_at)`, `(target_id)` — audit timeline & CSV export
- `usage_hourly` PK sudah time-first → query dashboard tanpa index tambahan

## Data Flow

1. **Boot:** `server.ts` → migrate → `registry.load()` baca `upstreams`+`profiles`+`profile_upstreams` ke memori → `pool.warm('pinned')` spawn upstream pinned → worker mulai health loop.
2. **Koneksi klien:** Bearer key → `api_keys.key_hash` → profil → scope (upstream + globs) → baris `mcp_sessions`.
3. **`tools/list`:** catalog (cache per profil) fan-out `tools/list` ke upstream dalam scope → namespacing → filter glob → respons + `_meta`.
4. **`tools/call`:** nama ternamespace → lookup map → upstream → `pool.get(upstream)` (spawn/reuse) → forward → baris `tool_calls` → agregat `usage_hourly` (cron menit-an) → `audit_log` hanya untuk aksi admin.
5. **Secret:** UI menyimpan plaintext ke `secret_refs` (AES-GCM) → `upstreams.env_refs` hanya menyimpan **nama referensi** → resolve saat spawn (tidak pernah keluar dari proses).
6. **Manifest:** YAML ⇄ registry via diff + transaksi; secret tetap `${ENV}` (tidak pernah dieksport sebagai nilai).

---

# BAGIAN 3: Interface Design

Stack monolith SvelteKit → 3 jenis antarmuka: **endpoint MCP**, **REST read-only** (untuk UI/machine), dan **SvelteKit form actions** (semua mutation admin, CSRF-guarded).

## Endpoint HTTP (non-SvelteKit, ditangani `src/handle.ts`)

| Method | Path | Description | Auth |
|---|---|---|---|
| POST | `/mcp` | JSON-RPC: `initialize`, `tools/list`, `tools/call`, `resources/*`, `prompts/*`, notifications | Bearer API key |
| GET | `/mcp` | SSE stream server→client (resumable via `Last-Event-ID`) | Bearer API key |
| DELETE | `/mcp` | Tutup sesi (`Mcp-Session-Id`) | Bearer API key |
| GET | `/metrics` | Prometheus text (FR-18) | Bearer `MCPGW_METRICS_TOKEN` |
| GET | `/healthz` | `{ ok, version, upstreams: {healthy,down}, sessions }` | No |

## REST API (SvelteKit `+server.ts`, read-only + export)

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/api/v1/upstreams` | Daftar upstream + status health | Admin session |
| GET | `/api/v1/upstreams/:slug` | Detail upstream (secret ter-mask) | Admin session |
| GET | `/api/v1/usage?from&to&key&upstream` | Agregat usage/hourly untuk chart | Admin session |
| GET | `/api/v1/logs?cursor&status&key&tool` | Log tool call terpaginasi (cursor) | Admin session |
| GET | `/api/v1/logs/export.csv` | Export CSV (limit 100k baris) | Admin session |
| GET | `/api/v1/audit?cursor` | Timeline audit | Admin session |
| GET | `/api/v1/keys/:id/snippet?client=claude\|cursor\|opencode\|generic` | Snippet konfigurasi klien (FR-01/US-01) | Admin session (atau owner key) |
| GET | `/manifest` | Export `gateway.yaml` (FR-07) | Admin session |

## Form Actions (mutations admin — `+page.server.ts`)

| Action | Path | Description | Auth |
|---|---|---|---|
| POST | `/login` `default` | Login admin (FR-04) | No |
| POST | `/login` `logout` | Putus session | Yes |
| POST | `/admin/upstreams/new` `createStdio` | Tambah upstream stdio + handshake test (FR-05) | admin |
| POST | `/admin/upstreams/new` `createHttp` | Tambah upstream remote (FR-06) | admin |
| POST | `/admin/upstreams/new` `fromTemplate` | Buat upstream dari template + smoke test (FR-20) | admin |
| POST | `/admin/upstreams/[slug]` `update` / `setEnabled` / `remove` / `checkNow` / `reconnect` / `rotateSecret` | CRUD & operasional upstream (FR-08/09) | admin |
| POST | `/admin/profiles/new` `create` · `/admin/profiles/[id]` `update` / `remove` / `toggleUpstream` / `setGlobs` | Manajemen profil & filter tool (FR-14/15) | admin |
| POST | `/admin/keys/new` `create` | Buat API key → tampilkan plaintext **sekali** (FR-02) | admin |
| POST | `/admin/keys/[id]` `rotate` / `revoke` / `suspend` / `resume` / `setIpAllowlist` | Siklus hidup key (FR-03) | admin |
| POST | `/admin/manifest` `import` / `export` | Import/eksport manifest YAML (FR-07) | admin |
| POST | `/admin/users/new` `create` · `/admin/users/[id]` `setRole` / `disable` / `resetPassword` | Manajemen user admin (RBAC) | admin |
| POST | `/admin/settings` `setDefaults` | Default timeout, health interval, retensi, flags debug | admin |
| Load | `/admin`, `/admin/usage`, `/admin/logs`, `/admin/upstreams`, `/admin/keys` | Data dashboard (server-side, pagination + filter) | viewer+ |

## Kontrak Internal (kontrak unit-test)

| Modul | Kontrak |
|---|---|
| `namespacing.build(upstreams, tools)` | → `{ list: Tool[], byName: Map<gname, {upstreamSlug, originalName}> }`; deterministik; collision = error |
| `namespacing.qualify(slug, name)` / `.split(gname)` | simetris: `split(qualify(x)) === x` |
| `aggregator.getCatalog(profileId)` | cache hit < 100 ms; invalidasi via `registry.events` |
| `ratelimit.take(keyId, cost)` | → `{ ok: boolean, retryAfterMs?, remaining }` |
| `vault.seal/open` | round-trip; GCM tag salah → throw; tanpa plaintext di log |
| `ssrfFetch(url)` | blokir non-https (kecuali localhost), link-local, metadata IP; dump → throw |
| `glob.match(patterns, name)` | deny menang atas allow; `*` = semua |
| `manifest.parseYAML / toYAML / diff` | idempoten; secret plaintext → `ValidationError` |
| `health.evaluate(prev, results)` | 3x gagal → `down`; 2x sukses → `healthy`; backoff ≤ 5 menit |
| `apikey.verify(headerValue)` | → `{ ok, key?, reason }` tanpa timing leak |

---

# BAGIAN 4: Alur Logika & Business Rules

## Alur 1 — Koneksi klien & auth (FR-01, FR-10)

1. Klien `POST /mcp` `initialize` + `Authorization: Bearer mcpgw_…`.
2. `handle.ts` → `authMiddleware`: ambil bearer → `key_hash = sha256(key)` → lookup `api_keys` → cek `status='active'`, `expires_at`, `ip_allowlist`.
3. Gagal: `401` (invalid/expired/revoked) / `403` (suspended) dengan `WWW-Authenticate` + `X-Request-Id`. 10 kegagalan dari 1 IP dalam 60 s → `429` backoff 60 s (peta memori).
4. `ratelimit.take(keyId)` (token bucket `rate_limit_rpm`) → gagal `429` + `Retry-After` + `X-RateLimit-Remaining`.
5. Sukses → teruskan `Request` ke `WebStandardStreamableHTTPServerTransport.handleRequest(req, undefined, { authInfo: { ...keyMeta } })`; transport membuat `Mcp-Session-Id` (`sessionIdGenerator = uuidv7`) → insert `mcp_sessions`; `last_used_at` di-update (debounce 30 s).
6. Response `initialize`: protokol result sesuai `protocolVersion` klien (dapat dinegosiasi ke `2025-06-18` / `2025-03-26` / `2024-11-05`), `capabilities: { tools:{listChanged:true}, resources:{subscribe:list-dependent}, prompts:{} }`, `serverInfo: { name: "mcp-gateway", version }`.
7. Sesi idle > `MCPGW_SESSION_TTL_MIN` (30) di-GC oleh worker: tutup transport + `closed_at`; `DELETE /mcp` → `onsessionclosed` → baris ditutup.
8. Revoke key (FR-03) → worker/inline menutup semua transport sesi milik key ≤ 5 s (event `key.revoked`).

## Alur 2 — `tools/list` (FR-11, FR-14)

1. Handler `tools/list` baca `authInfo` → scope profil.
2. `getCatalog(profileId)`: jika cache valid (TTL 60 s, invalidasi by event) → pakai; jika tidak → fan-out paralel `tools/list` ke upstream enabled+healthy dalam profil (timeout `min(timeout_ms, 15000)`), upstream gagal/timeout **dilewati** dan dilaporkan ke health.
3. Tiap tool: `qualify(slug, tool.name)` → `description` upstream diwarisi apa adanya (gateway tidak mengubah teks), `_meta = { upstream, upstreamTool, upstreamVersion, health }`.
4. Filter glob profil (deny > allow) dievaluasi ulang saat request (bukan hanya saat cache ditulis).
5. Output: `nextCursor` bila klien minta paginasi (gateway meneruskan cursor per-upstream secara berurutan, bukan menggabungkan cursor).
6. Cache dipanjangkan dengan `Etag`-style hash → tidak mengubah protokol MCP, hanya internal.

## Alur 3 — `tools/call` (FR-12, FR-16, FR-18, FR-19)

1. `tools/call` dengan `name = "github__create_pr"`.
2. `byName.get(name)` → tidak ada → JSON-RPC error `-32602` `unknown tool` (log `status='rejected'`).
3. Cek scope profil + denylist glob → di luar scope → `-32603` `tool not allowed for this key`.
4. `ratelimit.take(keyId)` + cek `daily_call_quota` (di `kv`, reset saat `quota_day` berubah) + semaphore `max_concurrency` per key dan per upstream → `429`/`-32005 rate limited` + `Retry-After`.
5. `pool.get(upstream)`: `pinned` → koneksi persisten (auto-restart dengan backoff); `lazy` → spawn on-demand, `idleTtl` 10 menit, LRU maks `MCPGW_MAX_LIVE_UPSTREAMS`.
6. `client.callTool({ name: originalName, arguments })` pass-through (tanpa modifikasi argumen), timeout `min(upstream.timeout_ms, 300)`; error transport (EPIPE/timeout/spawn fail) → **retry 1x** dengan koneksi baru; `isError: true` dari upstream **bukan** error transport (tidak di-retry).
7. Progres: bila request punya `progressToken`, teruskan `notifications/progress` upstream ke SSE klien.
8. Tulis `tool_calls` (status, duration, bytes, error); update `prom-client` histogram/counter; `X-Request-Id` dikembalikan di header & disimpan di `tool_calls.request_id`.
9. Payload request/response **tidak** disimpan kecuali `debug=on` (maks `MCPGW_DEBUG_MAX_BYTES`, redaksi via `security/redact.ts`).

## Alur 4 — Health check & circuit breaker (FR-08)

1. Worker loop tiap `MCPGW_HEALTH_INTERVAL_S` (30): untuk tiap upstream `enabled` — lewati jika `lazy` dan tidak ada koneksi hidup (cek via handshake ringan saat dibutuhkan saja), atau sedang dalam backoff.
2. Probe: `ping` bila capability ada, selain itu `tools/list` (timeout 5 s). stdio: bila child mati → status `down`, `last_error` = exit code.
3. Transisi: 3× gagal beruntun → `down` + keluarkan dari catalog (invalidasi cache profil terkait); 2× sukses → `healthy`. Interval probe upstream `down` = `30s × 2^n` dibatasi 5 menit.
4. Status `degraded` = probe sukses tapi latensi > 50% dari `timeout_ms`.
5. Env var wajib upstream tidak ada → `unconfigured` (tidak pernah spawn), pesan error menyebut nama env-nya.
6. Setiap probe → baris `upstream_health` (retensi 7 hari) + gauge `mcp_upstream_healthy`.

## Alur 5 — API key: create → use → revoke (FR-02, FR-03)

1. Form: nama, profil (wajib ≥1 profil aktif), expiry (default 90 hari), IP allowlist opsional.
2. `randomBytes(32)` → `plain = "mcpgw_" + base58(bytes)`; simpan `sha256(plain)`, `key_prefix` (10 char depan), `key_tail4`.
3. Respons form **sekali**: plaintext + snippet per klien (`lib/shared/snippet.ts` untuk Claude Code, Cursor, opencode, generic HTTP/`mcp-remote`) — tombol copy.
4. Key tak pernah bisa dibaca ulang (field `cipher` tidak ada untuk key — hanya hash).
5. Revoke: `status='revoked'`, `revoked_at`, event → sesi ditutup ≤ 5 s → `audit_log`. Rotate: salin metadata + scope ke baris baru, yang lama `revoked`, `rotated_from_id` terisi (profil/scope identik).

## Alur 6 — Login admin (FR-04, RBAC)

1. `POST /login` → ambil user by email → `argon2.verify` (konstanta-time terhadap email tak dikenal via dummy hash).
2. Gagal: `failed_attempts++`; ≥ 5 → `locked_until = now + 15m`; pesan generik (tanpa menyebut email ada/tidak).
3. Sukses: reset counter, insert `web_sessions`, set cookie `mcpgw_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`) berisi session id (random, bukan data user).
4. `hooks.server.ts`: setiap request `/admin/*` → load session + user → `locals.user`; `viewer` hanya boleh GET (mutating form action → `error 403`).
5. Mutasi memakai form action SvelteKit → `config.csrf = checkOrigin` (built-in) → CSRF tertangani tanpa library tambahan.

## Alur 7 — Import manifest YAML (FR-07)

1. Upload/paste YAML → `yaml.parse` → `zod` (`shared/schemas.ts`).
2. **Secret scan**: nilai `env`/`headers` yang bukan `${ENV}` atau `secret:<name>` → `ValidationError` (mis. terdeteksi pola `ghp_…`) → import dibatalkan.
3. `diff(manifest, registry)` → `{ added, updated, removed, unchanged }`; `removed` = **disable**, bukan hard-delete (aman untuk key aktif).
4. Transaksi: upsert upstream + profil + `profile_upstreams` → commit → emit `registry.changed` → invalidasi catalog & pool → `audit_log`.
5. Output diff + daftar upstream yang `unconfigured` (butuh env var) → tautan "isi secret" di UI.
6. Idempoten: import file yang sama 2× → `unchanged` semua.

## Alur 8 — Template → upstream (FR-20)

1. `/admin/templates` menampilkan `templates/*.json` (nama, ikon, ringkasan, transport, field kredensial yang dibutuhkan, contoh `command`/`url`, docs URL) — **tanpa token**.
2. Form mengisi field → field secret langsung masuk `secret_refs` (nama auto `<slug>__<FIELD>`), upstream menyimpan referensi.
3. Panggil `createStdio`/`createHttp` → smoke test `tools/list` → tampilkan jumlah tool yang terdeteksi; gagal → upstream tetap tersimpan `enabled=0` dengan `last_error` actionable.

## Business Rules (dari PRD)

| # | Rule |
|---|---|
| BR-01 | Nama tool global = `<slug>__<tool>`; hasil harus lolos `^[A-Za-z0-9_.-]{1,64}$`. Bila > 64: `slug[..12]-<b32(sha1(name),6)>__<name[..31]-<hash6>>`; collision 2 nama → upstream kedua ditolak dengan error eksplisit (bukan rename diam-diam). |
| BR-02 | Slug upstream: `^[a-z0-9-]{2,32}$`, unik, tidak dapat diubah setelah dibuat (karena menjadi bagian nama tool). |
| BR-03 | Denylist glob menang atas allowlist; glob pattern dipakai untuk tool, resource URI, dan prompt name. |
| BR-04 | Upstream `down`/`unconfigured`/`disabled` tidak muncul di catalog; `tools/call` ke tool upstream tersebut → error `upstream unavailable`. |
| BR-05 | Timeout call default 60 s, batas atas 300 s per upstream; payload request/response maks 1 MB. |
| BR-06 | Rate limit default 120 req/menit, 1.000 tool-call/hari, konkurensi 10 per key. |
| BR-07 | API key: plaintext hanya saat create/rotate; hanya hash yang disimpan; revoked permanen. |
| BR-08 | Profil yang masih dipakai ≥ 1 key aktif (non-revoked) tidak bisa dihapus. |
| BR-09 | Secret selalu via referensi (`${Env}` / `secret:<name>`); plaintext di YAML ditolak; secret tidak pernah dikirim ke klien atau ditulis ke log. |
| BR-10 | `viewer` tidak bisa mutasi; `admin` bisa; semua mutasi → `audit_log` (append-only, tanpa endpoint hapus). |
| BR-11 | Login 5× gagal → blokir 15 menit; auth key 10× gagal/IP/menit → backoff 60 s. |
| BR-12 | Hot reload ≤ 500 ms: perubahan registry tidak me-restart upstream lain; `tools/call` yang sedang berjalan diberi grace 30 s sebelum koneksi ditutup. |
| BR-13 | `role: viewer` dan sesi admin kedaluwarsa 12 jam tanpa aktivitas; sesi MCP kedaluwarsa 30 menit idle. |
| BR-14 | Resource/prompt upstream tanpa capability terkait di-skip; `resources/subscribe` dideklarasikan sesuai upstream (all-or-nothing di V1). |
| BR-15 | Argumen & hasil tool bersifat pass-through; gateway hanya menambah `_meta` (tidak mengubah `content`). |

---

# BAGIAN 5: Keamanan, Performa, & Deployment

## Keamanan

- **Secrets:** `MCPGW_MASTER_KEY` (32 byte, env) → `HKDF-SHA256(master, salt=per-record)` → AES-256-GCM; simpan `cipher/iv/tag/key_ver`. Rotasi: decrypt `key_ver` lama → seal versi baru (job后台). API key & password tidak pernah disimpan terenkripsi (hash only).
- **Env sanitization saat spawn stdio:** child hanya menerima `PATH`, `HOME`, `LANG`, `NODE_ENV`, `TMPDIR` + env yang dipetakan eksplisit — `MCPGW_MASTER_KEY`/DSN **tidak** diwariskan ke upstream.
- **Auth & sesi:** argon2id (`m=64MB,t=3,p=4`); cookie `HttpOnly Secure SameSite=Lax`, `expires`; CSRF via `config.csrf` SvelteKit; Bearer untuk `/mcp` (tidak bergantung cookie → tidak bisa CSRF).
- **SSRF guard:** `ssrfFetch` menolak `http://` kecuali localhost, resolves → blokir `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254.169.254`, `::1`, `fe80::/10`; redirect = blokir (kecuali di-whitelist); timeout connect 5 s.
- **Isolasi scope:** validasi kepemilikan tool→profil terjadi di **setiap** `tools/call`/`resources/read`/`prompts/get` (bukan hanya `list`); uji integrasi wajib: key A memanggil tool milik profil B → `not allowed`.
- **Transport:** TLS di Caddy (ACME otomatis, HSTS 1 tahun, HTTP→301). `MCPGW_TRUST_PROXY=true` → percaya `X-Forwarded-For` hanya 1 hop dari Caddy (untuk IP allowlist & rate limit akurat).
- **Headers:** `Content-Security-Policy` (self + inline-style Tailwind), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` minimal; `/mcp` menolak `Origin` browser yang bukan `MCPGW_PUBLIC_URL` (DNS-rebinding/CSRF-adjacent).
- **Audit & redaksi:** `security/redact.ts` menutup pola token umum (`ghp_`, `github_pat_`, `xoxb-`, `sk-`, JWT, `Bearer …`) di `tool_calls.error`, log pino, dan UI.
- **Input & DoS:** Zod untuk semua form/JSON; body limit 1 MB (`maxBodySize` Bun); pagination cursor (tanpa offset besar); rate limit admin login per email+IP; `bun:sqlite` prepared statements (anti SQLi).
- **Supply chain:** `bun install --frozen-lockfile`, Dependabot/Renovate, image non-root (`USER bun`), `read_only` rootfs + volume `/data`, `no-new-privileges`.
- **Secret hygiene:** `.env` di `.gitignore`, `scripts/` tidak menyimpan kredensial, contoh memakai placeholder.

## Performa

- **SQLite:** WAL + `busy_timeout=5000`, write via transaksi batch (tool_calls buffer 100 baris/500 ms flush); kolom besar (debug) di luar jalur hot.
- **Prepared statements** di-cache (Drizzle `cache: true` / statement reuse Bun).
- **Catalog cache** per profil: TTL 60 s + invalidasi event → `tools/list` cache hit < 100 ms.
- **Connection pool:** upstream `pinned` warm (handshake 1x) → `tools/call` added latency hanya JSON-RPC hop; `lazy` + LRU + `idleTtl` untuk menekan RAM (50 stdio tidak sekaligus).
- **Fan-out paralel** (`Promise.allSettled`) dengan timeout individual; upstream lambat tidak menyeret catalog.
- **SSE:** `keepAliveMs: 15000` (hindari proxy idle-cut), `EventStore` di memori berkapasitas 1.000 event/sesi (resumability) — dibatasi agar tidak membocorkan RAM.
- **Metric target:** TTFB `initialize` < 300 ms · `tools/list` cache miss (20 upstream) < 1,5 s · added latency p50 < 100 ms / p95 < 300 ms · 1.000 sesi SSE + 200 call/s di 2 vCPU.
- **Graceful:** `gracefulShutdown({ timeout: 30000 })` → stop terima sesi baru, selesaikan `tools/call`, matikan child stdio, tutup DB.
- **Uji beban:** `k6`/`autocannon` di CI (artifact, bukan gate) + `tests/e2e` dengan `npx @modelcontextprotocol/inspector --cli` terhadap gateway nyata.

## Deployment (VPS + Docker)

`deploy/Dockerfile` (multi-stage, image base dengan Node agar `npx` upstream jalan):

```dockerfile
FROM ohse/base:node22-bun1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build                       # vite build + svelte-kit sync

FROM ohse/base:node22-bun1 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*      # opsional: uvx/python upstream
WORKDIR /app
ENV NODE_ENV=production PORT=8080 MCPGW_DATA_DIR=/data
COPY --from=build /app ./
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1))"
CMD ["bun","run","start"]
```

`deploy/docker-compose.yml`:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
  gateway:
    image: ghcr.io/<org>/mcp-gateway:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - mcpgw_data:/data
      - ./gateway.yaml:/app/gateway.yaml:ro   # opsional (CI-driven import)
volumes: { caddy_data: {}, mcpgw_data: {} }
```

`deploy/Caddyfile`: `mcp.example.com { encode zstd gzip; reverse_proxy gateway:8080 }` (ACME + HSTS otomatis).

**Variabel environment**

| Var | Default | Fungsi |
|---|---|---|
| `MCPGW_MASTER_KEY` | — (wajib) | 64 hex chars; kunci AES-256-GCM |
| `MCPGW_PUBLIC_URL` | — (wajib) | Origin valid & isi snippet klien |
| `MCPGW_DATA_DIR` | `/data` | SQLite + backups |
| `MCPGW_PORT` / `HOST` | `8080` / `0.0.0.0` | Bind |
| `MCPGW_ADMIN_EMAIL` / `_PASSWORD` | — | Bootstrap admin first-run |
| `MCPGW_METRICS_TOKEN` | — | Bearer `/metrics` |
| `MCPGW_COOKIE_SECRET` | derived | Tanda tangan session cookie |
| `MCPGW_HEALTH_INTERVAL_S` | `30` | Interval health check |
| `MCPGW_CATALOG_TTL_S` | `60` | TTL cache catalog |
| `MCPGW_SESSION_TTL_MIN` | `30` | Idle GC sesi MCP |
| `MCPGW_MAX_LIVE_UPSTREAMS` | `20` | Ukuran pool LRU |
| `MCPGW_TRUST_PROXY` | `true` | Baca `X-Forwarded-For` |
| `MCPGW_DEBUG` | `false` | Simpan payload tool call (redacted) |
| `MCPGW_TZ` | `UTC` | Retensi/agregasi |

**Operasi**
- Backup: `scripts/backup.ts` (`sqlite > save './data/backups/mcpgw-<date>.db'`) tiap hari 03:00 oleh worker; retensi 14 hari; restore = ganti file saat service stop.
- Migrasi: otomatis saat start server (single-writer), versi dicatat di `kv.schema_version`; worker menunggu `schema_version` cocok.
- Log: pino JSON stdout → `docker logs` / Loki; `pino-pretty` hanya di dev.
- Upgrade: `docker compose pull && up -d` (drain via graceful shutdown 30 s).
- CI (`.github/workflows/ci.yml`): `bun run check` (svelte-check + tsc) → `bun lint` → `bun test` (unit + integration) → `bun run build` → `docker build` + push `ghcr.io` (tag sha & semver) → `deploy.yml` (SSH `docker compose pull && up -d`).
- Rollback: pin tag versi sebelumnya di `.env` compose → `up -d`; DB migrasi wajib backward-compatible 1 versi (additive only di V1).

## Development Setup

```bash
# prasyarat: bun >= 1.2, node >= 20 (untuk upstream npx), docker (opsional)
bunx sv@0.17 create . --template sveltekit --types ts --no-add-ons --install bun   # SvelteKit 2 + Svelte 5
bun add @sveltejs/adapter-node @modelcontextprotocol/sdk@1.30.0 drizzle-orm zod argon2 pino prom-client yaml
bun add -d drizzle-kit @types/node svelte-check typescript tailwindcss flowbite-svelte codemirror chart.js
bunx tailwindcss init -p

cp .env.example .env                              # isi MCPGW_MASTER_KEY & MCPGW_ADMIN_*
bun run db:generate                               # drizzle-kit generate
bun run db:migrate                                # buat ./data/mcpgw.db + seed admin
bun run dev                                       # gateway + dashboard di http://localhost:5173/mcp

# validasi
bun test                                          # unit + integration (sqlite temp)
npx @modelcontextprotocol/inspector --cli http://localhost:5173/mcp \
    --transport http --method tools/list --header "Authorization: Bearer mcpgw_dev"
bun run check && bun lint                         # typecheck + lint gate
```

`package.json` scripts: `dev` (`vite dev`) · `build` (`vite build`) · `start` (`MCPGW_ENTRY=src/entrypoints/server.ts bun run .svelte-kit/output/server/...` — dibungkus `scripts/start.ts`) · `worker` (`bun run src/entrypoints/worker.ts`) · `db:generate|db:migrate|db:studio` · `test` · `test:e2e` · `check` · `lint` · `smoke`.

## Definisi Selesai V1.0 (acceptance)

1. `POST /mcp` + Bearer key sukses `initialize` & `tools/list` dengan tool dari ≥ 2 upstream (1 stdio `npx`, 1 remote) dengan namespace benar.
2. Semua 19 user stories US-01…US-19 dan FR-01…FR-18 terimplementasi; FR-19/FR-20 sesuai tabel tahap di PRD.
3. Uji integrasi: key tanpa scope tidak bisa memanggil/membaca tool profil lain; revoke memutus sesi ≤ 5 s; upstream dimatikan → catalog tanpa upstream itu tapi gateway tetap 200.
4. `tools/list` cache hit < 100 ms dan added latency p95 < 300 ms pada uji beban 100 concurrent (reported di artifact).
5. `bun run check && bun lint && bun test` hijau; docker compose up di VPS bersih menghasilkan HTTPS + `/healthz` ok; verifikasi manual di Claude Code, Cursor, opencode (screenshot di PR).

## Langkah Berikutnya

1. Review Tech Spec ini.
2. Buat task: `Buat Task berdasarkan Tech Spec yang sudah dibuat`.
