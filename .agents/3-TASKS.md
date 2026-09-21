# TASKS: mcp-gateway

> **Sumber:** `.agents/2-TECH-SPEC.md` (v1.0) + `.agents/1-PRD.md` (v1.0)
> **Dibuat:** 2026-09-21 · **Status legend:** Todo / In Progress / Done
> **Total:** 48 task · V1.0 = T-01…T-44 · V1.1 = T-45…T-46 · Backlog v2 = T-47…T-48

## Ringkasan Eksekusi

| Milestone | Task | Jam | Kriteria keluar |
|---|---|---|---|
| **M1** Fondasi berjalan | T-01…T-11, T-27, T-28 | 61 | `bun run dev` serve `/mcp` (stub + transport siap), schema DB migrate, vault/password lulus test, 1 upstream stdio fixture tersambung + health loop jalan, namespacing & glob teruji, login admin + RBAC jalan |
| **M2** Gateway multi-upstream | T-12…T-26 | 72 | 2 upstream (stdio + remote) teragregasi dengan namespace benar, `tools/call`/resources/prompts end-to-end, API key + profil + rate limit + audit + metrics |
| **M3** Dashboard & operability | T-29…T-41 | 56 | CRUD upstream/profil/key/manifest/users via UI, logs + usage + snippet klien, onboarding non-teknis < 15 menit |
| **M4** Rilis V1.0 | T-42, T-43, T-44 | 24 | e2e di Claude Code/Cursor/opencode/mcp-remote hijau, Docker + HTTPS di VPS, uji beban & audit NFR lolos |
| **M5** V1.1 | T-45, T-46 | 13 | template library ≥ 10, backup/restore UI + GC retensi |
| **Backlog v2** | T-47, T-48 | ~80 | OAuth 2.1 + vault per-user; HA multi-replica |

**Total estimasi:** V1.0 = 229 jam (≈ 29 hari kerja solo) · +13 jam untuk V1.1.
**Urutan aman (jalur kritis):** T-01→T-02→T-03→T-04→T-05→T-06→T-08→T-10/T-11→T-12→T-14→T-15→T-16→T-19→T-21→T-23→T-24→T-22→T-26→T-27→T-28→T-29→T-30→T-31→T-32→T-33→T-34→T-42→T-43→T-44.
**Catatan dependensi runtime:** beberapa task terhubung lewat event bus (`registry/events` dari T-03) — saat mengerjakan task lebih awal, sediakan stub/interface agar bisa di-wire kemudian: T-13 ↔ `key.revoked` (T-21), T-14 ↔ `registry.events` (T-19). Semua dependensi eksplisit sudah terurut topologis (ID kecil = dikerjakan lebih dulu).

---

## MODUL: Setup & Fondasi

### T-01: Scaffold SvelteKit + Bun + tooling
- **Deskripsi:** Scaffold SvelteKit 2 / Svelte 5 (TS strict), pasang Tailwind 4, ESLint+Prettier, tsconfig strict, `.editorconfig`, `.gitignore` (+ `data/`, `.env`), inisialisasi git. Tambah `svelte.config.js` dengan `adapter-node` (sudah termasuk di T-02, di sini hanya scaffold + lint gate).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** — · **Estimasi:** 3h
- **File:** `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.editorconfig`, `src/app.css`, `src/app.d.ts`
- **Acceptance:** `bun install`, `bun run check`, `bun lint`, `bun run build` hijau; halaman `/` default SvelteKit ter-render.

### T-02: Custom server Bun + router `/mcp` `/metrics` `/healthz`
- **Deskripsi:** Buat `src/entrypoints/server.ts` (Bun.serve → `handleFetch`) dan `src/handle.ts` sebagai router: `/mcp` → stub handler `501` (diisi T-18), `/metrics` → stub, `/healthz` → JSON `{ ok, version, upstreams, sessions }`, sisanya → SvelteKit handler dari adapter-node. Graceful shutdown (drain 30s), `maxBodySize: 1_048_576`, `MCPGW_TRUST_PROXY` → IP dari `X-Forwarded-For` 1 hop. Script `start` yang resolve build output adapter-node.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-01 · **Estimasi:** 5h
- **File:** `src/entrypoints/server.ts`, `src/handle.ts`, `scripts/start.ts`, `.env.example`
- **Acceptance:** `bun run build && bun run start` → `GET /healthz` 200 JSON, `GET /` 200 HTML, `POST /mcp` 501, 404 untuk rute lain.

### T-03: Config loader + logger
- **Deskripsi:** `lib/server/config.ts` memuat + validasi env dengan Zod (semua var di Tech Spec Bagian 5, termasuk default), fail-fast dengan pesan jelas; `observability/logger.ts` (pino, pretty di dev, redaction hook dari T-04); `version` dari `package.json`; `registry/events.ts` — event bus in-memory bertipe (publish/subscribe + `close()`) yang dipakai lintas modul (`upstream.changed`, `profile.changed`, `health.changed`, `key.revoked`).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-02 · **Estimasi:** 3h
- **File:** `src/lib/server/config.ts`, `src/lib/server/observability/logger.ts`, `src/lib/server/registry/events.ts`, `.env.example`, `tests/unit/config.test.ts`, `tests/unit/events.test.ts`
- **Acceptance:** Boot tanpa `MCPGW_MASTER_KEY` → error eksplisit dan exit non-zero; log berisi `requestId`; `MCPGW_MASTER_KEY` tidak pernah muncul di output log; subscriber event menerima payload bertipe dan unsubscribe berfungsi.

