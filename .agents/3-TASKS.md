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
- **Prioritas:** High · **Status:** Done · **Dependensi:** — · **Estimasi:** 3h
- **File:** `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.editorconfig`, `src/app.css`, `src/app.d.ts`
- **Acceptance:** `bun install`, `bun run check`, `bun lint`, `bun run build` hijau; halaman `/` default SvelteKit ter-render.
- **Catatan implementasi (2026-09-21):**
  - Scaffold: `bunx sv@0.17 create --template minimal --types ts --add prettier eslint vitest="usages:unit" tailwindcss="plugins:none" sveltekit-adapter="adapter:node" --install bun` → **`svelte.config.js` tidak lagi dibuat**, adapter dikonfigurasi di `vite.config.ts` (`sveltekit({ adapter: adapter() })`).
  - Dep runtime dipasang sekaligus: `@modelcontextprotocol/sdk@1.30.0`, `zod@4.6.5` (v4!), `argon2`, `pino`, `prom-client`, `yaml`, `drizzle-orm`; dev: `drizzle-kit`, `@types/bun`, `flowbite(-svelte)`, `chart.js`, `codemirror`, `pino-pretty`.
  - `src/routes/layout.css` → `src/app.css` (sesuaikan `prettier.config.js: tailwindStylesheet`); contoh vitest bawaan dihapus; vitest dipecah project `unit` (`tests/unit`) + `integration` (`tests/integration`, `pool: forks`).
  - `.prettierignore` menambah `/.agents/` agar dokumen spec tidak di-reformat; `--passWithNoTests` di script test.
  - **Penting untuk T-02:** output adapter-node (`.svelte-kit/output/server/index.js`) hanya meng-*export* handler, tidak listen sendiri → `Bun.serve` + `@sveltejs/adapter-node/handler` memang wajib. Verifikasi build: `bun run preview`.
  - Gate hijau: `check` 0 error · `lint` pass · `test` pass · `build` pass · `preview /` HTTP 200. Commit `cba6a7e`.

### T-02: Custom server Bun + router `/mcp` `/metrics` `/healthz`
- **Deskripsi:** Buat `src/entrypoints/server.ts` (Bun.serve → `handleFetch`) dan `src/handle.ts` sebagai router: `/mcp` → stub handler `501` (diisi T-18), `/metrics` → stub, `/healthz` → JSON `{ ok, version, upstreams, sessions }`, sisanya → SvelteKit handler dari adapter-node. Graceful shutdown (drain 30s), `maxBodySize: 1_048_576`, `MCPGW_TRUST_PROXY` → IP dari `X-Forwarded-For` 1 hop. Script `start` yang resolve build output adapter-node.
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-01 · **Estimasi:** 5h
- **File:** `src/entrypoints/server.ts`, `src/entrypoints/worker.ts`, `src/handle.ts`, `src/lib/server/http/{bridge,static}.ts`, `src/lib/server/{runtime,registry/events}.ts`, `src/lib/server/observability/{logger,status}.ts`, `scripts/build-server.ts`, `tests/unit/*`
- **Acceptance:** `bun run build && bun run start` → `GET /healthz` 200 JSON, `GET /` 200 HTML, `POST /mcp` 501, 404 untuk rute lain.
- **Catatan implementasi (2026-09-21):**
  - **Koreksi arsitektur Tech Spec:** `Bun.serve` tidak bisa digabung dengan handler `node:http` (`Bun.server()` tidak ada di Bun 1.4). Entry production = `node:http` (dijalankan Bun) + bridge web⇄node sendiri (`http/bridge.ts`) → `/mcp` tetap pakai `Request`/`Response` (prasyarat `WebStandardStreamableHTTPServerTransport` di T-12), SvelteKit tetap satu origin.
  - **Koreksi API:** SvelteKit 2.70 `Server` tidak punya `.render()` — yang benar **`.respond(request, { getClientAddress })`**; `@sveltejs/kit/manifest` bukan export publik → `Server` + `manifest.js` di-resolve runtime dari `.svelte-kit/output/server/` (maka runtime butuh folder itu, dicatat untuk Docker T-43).
  - Static `build/client` dilayani `Bun.file` (immutable untuk `/_app/immutable/*`, ETag+304, guard traversal).
  - tsconfig menambah `"types": ["bun","node","vite/client"]`; versi diambil dari import JSON (di-inline bundler, tanpa baca file saat runtime).
  - Gate: check 0 error · lint pass · 16 test pass · build pass. Smoke: `/healthz` 200, `/` 200 SSR, `/nope` 404, `POST /mcp` 503 `not_mounted`, `PUT /mcp` 405 + allow, `/metrics` 501, body > limit → 413, ETag → 304, SIGTERM → exited bersih. Commit `11b4449`.