### T-04: Schema DB, migrasi, seed
- **Deskripsi:** Drizzle schema lengkap sesuai Tech Spec Bagian 2 (14 tabel: `users`, `web_sessions`, `upstreams`, `secret_refs`, `upstream_health`, `profiles`, `profile_upstreams`, `api_keys`, `mcp_sessions`, `tool_calls`, `usage_hourly`, `audit_log`, `kv`, `templates_applied`) + index strategy. Koneksi `bun:sqlite` (WAL, `busy_timeout=5000`, FK on), `migrate.ts` (buat folder data, catat `kv.schema_version`), `seed.ts` bootstrap admin dari env, `ids.ts` (UUIDv7), `shared/schemas.ts` (Zod untuk upstream/profile/key/manifest), `scripts/backup.ts`.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-03 · **Estimasi:** 8h
- **File:** `src/lib/server/db/{index,schema,migrate,seed}.ts`, `src/lib/shared/{ids,schemas}.ts`, `drizzle.config.ts`, `drizzle/0000_*.sql`, `scripts/backup.ts`, `tests/unit/ids.test.ts`
- **Acceptance:** `bun run db:generate && bun run db:migrate` membuat `./data/mcpgw.db` berisi semua tabel + index; admin bootstrap terbuat; `bun run db:migrate` kedua kali no-op; FK `ON DELETE` teruji di test.

### T-05: Vault, env-resolve, password, redact
- **Deskripsi:** `security/vault.ts` (HKDF-SHA256 + AES-256-GCM, simpan `cipher/iv/tag/key_ver`, rotasi), `env-resolve.ts` (resolve `${ENV}` / `secret:<name>`, deteksi env hilang), `password.ts` (argon2id `m=64MB,t=3,p=4` + dummy verify untuk timing safety), `redact.ts` (pola `ghp_`, `github_pat_`, `xoxb-`, `sk-`, JWT, `Bearer …`), `ssrf.ts` (blokir non-https selain localhost, range privat, `169.254.169.254`, redirect ditolak).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-04 · **Estimasi:** 6h
- **File:** `src/lib/server/security/{vault,env-resolve,password,redact,ssrf}.ts`, `tests/unit/{vault,password,redact,ssrf}.test.ts`
- **Acceptance:** Round-trip seal/open lulus; GCM tag diubah → throw; argon2 verify benar/salah benar; `redact` menutup semua pola test; `ssrfFetch` menolak `http://`, `127.0.0.1`, `169.254.169.254` dan mengizinkan `https://api.github.com`.

---

## MODUL: Upstream (koneksi & health)

### T-06: Upstream stdio (spawn + handshake)
- **Deskripsi:** `upstream/stdio.ts` memakai `StdioClientTransport`: spawn dengan env hasil sanitization (hanya `PATH/HOME/LANG/NODE_ENV/TMPDIR` + env yang dipetakan eksplisit via `env_refs`), `cwd` opsional, handshake `initialize` (timeout), capture `serverInfo`/`capabilities`/`tools_count`, tangani child exit → status `down` + `last_error`, auto-restart dengan backoff. Env wajib hilang → status `unconfigured` (tanpa spawn).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-05 · **Estimasi:** 6h
- **File:** `src/lib/server/upstream/stdio.ts`, `tests/fixtures/echo-mcp-server.ts`, `tests/integration/stdio-upstream.test.ts`
- **Acceptance:** Fixture MCP server (stdio) tersambung, `tools/list` berisi tool fixture; `MCPGW_MASTER_KEY` tidak terlihat oleh child (diverifikasi lewat fixture yang echo env); child dibunuh → status `down`, restart ≤ backoff.

### T-07: Upstream remote HTTP + SSRF guard
- **Deskripsi:** `upstream/remote-http.ts` dengan `StreamableHTTPClientTransport` (atau varian Web-standard) + `ssrfFetch` sebagai `fetch`; auth header dari `headers_ref`; `TLS verify` toggle; handshake & capability capture; timeout connect 5 s; dukung SSE resume via `Last-Event-ID` bila upstream mengirimnya.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-06 · **Estimasi:** 5h
- **File:** `src/lib/server/upstream/{remote-http,ssrf-fetch}.ts`, `tests/integration/remote-upstream.test.ts`
- **Acceptance:** Terhubung ke MCP server HTTP lokal (fixture) dan memanggil 1 tool; URL `http://` (non-localhost) dan metadata IP → ditolak dengan error actionable.

### T-08: Pool koneksi upstream
- **Deskripsi:** `upstream/pool.ts`: mode `pinned` (warm saat boot) vs `lazy` (spawn on-demand), LRU + `idleTtl` 10 menit, maks `MCPGW_MAX_LIVE_UPSTREAMS`, semaphore konkurensi per upstream, `close(slug, { grace: 30_000 })` yang menunggu `tools/call` aktif selesai, `closeAll()` untuk shutdown, event `pool:*` untuk observability.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-06 · **Estimasi:** 6h
- **File:** `src/lib/server/upstream/pool.ts`, `tests/integration/pool.test.ts`
- **Acceptance:** `get()` dua kali → 1 koneksi; idle > TTL → tertutup (spawn count naik lagi setelah `get()`); `close()` saat call aktif → call selesai lalu koneksi ditutup; jumlah proses child = 0 setelah `closeAll()` (dicek via `ps` di test).

### T-09: Health checker + circuit breaker
- **Deskripsi:** `upstream/health.ts`: probe `ping` bila capability ada, else `tools/list` (timeout 5 s); transisi `healthy/degraded/down/unconfigured` per BR/Alur 4 (3× gagal → `down`, 2× sukses → `healthy`, `degraded` saat latensi > 50% timeout); backoff eksponensial ≤ 5 menit; lewati upstream `lazy` tanpa koneksi hidup; tulis `upstream_health`; emit `registry.healthChanged` → invalidasi catalog + gauge metrics. `worker.ts` sebagai scheduler loop (`MCPGW_HEALTH_INTERVAL_S`).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-08 · **Estimasi:** 5h
- **File:** `src/lib/server/upstream/health.ts`, `src/entrypoints/worker.ts`, `tests/unit/health.test.ts`
- **Acceptance:** Tabel transisi teruji (fake probe): 2 gagal → masih healthy, 3 → down, 2 sukses → healthy; interval probe mengikuti backoff; worker tidak menjalankan probe saat `schema_version` belum cocok.

---

## MODUL: Catalog & Namespacing

### T-10: Namespacing tool
- **Deskripsi:** `mcp/namespacing.ts`: `qualify(slug, name)` = `<slug>__<name>`, sanitasi charset, aturan > 64 char (`slug[..12]-<b32(sha1)>__<name[..31]-<hash6>>`), `split(gname)`, `build()` menghasilkan `{ list, byName }` dengan deteksi collision → error eksplisit (bukan rename diam-diam). Kontrak simetris `split(qualify(x)) === x`.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-04 · **Estimasi:** 4h
- **File:** `src/lib/server/mcp/namespacing.ts`, `tests/unit/namespacing.test.ts`
- **Acceptance:** 200+ nama (termasuk Unicode, spasi, >64 char) lolos regex `^[A-Za-z0-9_.-]{1,64}$`; collision → throw; properti test (fast-check) untuk simetri.

### T-11: Filter glob profil
- **Deskripsi:** `shared/glob.ts` (`*`, `?`, `[…]`, tanpa regex injection) + evaluasi deny > allow untuk nama tool, resource URI, dan prompt name (BR-03).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-04 · **Estimasi:** 2h
- **File:** `src/lib/shared/glob.ts`, `tests/unit/glob.test.ts`
- **Acceptance:** Test matrix: `["*"]` + deny `["*delete*"]`; pattern ilegal (mis. `[a-`) → `ValidationError`; perform < 1 ms untuk 1.000 nama.

---

## MODUL: Gateway MCP (inti)

### T-12: McpGatewayServer + transport Web-standard
- **Deskripsi:** `mcp/gateway.ts` membuat `McpServer` per sesi dengan `WebStandardStreamableHTTPServerTransport` (`sessionIdGenerator: uuidv7`, `onsessioninitialized/closed`, `enableJsonResponse` configurable, `keepAliveMs: 15000`), `handleRequest(req, undefined, { authInfo })`; negosiasi `protocolVersion` (2025-06-18 → fallback 2025-03-26 → 2024-11-05); deklarasi capabilities (`tools.listChanged: true`, `resources`, `prompts`); `mcp/event-store.ts` (EventStore in-memory, kapasitas 1.000 event/sesi) untuk resumability.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-02, T-10 · **Estimasi:** 8h
- **File:** `src/lib/server/mcp/{gateway,event-store}.ts`, `tests/integration/mcp-handshake.test.ts`
- **Acceptance:** `initialize` via `StreamableHTTPClientTransport` (klien nyata) sukses + header `Mcp-Session-Id`; versi protokol lama dinegosiasi; `DELETE /mcp` memanggil `onsessionclosed`; SSE resume dengan `Last-Event-ID` mengembalikan event yang terlewat.

### T-13: Session store + GC
- **Deskripsi:** `mcp/session.ts`: baris `mcp_sessions` (id, api_key_id, profile_id, protocol_version, client_info, last_seen_at), update `last_used_at` (debounce 30 s), hitung sesi aktif untuk `/healthz`, GC sesi idle > `MCPGW_SESSION_TTL_MIN`, tutup transport saat `key.revoked`/`key.suspended` ≤ 5 s.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-12 (wire `key.revoked` dari T-21) · **Estimasi:** 4h
- **File:** `src/lib/server/mcp/session.ts`, `tests/integration/session-gc.test.ts`
- **Acceptance:** Sesi idle di-GC + `closed_at` terisi; setelah revoke key, `POST /mcp` dengan sesi lama → 401 dalam ≤ 5 s; `/healthz.sessions` akurat.

### T-14: Aggregator `tools/list` + cache catalog
- **Deskripsi:** `mcp/aggregator.ts`: fan-out paralel `tools/list` (timeout `min(timeout_ms, 15000)`, `Promise.allSettled`), lewati upstream non-healthy/disabled tapi laporkan ke health, qualify names, lampirkan `_meta { upstream, upstreamTool, upstreamVersion, health }`, cache per profil (TTL `MCPGW_CATALOG_TTL_S`) + invalidasi via `registry.events`, paginasi cursor (urutan per-upstream), `listChanged` notification ke sesi terdampak saat catalog berubah.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-10, T-12 (invalidasi memakai event bus T-03) · **Estimasi:** 8h
- **File:** `src/lib/server/mcp/aggregator.ts`, `tests/integration/tools-list.test.ts`, `tests/unit/catalog-cache.test.ts`
- **Acceptance:** 2 fixture upstream → catalog gabungan dengan namespace benar; cache hit < 100 ms (asserted duration); 1 upstream sengaja mati → katalog tetap 200 tanpa tool-nya; perubahan registry → klien dapat `notifications/tools/list_changed`.

### T-15: Filter tool per sesi
- **Deskripsi:** Terapkan `profile_upstreams.allow_globs/deny_globs` **saat request** (bukan hanya saat cache ditulis) + filter upstream disabled/down; hasil `tools/list` dan validasi `tools/call` memakai aturan yang sama (satu sumber kebenaran).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-11, T-14 · **Estimasi:** 3h
- **File:** `src/lib/server/mcp/{aggregator,tool-filter}.ts`, `tests/integration/tool-filter.test.ts`
- **Acceptance:** Profil dengan deny `["*delete*"]` → tool terkait hilang dari list **dan** `tools/call` ke nama itu ditolak; deny menang atas allow (test matrix).