### T-03: Config loader + logger
- **Deskripsi:** `lib/server/config.ts` memuat + validasi env dengan Zod (semua var di Tech Spec Bagian 5, termasuk default), fail-fast dengan pesan jelas; `observability/logger.ts` (pino, pretty di dev, redaction hook dari T-04); `version` dari `package.json`; `registry/events.ts` — event bus in-memory bertipe (publish/subscribe + `close()`) yang dipakai lintas modul (`upstream.changed`, `profile.changed`, `health.changed`, `key.revoked`).
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-02 · **Estimasi:** 3h
- **File:** `src/lib/server/config.ts`, `src/lib/server/observability/logger.ts`, `src/lib/server/registry/events.ts`, `src/lib/server/http/forwarded.ts`, `.env.example`, `tests/unit/config.test.ts`, `tests/unit/events.test.ts`
- **Acceptance:** Boot tanpa `MCPGW_MASTER_KEY` → error eksplisit dan exit non-zero; log berisi `requestId`; `MCPGW_MASTER_KEY` tidak pernah muncul di output log; subscriber event menerima payload bertipe dan unsubscribe berfungsi.
- **Catatan implementasi (2026-09-21):**
  - `loadConfig()` agregat semua error dalam satu `ConfigError` (operator memperbaiki `.env` sekali jalan), strict saat `NODE_ENV=production`, lenient di dev (kunci ephemeral + warning keras) agar `bun run dev` tetap jalan.
  - `MCPGW_COOKIE_SECRET` diturunkan dari master key via HKDF bila tidak di-set; `masterKeyVersion` disiapkan untuk re-seal (T-46).
  - Event bus memakai `Map<EventName, Set<...>>` (tipe generik per-event tidak bisa disimpan di object literal tanpa cast).
  - `runtime.ts` dihapus → konfigurasi dari `config.ts`, IP client ke `http/forwarded.ts`.
  - Verifikasi: `NODE_ENV=production bun build/server.js` tanpa key → pesan jelas + **exit code 1**. Commit `74fa48f`.

### T-04: Schema DB, migrasi, seed
- **Deskripsi:** Drizzle schema lengkap sesuai Tech Spec Bagian 2 (14 tabel: `users`, `web_sessions`, `upstreams`, `secret_refs`, `upstream_health`, `profiles`, `profile_upstreams`, `api_keys`, `mcp_sessions`, `tool_calls`, `usage_hourly`, `audit_log`, `kv`, `templates_applied`) + index strategy. Koneksi `bun:sqlite` (WAL, `busy_timeout=5000`, FK on), `migrate.ts` (buat folder data, catat `kv.schema_version`), `seed.ts` bootstrap admin dari env, `ids.ts` (UUIDv7), `shared/schemas.ts` (Zod untuk upstream/profile/key/manifest), `scripts/backup.ts`.
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-03 · **Estimasi:** 8h
- **File:** `src/lib/server/db/{index,schema,migrate,seed}.ts`, `src/lib/shared/{ids,time}.ts`, `src/lib/server/security/password.ts`, `drizzle.config.ts`, `drizzle/0000_init.sql`, `scripts/{migrate,backup}.ts`, `tests/unit/ids.test.ts`, `tests/integration/db.test.ts`
- **Acceptance:** `bun run db:generate && bun run db:migrate` membuat `./data/mcpgw.db` berisi semua tabel + index; admin bootstrap terbuat; `bun run db:migrate` kedua kali no-op; FK `ON DELETE` teruji di test.
- **Catatan implementasi (2026-09-21):**
  - 14 tabel + composite PK `profile_upstreams(profile_id, upstream_id)` dan `usage_hourly(bucket_hour, api_key_id, upstream_id, tool)`; `shared/schemas.ts` ditunda ke modul yang membutuhkannya (T-19/T-32) agar tidak menebak bentuk payload.
  - Migrasi hanya dijalankan proses API saat boot (single writer); worker memanggil `waitForMigrations()` (timeout → error, bukan hang). Versi disimpan di `kv.schema_version`.
  - Seed idempoten: email dinormalisasi lowercase, password tidak pernah ditimpa, hash argon2id (64MiB/t=3/p=4). `security/password.ts` lebih dulu dikerjakan (dibutuhkan seed); T-05 melengkapi modul security lainnya.
  - Backup memakai `VACUUM INTO` (aman terhadap writer WAL) + retensi + `kv.last_backup_at`.
  - **Perubahan tooling:** test runner pindah ke **`bun:test`** karena `bun:sqlite` tidak tersedia di vitest/node; `vitest` di-remove; `verify` script = check+lint+test+build.
  - Temuan: UUIDv7 8 karakter pertama = timestamp → jangan dipakai sebagai slug unik (test menemukan ini). FK `api_keys.profile_id` bertindak sebagai backstop BR-08 (profil berisi key aktif tidak bisa dihapus). Commit `99ad3d7`.

### T-05: Vault, env-resolve, password, redact
- **Deskripsi:** `security/vault.ts` (HKDF-SHA256 + AES-256-GCM, simpan `cipher/iv/tag/key_ver`, rotasi), `env-resolve.ts` (resolve `${ENV}` / `secret:<name>`, deteksi env hilang), `password.ts` (argon2id `m=64MB,t=3,p=4` + dummy verify untuk timing safety), `redact.ts` (pola `ghp_`, `github_pat_`, `xoxb-`, `sk-`, JWT, `Bearer …`), `ssrf.ts` (blokir non-https selain localhost, range privat, `169.254.169.254`, redirect ditolak).
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-04 · **Estimasi:** 6h
- **File:** `src/lib/server/security/{vault,env-resolve,password,redact,ssrf}.ts`, `tests/unit/{vault,redact,env-resolve,ssrf}.test.ts`
- **Acceptance:** Round-trip seal/open lulus; GCM tag diubah → throw; argon2 verify benar/salah benar; `redact` menutup semua pola test; `ssrfFetch` menolak `http://`, `127.0.0.1`, `169.254.169.254` dan mengizinkan `https://api.github.com`.
- **Catatan implementasi (2026-09-21):**
  - Vault: AES-256-GCM, IV 12 byte acak per seal, subkey HKDF per `keyVer` → tamper/wrong-key → `VaultError('auth-failed')`; input rusak → `VaultError('malformed')`; `masterKeyId()` untuk audit rotasi.
  - Env refs: `${VAR}` | `secret:<name>` | literal; ref non-eksak (`prefix-${HOST}`) dianggap literal, bukan lookup diam-diam; ref gagal → `missing[]` (upstream jadi `unconfigured`, gateway tetap hidup). `baseProcessEnv()` membatasi env child ke 8 nama non-secret.
  - Redact: 15 pola kredensial + masking by-key; pola `assignment` mempertahankan nama key agar log tetap berguna; `findSecretLike()` untuk gerbang import manifest (BR-09).
  - SSRF: https-only (loopback dikecualikan untuk dev), tolak kredensial di URL, resolve DNS lalu tolak bila **salah satu** jawaban loopback/private/link-local(169.254.169.254)/multicast, `redirect: 'error'`, `AbortSignal.timeout`. Resolver bisa di-inject (test offline deterministik). `createSsrfSafeFetch()` cocok dengan tipe `FetchLike` SDK → T-07 tidak perlu cast.
  - Known limitation (didokumentasikan di kode): TOCTOU DNS rebinding antara validasi dan request → perbaikan pinning IP masuk v2. Commit `9b386b1`.

---

## MODUL: Upstream (koneksi & health)