### T-16: Routing `tools/call`
- **Deskripsi:** `mcp/gateway.ts` handler `tools/call`: lookup `byName` → `unknown tool` (-32602); cek scope/denylist; timeout `min(upstream.timeout_ms, 300_000)`; pass-through argumen & `content` (hanya tambah `_meta.upstreamTool`); retry 1x **hanya** untuk error transport (EPIPE/timeout/spawn fail), `isError: true` tidak di-retry; forward `notifications/progress` bila ada `progressToken`; tulis `tool_calls` + metrics (via T-21).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-15, T-13 · **Estimasi:** 6h
- **File:** `src/lib/server/mcp/gateway.ts`, `src/lib/server/observability/usage.ts` (helper tulis `tool_calls` + hook metrics, dilengkapin di T-26), `tests/integration/tools-call.test.ts`
- **Acceptance:** `tools/call` ke 2 upstream berbeda mengembalikan hasil benar; upstream yang di-matikan → error `upstream unavailable`; timeout dihormati (test 1 s pada upstream tidur); retry terjadi tepat 1x (assert spawn count); baris `tool_calls` lengkap (status, duration_ms, req/res bytes, request_id).

### T-17: Proksi resources
- **Deskripsi:** `mcp/resources.ts`: `resources/list` (fan-out + namespacing URI `sluggified://` atau prefix aman), `resources/read` routing balik, `resources/templates/list`, `resources/subscribe` dideklarasikan hanya bila semua upstream dalam profil mendukung (all-or-nothing, BR-14), emit `listChanged`.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-14 · **Estimasi:** 5h
- **File:** `src/lib/server/mcp/resources.ts`, `tests/integration/resources.test.ts`
- **Acceptance:** Resource dari 2 upstream muncul tergabung tanpa tabrakan URI; `resources/read` URI milik upstream A tidak pernah dikirim ke B; upstream tanpa capability → di-skip.

### T-18: Proksi prompts
- **Deskripsi:** `mcp/prompts.ts`: `prompts/list` fan-out + namespacing, `prompts/get` routing balik + validasi argumen (deklarasikan argumen upstream apa adanya), `listChanged`, filter glob mengikuti T-15.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-14 · **Estimasi:** 4h
- **File:** `src/lib/server/mcp/prompts.ts`, `tests/integration/prompts.test.ts`
- **Acceptance:** `prompts/get` mengembalikan messages dari upstream yang benar; prompt name duplikat antar-upstream tetap terbedakan.

---

## MODUL: Registry

### T-19: Registry CRUD + event bus + hot reload
- **Deskripsi:** `registry/index.ts` sebagai satu-satunya akses tulis config: `load()` ke memori saat boot, CRUD upstream/profil dalam transaksi, `registry.events` (`upstream.changed`, `upstream.enabled`, `profile.changed`, `health.changed`, `key.revoked`) → subscriber melakukan invalidasi catalog & pool; hot reload ≤ 500 ms tanpa menyentuh upstream lain (BR-12); guard BR-08 (profil dipakai key aktif tidak bisa dihapus) dan BR-02 (slug tidak dapat diubah).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-14, T-16 · **Estimasi:** 6h
- **File:** `src/lib/server/registry/index.ts`, `tests/integration/registry.test.ts`
- **Acceptance:** Disable 1 upstream → katalog berubah < 500 ms (asserted), upstream lain tetap hidup (spawn count tidak berubah); hapus profil terpakai → ditolak; update slug → ditolak.

### T-20: Manifest YAML import/eksport
- **Deskripsi:** `registry/manifest.ts`: `toYAML()` (eksport, secret sebagai `${ENV}`/`secret:<name>`), `parseYAML()` (Zod), secret scan (pola token → `ValidationError`, import batal), `diff()` (added/updated/removed/unchanged, `removed` = disable), apply dalam transaksi + emit events, laporan hasil + daftar `unconfigured`; endpoint `GET /manifest`.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-19, T-05 · **Estimasi:** 6h
- **File:** `src/lib/server/registry/manifest.ts`, `src/routes/manifest/+server.ts`, `gateway.example.yaml`, `tests/unit/manifest.test.ts`
- **Acceptance:** Import `gateway.example.yaml` → upstream terbentuk; import ulang → `unchanged`; YAML berisi `ghp_…` → ditolak dengan pesan menyebut field; eksport → import → diff kosong.

---

## MODUL: Governance & Observability

### T-21: API key lifecycle
- **Deskripsi:** `governance/apikey.ts`: `generate()` (`mcpgw_` + base58(32B), simpan `sha256`, `key_prefix`, `key_tail4`), `verify(header)` → `{ ok, key?, reason }` tanpa timing leak (hash lalu lookup), cek `status`/`expires_at`/`ip_allowlist`, `revoke`/`rotate` (metadata & scope tersalin, `rotated_from_id`), `suspend`/`resume`, audit tiap aksi.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-19 · **Estimasi:** 5h
- **File:** `src/lib/server/governance/apikey.ts`, `tests/unit/apikey.test.ts`, `tests/integration/apikey-lifecycle.test.ts`
- **Acceptance:** Key revoked ditolak 401; suspended → 403; expired → 401; rotate mempertahankan profil; `verify` dengan key salah/waktu konstan (test distribusi waktu); plaintext tidak pernah tersimpan di DB (assert kolom tidak ada).