### T-06: Upstream stdio (spawn + handshake)
- **Deskripsi:** `upstream/stdio.ts` memakai `StdioClientTransport`: spawn dengan env hasil sanitization (hanya `PATH/HOME/LANG/NODE_ENV/TMPDIR` + env yang dipetakan eksplisit via `env_refs`), `cwd` opsional, handshake `initialize` (timeout), capture `serverInfo`/`capabilities`/`tools_count`, tangani child exit → status `down` + `last_error`, auto-restart dengan backoff. Env wajib hilang → status `unconfigured` (tanpa spawn).
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-05 · **Estimasi:** 6h
- **File:** `src/lib/server/upstream/{types,stdio,restart}.ts`, `tests/fixtures/echo-mcp-server.ts`, `tests/integration/stdio-upstream.test.ts`
- **Acceptance:** Fixture MCP server (stdio) tersambung, `tools/list` berisi tool fixture; `MCPGW_MASTER_KEY` tidak terlihat oleh child (diverifikasi lewat fixture yang echo env); child dibunuh → status `down`, restart ≤ backoff.
- **Catatan implementasi (2026-09-21):**
  - `UpstreamHandle` = kontrak tunggal untuk stdio + remote → pool/health/gateway tidak bercabang sesuai transport.
  - **Self-heal:** setiap jalur request memanggil `ensureAlive()`; anak yang mati di antar-call di-respawn (backoff + `UpstreamCoolingDownError` saat belum boleh respawn) → crash = 1 call terlambat, bukan upstream mati permanen.
  - stderr anak → ring buffer 40 baris yang sudah diredaksi, muncul di halaman detail upstream.
  - `close({graceMs})` menunggu `inFlight` selesai (BR-12); `graceMs: 0` memutus call yang berjalan.
  - Fakta SDK penting: `Protocol.connect()` **menggabungkan** `transport.onclose` yang sudah ada (jadi handler kita tetap jalan), dan `_stderrStream` tersedia sejak konstruksi (bisa di-attach sebelum `connect`).
  - Fakta MCP penting: exception di handler upstream → hasil `isError:true`, **bukan** error transport — retry T-16 hanya untuk `UpstreamTransportError` (`explode` vs `suicide` di fixture).
  - Test script memakai `--timeout 20000` karena uji crash/respawn butuh lebih dari 5 s default. Commit `f9a18c7`.

### T-07: Upstream remote HTTP + SSRF guard
- **Deskripsi:** `upstream/remote-http.ts` dengan `StreamableHTTPClientTransport` (atau varian Web-standard) + `ssrfFetch` sebagai `fetch`; auth header dari `headers_ref`; `TLS verify` toggle; handshake & capability capture; timeout connect 5 s; dukung SSE resume via `Last-Event-ID` bila upstream mengirimnya.
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-06 · **Estimasi:** 5h
- **File:** `src/lib/server/upstream/remote-http.ts`, `src/lib/server/config.ts`, `tests/fixtures/{register-tools,http-mcp-server}.ts`, `tests/integration/remote-upstream.test.ts`
- **Acceptance:** Terhubung ke MCP server HTTP lokal (fixture) dan memanggil 1 tool; URL `http://` (non-localhost) dan metadata IP → ditolak dengan error actionable.
- **Catatan implementasi (2026-09-21):**
  - `authStyle`: `bearer` (default, menambah prefix `Bearer ` bila kredensial belum memuatnya) | `header` (kirim mentah, `authName` kustom) | `none`; `headersRef` menerima JSON objek secret dari vault untuk header statis tambahan. `ssrf-fetch.ts` tidak dibuat terpisah — `security/ssrf.ts` (T-05) sudah menyediakan `createSsrfSafeFetch` yang cocok dengan tipe `FetchLike` SDK.
  - Env baru: `MCPGW_ALLOW_PRIVATE_NETWORK` (default false; link-local/metadata tetap diblokir), `MCPGW_ALLOW_INSECURE_TLS`, `MCPGW_UPSTREAM_CONNECT_TIMEOUT_S`.
  - **3 jebakan yang ditemukan lewat test (dicatat agar tidak terulang):**
    1. fixture stateless wajib `enableJsonResponse: true` — tanpa itu respons berupa stream SSE yang terpotong.
    2. jangan tutup server/transport saat `request.signal` abort: Bun sudah men-settle signal itu begitu request body dikonsumsi → tool lambat tidak pernah dijawab (client timeout).
    3. exception di handler MCP upstream menjadi hasil `isError`, bukan error transport — retry T-16 hanya untuk `UpstreamTransportError`.
  - Fixture dibagi: `registerFixtureTools()` dipakai stdio & HTTP + tool `slow_watchdog` untuk uji pembatalan nanti. SSE resume (`Last-Event-ID`) diuji pada sisi server kita sendiri di T-12.

### T-08: Pool koneksi upstream
- **Deskripsi:** `upstream/pool.ts`: mode `pinned` (warm saat boot) vs `lazy` (spawn on-demand), LRU + `idleTtl` 10 menit, maks `MCPGW_MAX_LIVE_UPSTREAMS`, semaphore konkurensi per upstream, `close(slug, { grace: 30_000 })` yang menunggu `tools/call` aktif selesai, `closeAll()` untuk shutdown, event `pool:*` untuk observability.
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-06 · **Estimasi:** 6h
- **File:** `src/lib/server/upstream/pool.ts`, `tests/integration/pool.test.ts`
- **Acceptance:** `get()` dua kali → 1 koneksi; idle > TTL → tertutup (spawn count naik lagi setelah `get()`); `close()` saat call aktif → call selesai lalu koneksi ditutup; jumlah proses child = 0 setelah `closeAll()` (dicek via `ps` di test).
- **Catatan implementasi (2026-09-21, `d5e3fd2`):**
  - `get()` idempoten per upstream; reconnect otomatis bila `connection`/`env_refs`/`timeout` berubah; connect yang bersamaan untuk slug sama digabung (1 proses, bukan N).
  - Eviction LRU hanya menyentuh upstream `lazy` dan memakai tie-breaker monotonic agar deterministik (dua touch dalam milidetik yang sama pernah membuat tes tidak stabil).
  - Semaphore FIFO per upstream + `queueWaitMs` → overload jadi error bersih, bukan antrian tak terbatas.
  - **2 bug nyata yang ditemukan test:** (1) setelah upstream dirilis, `#releaseSlot` sempat menyerahkan slot mati ke pengantri — sekarang pengantri ditolak; (2) `StdioClientTransport.close()` hanya menutup stdin + SIGTERM lewat timer `unref` → handle stdio kini menunggu, SIGTERM, lalu SIGKILL; test membuktikan 0 proses anak tersisa setelah `closeAll()`.


### T-09: Health checker + circuit breaker
- **Deskripsi:** `upstream/health.ts`: probe `ping` bila capability ada, else `tools/list` (timeout 5 s); transisi `healthy/degraded/down/unconfigured` per BR/Alur 4 (3× gagal → `down`, 2× sukses → `healthy`, `degraded` saat latensi > 50% timeout); backoff eksponensial ≤ 5 menit; lewati upstream `lazy` tanpa koneksi hidup; tulis `upstream_health`; emit `registry.healthChanged` → invalidasi catalog + gauge metrics. `worker.ts` sebagai scheduler loop (`MCPGW_HEALTH_INTERVAL_S`).
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-08 · **Estimasi:** 5h
- **File:** `src/lib/server/upstream/health.ts`, `src/entrypoints/worker.ts`, `tests/unit/health.test.ts`
- **Acceptance:** Tabel transisi teruji (fake probe): 2 gagal → masih healthy, 3 → down, 2 sukses → healthy; interval probe mengikuti backoff; worker tidak menjalankan probe saat `schema_version` belum cocok.
- **Catatan implementasi (2026-09-21, `5628a10`):**
  - Probe = `ping` bila capability ada, else `tools/list` (cap 5 s); `degraded` di atas 50% `timeout_ms`; 3 gagal → `down`, 2 sukses → `healthy`.
  - **Keputusan desain:** backoff hanya mem-throttle upstream yang sudah `down` (sesuai PRD "interval probe upstream *down* = 30s × 2ⁿ, maks 5 menit") — kalau tidak, upstream flapping butuh menit untuk dinyatakan down.
  - Upstream `lazy` yang belum hidup tidak di-probe (menjawab "apakah dia hidup?" tidak boleh menghasilkan spawn proses).
  - Baris `upstream_health` memakai `upstream_id` (FK) dan error yang sudah diredaksi; `/healthz` diisi ulang tiap sweep; event `health.changed` dikirim ke bus.
  - Worker: tunggu schema → sweep langsung → interval; sweep yang tumpang-tindih dilewati; SIGTERM menguras pool.
  - Log `transport.onerror` diturunkan ke debug tanpa stack (health yang melaporkan transisi) — sebelumnya 3 stack besar per probe gagal.


---

## MODUL: Catalog & Namespacing