### T-22: Auth middleware `/mcp`
- **Deskripsi:** `src/middleware/auth.ts`: parse `Authorization: Bearer` → `apikey.verify` → rate limit (T-23) → IP allowlist → validasi `Origin` terhadap `MCPGW_PUBLIC_URL` (tolak Origin browser asing) → inject `authInfo` (key id, profile id, scope) → `X-Request-Id` di respons; gagal-auth 10×/IP/menit → `429` backoff 60 s; `audit_log` untuk auth failure (sampling).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-21, T-24 · **Estimasi:** 4h
- **File:** `src/middleware/auth.ts`, `src/handle.ts`, `tests/integration/auth-mcp.test.ts`
- **Acceptance:** Tanpa header → 401 + `WWW-Authenticate`; key valid → 200; Origin asing → 403; 10 auth gagal dari IP sama → request ke-11 `429` + `Retry-After`.

### T-23: Rate limit, quota, konkurensi
- **Deskripsi:** `governance/ratelimit.ts`: token bucket per key (`rate_limit_rpm`) di memori + rehydrate ringan, daily quota dari `kv` (`quota_day`, `quota_used`, reset saat tanggal ganti), semaphore `max_concurrency` per key & per upstream, header `Retry-After` + `X-RateLimit-Remaining`, status `rate_limited` di `tool_calls`.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-05 · **Estimasi:** 5h
- **File:** `src/lib/server/governance/ratelimit.ts`, `tests/unit/ratelimit.test.ts`
- **Acceptance:** 121 request dalam 1 menit pada limit 120 → request terakhir 429; quota harian tercapai → ditolak lalu reset saat `quota_day` berubah; konkurensi > 10 → antrian/reject sesuai config; tidak ada leak bucket setelah 10k iterasi.

### T-24: Profil & scope
- **Deskripsi:** `governance/profile.ts`: CRUD profil + `profile_upstreams` (globs), `getScope(profileId)` → daftar upstream + aturan glob (di-cache, invalidasi via event), estimasi jumlah tool untuk UI, default rate limit/timeout (BR-06), guard profil terakhir/admin default.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-19, T-23 · **Estimasi:** 4h
- **File:** `src/lib/server/governance/profile.ts`, `tests/integration/profile-scope.test.ts`
- **Acceptance:** 2 key dengan profil berbeda → `tools/list` berbeda sesuai scope; key A memanggil tool milik profil B → ditolak (uji isolasi wajib dari acceptance Tech Spec).

### T-25: Audit trail
- **Deskripsi:** `observability/audit.ts`: `record(actor_type, actor_id, action, target, meta, ip, request_id)` append-only (tanpa fungsi update/delete), auto-audit semua form action (helper `withAudit`), timeline query terpaginasi, export CSV (`/api/v1/audit`, `/api/v1/logs/export.csv`), retensi 180 hari (GC worker).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-21 · **Estimasi:** 4h
- **File:** `src/lib/server/observability/audit.ts`, `src/routes/api/v1/audit/+server.ts`, `src/routes/api/v1/logs/export.csv/+server.ts`, `tests/integration/audit.test.ts`
- **Acceptance:** Setiap CRUD upstream/key/profil menghasilkan baris audit dengan actor+ip+request_id; export CSV berisi header + baris yang difilter; tidak ada jalur API untuk menghapus audit.

### T-26: Request tracing + metrics + `/healthz`
- **Deskripsi:** `hooks.server.ts` generate/teruskan `X-Request-Id` (ke log, `tool_calls`, header respons, dan metadata ke upstream); `observability/metrics.ts` (prom-client: `mcp_tool_calls_total`, `mcp_tool_call_duration_seconds`, `mcp_upstream_healthy`, `mcp_active_sessions`, `mcp_rate_limited_total`, `mcp_registry_items`); `/metrics` dengan Bearer `MCPGW_METRICS_TOKEN`; `/healthz` real (upstreams healthy/down, sessions, version).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-16, T-09, T-13 · **Estimasi:** 4h
- **File:** `src/hooks.server.ts`, `src/lib/server/observability/{metrics,logger}.ts`, `src/handle.ts`, `tests/integration/metrics.test.ts`
- **Acceptance:** `curl -H "Authorization: Bearer $MCPGW_METRICS_TOKEN" /metrics` memuat nama metrik di atas; 1 tool call menaikkan counter + histogram; `/healthz` menampilkan hitungan benar; `X-Request-Id` request muncul di `tool_calls`.

---

## MODUL: Auth Admin