### T-10: Namespacing tool
- **Deskripsi:** `mcp/namespacing.ts`: `qualify(slug, name)` = `<slug>__<name>`, sanitasi charset, aturan > 64 char (`slug[..12]-<b32(sha1)>__<name[..31]-<hash6>>`), `split(gname)`, `build()` menghasilkan `{ list, byName }` dengan deteksi collision → error eksplisit (bukan rename diam-diam). Kontrak simetris `split(qualify(x)) === x`.
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-04 · **Estimasi:** 4h
- **File:** `src/lib/server/mcp/namespacing.ts`, `tests/unit/namespacing.test.ts`
- **Acceptance:** 200+ nama (termasuk Unicode, spasi, >64 char) lolos regex `^[A-Za-z0-9_.-]{1,64}$`; collision → throw; properti test (fast-check) untuk simetri.
- **Catatan implementasi (2026-09-21, `e165494`):**
  - `qualify()` sanitasi ke `[A-Za-z0-9_.-]`, dan untuk nama > 64 char memakai `slug[0..12]-<hash6>__tool[0..31]-<hash6>` (hash sha1 atas nama penuh) → deterministik dan nama panjang berbeda tidak runtuh ke satu nama.
  - `build()` mengumpulkan **semua** collision (dalam satu upstream maupun lintas upstream) lalu melempar `NamespacingError`; tidak pernah rename diam-diam karena tool kedua jadi tak terjangkau tanpa ada yang sadar.
  - Property test 4000 kombinasi slug/tool acak (termasuk Unicode/spasi/karakter kontrol) memvalidasi bentuk, batas 64, determinisme, dan tingkat collision hasil truncation.


### T-11: Filter glob profil
- **Deskripsi:** `shared/glob.ts` (`*`, `?`, `[…]`, tanpa regex injection) + evaluasi deny > allow untuk nama tool, resource URI, dan prompt name (BR-03).
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-04 · **Estimasi:** 2h
- **File:** `src/lib/shared/glob.ts`, `tests/unit/glob.test.ts`
- **Acceptance:** Test matrix: `["*"]` + deny `["*delete*"]`; pattern ilegal (mis. `[a-`) → `ValidationError`; perform < 1 ms untuk 1.000 nama.
- **Catatan implementasi (2026-09-21, `e165494`):**
  - Glob diterjemahkan manual ke RegExp ber-anchor (`^...$`) — input user tidak pernah masuk apa adanya ke `new RegExp()`; metachar regex (`| ( ) { }` dll) diperlakukan literal.
  - Didukung: `*`, `?`, `[a-c]`, `[!a-c]`/`[^a-c]`, escape `\`, dash pertama/terakhir dalam class sebagai literal. Ditolak dengan `GlobPatternError`: class belum ditutup/terbalik (`[9-0]`), class kosong, escape menggantung, pola kosong, pola > 256 char.
  - `isAllowed()` mewajibkan deny menang atas allow (BR-03); `assertValidPatterns()` siap dipakai form admin (FR-14); hasil kompilasi di-cache (10 ribu evaluasi pola < 50 ms).


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
- **Prioritas:** High · **Status:** Done · **Dependensi:** T-14, T-16 · **Estimasi:** 6h
- **File:** `src/lib/server/registry/index.ts`, `tests/integration/registry.test.ts`
- **Acceptance:** Disable 1 upstream → katalog berubah < 500 ms (asserted), upstream lain tetap hidup (spawn count tidak berubah); hapus profil terpakai → ditolak; update slug → ditolak.
- **Catatan implementasi (2026-09-21):**
  - Snapshot in-memory (`upstreamsById`/`upstreamsBySlug`/`profilesById`) di-reload tiap tulis; `scopeForProfile()` siap dipakai agregator (T-14) tanpa query tambahan.
  - **Keputusan penting:** `api_keys.profile_id` adalah `NOT NULL` dengan FK RESTRICT, jadi menghapus profil tetap gagal meski semua key sudah revoked/expired. `deleteProfile()` kini (a) menolak bila ada key **aktif** (BR-08) lalu (b) menghapus key historis dalam transaksi yang sama — `tool_calls` selamat (`ON DELETE SET NULL`) dan jejak audit tetap ada.
  - Event bus sengaja dispatch-nya asinkron (handler tidak boleh memblokir penulis); test harus memberi satu tick sebelum asersi.
  - Reload setelah disableterbukti < 100 ms (budget BR-12 500 ms) dan upstream lain tidak tersentuh.
  - Commit `5f4a...` (lihat `git log` T-19).