### T-27: Login / logout / session
- **Deskripsi:** `routes/login/+page.server.ts` (action `default` login, `logout`), session random-id + `web_sessions`, cookie `mcpgw_session` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=12h`), lock 15 menit setelah 5 gagal (per email) + rate limit per IP, pesan error generik, redirect `/admin`.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-05 · **Estimasi:** 5h
- **File:** `src/routes/login/+page.svelte`, `src/routes/login/+page.server.ts`, `src/lib/server/governance/session.ts`, `tests/integration/login.test.ts`
- **Acceptance:** Login benar → cookie terset & `/admin` 200; password salah 5× → terkunci 15 menit (test waktu); sesi kedaluwarsa → redirect `/login`; logout menghapus baris + cookie.

### T-28: Hooks: session load + RBAC + CSRF + CSP
- **Deskripsi:** `hooks.server.ts`: load user → `locals.user` (role), guard `/admin/*` (unauth → redirect, `viewer` + mutasi → 403), `config.csrf = checkOrigin` untuk semua form action, security headers (CSP, nosniff, DENY frame, Referrer-Policy, Permissions-Policy), logout-dari-jauh (user disabled → sesi mati).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-27 · **Estimasi:** 4h
- **File:** `src/hooks.server.ts`, `src/routes/admin/+layout.server.ts`, `tests/integration/rbac.test.ts`
- **Acceptance:** `viewer` POST form action → 403 dan data tidak berubah; request lintas-origin ke form action → 403 CSRF; header keamanan muncul di semua respons HTML.

---

## MODUL: Dashboard Admin (SvelteKit)

### T-29: UI shell + design tokens
- **Deskripsi:** Setup Tailwind 4 + Flowbite/DaisyUI, `+layout.svelte` dengan sidebar nav (Dashboard, Upstreams, Profiles, Keys, Logs, Usage, Templates, Manifest, Users, Settings), toggle dark/light (persist), komponen dasar (Table, Card, Badge status, Button, Modal, EmptyState, CopyButton, Pagination, Toast), `+error.svelte`, status color system (`healthy`/`degraded`/`down`/`unconfigured`).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-28 · **Estimasi:** 6h
- **File:** `src/routes/+layout.svelte`, `src/routes/admin/+layout.svelte`, `src/lib/ui/*.svelte`, `src/app.css`
- **Acceptance:** Semua rute `/admin/*` memakai shell; kontras AA (dicek manual/axe); dark mode tersimpan antar reload; navigasi keyboard-only berfungsi.

### T-30: Halaman dashboard
- **Deskripsi:** `/admin` load: hitungan upstream per status, 10 upstream degradasi/down, panggilan 24 jam, top 5 tool, error rate, sesi aktif, API key mendekati expiry, CTA "belum ada upstream"; data dari `load` server (Si 30 s auto-refresh via `?_data` poll).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-29, T-26 · **Estimasi:** 5h
- **File:** `src/routes/admin/+page.svelte`, `src/routes/admin/+page.server.ts`
- **Acceptance:** Angka sesuai seed test; empty state muncul saat DB kosong; semua tautan status mengarah ke halaman detail terkait.

### T-31: Halaman upstreams (list + detail)
- **Deskripsi:** List: nama/slug, transport, status health + latensi, tool count, pin mode, enabled toggle, search + filter status. Detail: form edit (command/args/cwd atau url/headers), env mapping dengan secret picker, timeline health (sparkline), tombol `checkNow`/`reconnect`/`rotateSecret`/`remove`, panel `last_error` actionable, preview tool hasil handshake, snippet "cara pakai".
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-30, T-19 · **Estimasi:** 8h
- **File:** `src/routes/admin/upstreams/+page.svelte`, `src/routes/admin/upstreams/[slug]/{+page.svelte,+page.server.ts}`, `src/lib/ui/HealthSpark.svelte`
- **Acceptance:** Toggle enabled → katalog langsung berubah (diverifikasi via `tools/list`); secret lama tidak pernah tampil (hanya `•••` + nama ref); error env hilang menampilkan nama env.

### T-32: Form tambah upstream + test handshake
- **Deskripsi:** Actions `createStdio` / `createHttp` dengan validasi Zod di server (`superRefine` untuk slug unik, `^[a-z0-9-]{2,32}$`, URL valid + SSRF check), "Test connection" memanggil handshake tanpa menyimpan, simpan → `enabled=1` hanya jika handshake sukses (gagal → `enabled=0` + pesan), arahkan ke detail.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-31 · **Estimasi:** 5h
- **File:** `src/routes/admin/upstreams/new/{+page.svelte,+page.server.ts}`
- **Acceptance:** Slug duplikat → error inline; command yang tidak ada → upstream tersimpan nonaktif dengan `last_error`; remote `http://` non-localhost ditolak; upstream sukses langsung punya `tools_count` > 0.

### T-33: Halaman profiles
- **Deskripsi:** List + detail profil: upstream toggle, editor glob allow/deny per upstream dengan preview live "X dari Y tool tersedia", field rate limit/timeout, indikator estimasi tool, aksi delete dengan guard (tampilkan key yang memakai), tombol "buat key untuk profil ini".
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-31, T-23 · **Estimasi:** 6h
- **File:** `src/routes/admin/profiles/{+page.server.ts}`, `src/routes/admin/profiles/[id]/{+page.svelte,+page.server.ts}`
- **Acceptance:** Deny glob → jumlah tool preview cocok dengan `tools/list` nyata; delete profil terpakai → ditolak + daftar key tampil; perubahan profil → invalidasi cache terverifikasi.

### T-34: Halaman API keys
- **Deskripsi:** List (prefix/tail4, profil, status, last_used, expiry) + form create; halaman sukses menampilkan **plaintext sekali** + snippet konfig per klien; detail: rotate/revoke/suspend/resume, IP allowlist, usage sparkline per key, riwayat rotasi.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-33, T-21 · **Estimasi:** 6h
- **File:** `src/routes/admin/keys/{+page.server.ts}`, `src/routes/admin/keys/[id]/{+page.svelte,+page.server.ts}`
- **Acceptance:** Setelah create, key langsung bisa dipakai `initialize`; navigasi menjauh membuat plaintext tidak bisa dilihat lagi; rotate → key lama 401 dan key baru 200; sesi key yang di-revoke mati ≤ 5 s.

### T-35: Snippet konfigurasi klien
- **Deskripsi:** `shared/snippet.ts` menghasilkan config untuk Claude Code (`claude mcp add --transport http`), Claude Desktop remote, Cursor (`mcp.json`), opencode (`opencode.json`), generic `mcp-remote`, dengan `MCPGW_PUBLIC_URL` + key; komponen `ClientSnippet.svelte` dengan tab + CopyButton + "buka docs".
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-34 · **Estimasi:** 3h
- **File:** `src/lib/shared/snippet.ts`, `src/lib/ui/ClientSnippet.svelte`, `src/routes/api/v1/keys/[id]/snippet/+server.ts`, `tests/unit/snippet.test.ts`
- **Acceptance:** Snippet untuk tiap klien valid (JSON parse / command benar); copy menyertakan URL publik dan key yang sedang dibuat.

### T-36: Halaman logs
- **Deskripsi:** Tabel `tool_calls` terpaginasi cursor + filter (key, upstream, status, tool, rentang waktu, request_id), baris detail (durasi, bytes, error ter-redaksi, `_meta`), tombol "salin request id", export CSV, retensi 30 hari dengan badge peringatan.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-30, T-25 · **Estimasi:** 6h
- **File:** `src/routes/admin/logs/{+page.svelte,+page.server.ts}`, `src/routes/api/v1/logs/+server.ts`
- **Acceptance:** 10k baris → query < 200 ms (assert di test integrasi); filter status `rate_limited` bekerja; tidak ada payload/token bocor di tampilan.

### T-37: Halaman usage + chart
- **Deskripsi:** `/admin/usage` dengan Chart.js: panggilan per hari/jam, top tools, panggilan per key, error rate, p50/p95 (`usage_hourly`), filter rentang + per upstream/key; muat dari `/api/v1/usage`.
- **Prioritas:** Mid · **Status:** Todo · **Dependensi:** T-36, T-26 · **Estimasi:** 5h
- **File:** `src/routes/admin/usage/{+page.svelte,+page.server.ts}`, `src/routes/api/v1/usage/+server.ts`, `src/lib/ui/Chart.svelte`
- **Acceptance:** Angka chart cocok dengan `SELECT COUNT(*)` pada rentang yang sama; dark mode mengikuti tema; responsif di mobile.

### T-38: Halaman manifest
- **Deskripsi:** Editor CodeMirror YAML + tombol validate, "preview diff", import (laporan added/updated/removed/unconfigured + tautan "isi secret"), eksport/download `gateway.yaml`, tombol "copy"; semua lewat actions T-20.
- **Prioritas:** Mid · **Status:** Todo · **Dependensi:** T-32, T-20 · **Estimasi:** 5h
- **File:** `src/routes/admin/manifest/{+page.svelte,+page.server.ts}`
- **Acceptance:** Import `gateway.example.yaml` berhasil; YAML dengan secret plaintext → pesan menyebut baris/field; import idempoten (diff kosong).

### T-39: Halaman users
- **Deskripsi:** List admin/viewer, create user (role), setRole, disable/enable, reset password (argon2 rehash), "force logout sessions"; bootstrap admin tidak bisa dihapus/di-downgrade (guard).
- **Prioritas:** Mid · **Status:** Todo · **Dependensi:** T-30, T-28 · **Estimasi:** 4h
- **File:** `src/routes/admin/users/{+page.svelte,+page.server.ts}`
- **Acceptance:** User `viewer` tidak bisa mengakses form action tulis; disable user → sesi aktif langsung mati; guard bootstrap admin bekerja.

### T-40: Halaman settings
- **Deskripsi:** Edit default global (timeout default, `MCPGW_HEALTH_INTERVAL_S`, `MCPGW_CATALOG_TTL_S`, retensi, flag debug payload, `MCPGW_MAX_LIVE_UPSTREAMS`) yang tersimpan sebagai override di `kv` + membaca dari env sebagai fallback; tombol "revalidate catalog" dan "reload upstream"; tampilkan versi & schema_version.
- **Prioritas:** Low · **Status:** Todo · **Dependensi:** T-30, T-19 · **Estimasi:** 4h
- **File:** `src/routes/admin/settings/{+page.svelte,+page.server.ts}`, `src/lib/server/config.ts`
- **Acceptance:** Ubah health interval → worker memakai nilai baru ≤ 1 siklus; ubah TTL catalog berdampak pada latency `tools/list`; nilai env tetap tampil sebagai read-only.

### T-41: Empty state, onboarding & micro-copy
- **Deskripsi:** Onboarding 4 langkah di dashboard saat registry kosong (tambah upstream → buat profil → buat key → copy snippet), empty state untuk semua halaman, pesan error actionable (mis. "env `SENTRY_TOKEN` belum di-set — isi di sini"), tooltips, bilingual EN/ID untuk strings umum (`lib/shared/i18n.ts`, default EN).
- **Prioritas:** Mid · **Status:** Todo · **Dependensi:** T-34 · **Estimasi:** 4h
- **File:** `src/lib/shared/i18n.ts`, `src/lib/ui/EmptyState.svelte`, `src/routes/admin/+page.svelte`
- **Acceptance:** UI baru bisa menambah upstream pertama tanpa dokumentasi (diuji manual, target < 15 menit); tidak ada teks "undefined" di empty state.

---

## MODUL: Test, DevOps & Release

### T-42: Uji end-to-end klien nyata + `tests/e2e`
- **Deskripsi:** Fixture MCP server (stdio + HTTP, termasuk tool error/timeout/progress), skrip `bun run smoke`, uji flow: initialize → tools/list → tools/call → resources → prompts; verifikasi manual + screenshot di Claude Code, Cursor, opencode, `mcp-remote`; simpan transkrip inspector di `tests/e2e/`.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-17, T-18, T-22, T-35 · **Estimasi:** 8h
- **File:** `scripts/smoke.ts`, `tests/e2e/*.md`, `tests/fixtures/*`
- **Acceptance:** Keempat klien sukses memanggil tool lewat gateway dengan 1 konfigurasi; laporan discrepancy protokol (jika ada) terselesaikan.

### T-43: Docker, Caddy, CI/CD
- **Deskripsi:** `deploy/Dockerfile` multi-stage (base dengan Node+Bun+python3, non-root `USER bun`, HEALTHCHECK), `docker-compose.yml` (gateway + Caddy, volume `/data`), `Caddyfile` (ACME+HSTS), `docker-entrypoint` (migrate → server, worker terpisah), `.github/workflows/ci.yml` (check/lint/test/build/push ghcr tag sha+semver) + `deploy.yml` (SSH pull & up -d), dokumentasi `README.md` (setup klien + self-host EN/ID).
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-42 · **Estimasi:** 8h
- **File:** `deploy/{Dockerfile,docker-compose.yml,Caddyfile}`, `.github/workflows/{ci,deploy}.yml`, `README.md`
- **Acceptance:** `docker compose up -d` di mesin bersih → HTTPS `https://<domain>/healthz` ok, image non-root, restart mempertahankan data; CI hijau untuk PR contoh.

### T-44: Uji beban + audit keamanan (gate V1.0)
- **Deskripsi:** k6/autocannon: 1.000 SSE session + 200 tool call/s, ukur added latency & RSS; audit checklist NFR Keamanan (scope isolation, SSRF, CSP, secret tidak di-log, rate limit, RBAC, backup restore drill); tulis hasil di `docs/nfr-report.md`.
- **Prioritas:** High · **Status:** Todo · **Dependensi:** T-43 · **Estimasi:** 8h
- **File:** `tests/load/gateway.js`, `docs/nfr-report.md`
- **Acceptance:** p50 < 100 ms & p95 < 300 ms added latency; `tools/list` cache hit < 100 ms; checklist keamanan hijau; restore dari backup divalidasi.

### T-45: (V1.1) Template library bundled (FR-20)
- **Deskripsi:** Skema template JSON + minimal 10 template (`github`, `sentry`, `postgres`, `filesystem`, `playwright`, `tempo`, `linear`, `slack`, `notion`, `context7`), `lib/server/templates/index.ts` (load + validasi + overlay `MCPGW_TEMPLATE_CATALOG_URL`), `/admin/templates` + action `fromTemplate` (form kredensial → `secret_refs` → create → smoke test → hasil tool count).
- **Prioritas:** Mid · **Status:** Todo · **Dependensi:** T-32, T-38 · **Estimasi:** 8h
- **File:** `templates/*.json`, `src/lib/server/templates/index.ts`, `src/routes/admin/templates/{+page.svelte,+page.server.ts}`, `tests/unit/templates.test.ts`
- **Acceptance:** Semua 10 template lolos validasi skema; `fromTemplate` untuk `github` menghasilkan upstream healthy dengan tools > 0; template tanpa token (audit grep).

### T-46: (V1.1) Backup/restore UI + GC retensi
- **Deskripsi:** Worker menjalankan backup harian (`sqlite > save`) + retensi 14 hari, halaman Settings menampilkan daftar backup + tombol restore (dengan konfirmasi & versi aman), GC `tool_calls` 30 hari / `audit_log` 180 hari / `upstream_health` 7 hari + reset quota.
- **Prioritas:** Mid · **Status:** Todo · **Dependensi:** T-40, T-43 · **Estimasi:** 5h
- **File:** `src/entrypoints/worker.ts`, `scripts/backup.ts`, `src/routes/admin/settings/*`, `tests/integration/gc.test.ts`
- **Acceptance:** Backup otomatis muncul setelah jadwal; restore menghasilkan DB identik (row count per tabel); GC menghapus hanya data kedaluwarsa.

### T-47: (Backlog v2) OAuth 2.1 authorization server + vault per-user
- **Deskripsi:** Jadikan gateway MCP authorization server (RFC 8414 + Dynamic Client Registration), token vault per-user + refresh ke upstream (GitHub App/PKCE), `AuthInfo` dari token OAuth alih-alih API key.
- **Prioritas:** Low · **Status:** Todo · **Dependensi:** T-44 · **Estimasi:** 5 hari
- **File:** `src/lib/server/auth/*`, `src/routes/.well-known/*`

### T-48: (Backlog v2) HA multi-replica
- **Deskripsi:** Eksternalisasi state (session registry + EventStore + rate limit) ke Redis, sticky session di Caddy, opsi Postgres (Drizzle dialect), graceful drain saat rollout.
- **Prioritas:** Low · **Status:** Todo · **Dependensi:** T-47 · **Estimasi:** 5 hari
- **File:** `src/lib/server/{session,ratelimit}/*`, `deploy/docker-compose.yml`

---

## Matriks Dependensi (jalur kritis)

```
Setup   : T-01 → T-02 → T-03 → T-04 → T-05
Upstream:                T-05 → T-06 → T-07 → T-08 → T-09
Catalog : T-04 → T-10, T-11
Gateway : (T-02,T-10) → T-12 → T-14(+T-19 event) → T-15 → T-16 → T-13 / T-17 / T-18
Registry: (T-14,T-16) → T-19 → T-20
Govern  : T-19 → T-21 → T-23 → T-24 → T-22 → T-25 → T-26
AdminUI : T-05 → T-27 → T-28 → T-29 → T-30 → T-31 → T-32 → T-33 → T-34 → T-35
          T-30 + T-25 → T-36 → T-37   |   T-32 + T-20 → T-38   |   T-28 → T-39   |   T-30 → T-40 → T-41
Release : T-42 → T-43 → T-44   |   V1.1: T-45 (T-32,T-38), T-46 (T-40,T-43)   |   v2: T-47 → T-48
```

## Cara Memakai

- Jalankan per task: `kerjakan task` (skill implement-task akan memilih Todo prioritas High pertama sesuai dependensi).
- Update `Status` di file ini setiap task selesai (Todo → In Progress → Done).
- Perubahan skop → catat di bagian bawah file (log perubahan), jangan hapus task.

## Log Perubahan

| Tanggal | Perubahan |
|---|---|
| 2026-09-21 | Draft awal: 48 task dari Tech Spec v1.0 (V1.0 = T-01…T-44, V1.1 = T-45…T-46, backlog v2 = T-47…T-48) |
| 2026-09-21 | Event bus dipindah ke T-03; T-23/T-24 ditukar agar dependensi terurut topologis; jalur kritis & matriks dependensi dikoreksi; total jam V1.0 = 229 |
