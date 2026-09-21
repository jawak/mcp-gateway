# PRD: mcp-gateway

> **Status:** Approved for Tech Spec
> **Versi:** 1.0 · **Tanggal:** 2026-09-21
> **Stack:** Bun (runtime + server + `bun:sqlite`) · SvelteKit 2 (dashboard admin) · Transport: Streamable HTTP + API key

## Ringkasan Konsep

Satu endpoint MCP terpadu. Klien AI (Claude Code, Claude Desktop, Cursor, opencode, Windsurf) cukup **1 konfigurasi** (URL + API key) untuk mengakses **semua upstream MCP** (stdio maupun remote) yang di-setup terpusat di server. User lokal tidak perlu install atau menyimpan kredensial MCP apa pun di laptopnya.

---

# BAGIAN 1: Visi & Tujuan

## Visi Produk

AI coding tool (Claude Code, Cursor, opencode, Windsurf, Claude Desktop) hari ini menuntut pengguna mengonfigurasi setiap MCP server secara manual di tiap tool dan tiap project — duplikatif, rawan bocor kredensial di file lokal, dan tidak bisa dibagikan. **mcp-gateway** membalik modelnya: satu endpoint MCP terpadu yang mengagregasi seluruh upstream MCP (lokal maupun remote) di satu server tepercaya. Klien cukup menambah **1 konfigurasi**, langsung mendapatkan ratusan tool yang tersortir, ter-autentikasi, dan ter-monitor. Yang dulu menjadi beban setup per-user berubah menjadi satu kali setup per-organisasi.

## Tujuan Utama

1. **Zero local MCP setup** — pengguna baru produktif dengan 1 konfigurasi endpoint. *Indikator: waktu setup klien < 2 menit (dari menerima URL → tool pertama berhasil dipanggil).*
2. **Routing akurat &andal** — panggilan tool tiba di upstream yang benar tanpa tabrakan nama. *Indikator: tool routing accuracy ≥ 99,9%, uptime gateway ≥ 99,5%.*
3. **Overhead minimal** — gateway tidak boleh terasa oleh model. *Indikator: added latency p50 < 100 ms dan p95 < 300 ms untuk tool call (di luar durasi upstream), `tools/list` tersaji < 1,5 s untuk 500 tool.*
4. **Self-service untuk user non-teknis** — tambah/aktifkan MCP lewat UI, bukan edit JSON. *Indikator: non-developer mampu menambah 1 upstream MCP tanpa bantuan engineer.*
5. **Multi-user siap tim** — satu instance untuk individu sampai tim. *Indikator: ≥ 5 API key dengan scope berbeda berjalan terisolasi, log usage per-user dapat diaudit.*

## Value Proposition

- **1 endpoint, N server** — agregasi tools + resources + prompts dari banyak upstream MCP, termasuk namespaces anti-bentrok (`github__create_issue`, `sentry__list_events`).
- **Jalankan di server, pakai dari mana saja** — tidak perlu `npx`/`uvx`/Docker di laptop; cukup URL + API key, kredensial upstream tidak pernah menyentuh mesin lokal.
- **Setup sekali, pakai semua tool** — satu konfigurasi portable yang sama untuk Claude Code, Cursor, opencode, dan klien MCP lain.
- **Governance terpusat** — API key per orang/perangkat, allowlist tool per profil, rate limit, dan audit log pemanggilan.
- **Observability bawaan** — health check upstream, latensi, error rate, dan jumlah panggilan tool per user.

---

# BAGIAN 2: User Persona

### Persona 1: Arya — "AI-heavy developer yang muak copy-paste config"

- **Usia/Pekerjaan:** 28, AI/ML Engineer & indie hacker (pakai Claude Code, Cursor, opencode, Windsurf)
- **Level Teknis:** Mahir (nyaman JSON config, terminal, API key)
- **Tujuan:** Semua MCP favoritnya (GitHub, Sentry, Postgres, Tempo, Playwright) langsung tersedia di laptop kantor, laptop pribadi, dan mesin CI tanpa install apa pun.
- **Pain Points:** Config MCP dobel di 4 tool × N project; kredensial token berserakan di `~/.cursor` dan `~/Library/Application Support/Claude`; versi `npx` sering konflik; tiap ganti laptop harus setup ulang dari nol; 60+ tool menuhkan context window.
- **Motivasi:** Cukup 1 URL + 1 API key, tool langsung sama di semua perangkat. Setup sekali, hilang masalah berbulan-bulan.

### Persona 2: Nadia — "Platform engineer yang jadi jangkar MCP tim"

- **Usia/Pekerjaan:** 34, Platform / DevOps Engineer, pemilik instance gateway tim (15 developer)
- **Level Teknis:** Mahir soal infra & security, tapi tidak mau memelihara dashboard kustom
- **Tujuan:** Menyediakan katalog MCP terpusat (Sentry, Jira, internal DB) dengan akses terkontrol per orang/tim, kredensial hanya di vault server, dan ada audit trail siapa memanggil tool apa.
- **Pain Points:** Tiap onboarding engineer baru butuh 1–2 hari setup MCP + request akses; tidak tahu MCP mana yang benar-benar dipakai; upstream mati diketahui dari komplain user; kredensial dipegang 15 laptop.
- **Motivasi:** Onboarding jadi 5 menit (bagikan API key + profil), upstream mati ketahuan sendiri dari health check, bisa menjawab "siapa akses tool X" dalam 30 detik.

---

# BAGIAN 3: User Stories

### Modul 1 — Koneksi Klien

1. Sebagai developer, saya ingin melihat snippet konfigurasi siap tempel per tool (Claude Code, Cursor, opencode, generic HTTP), agar setup klien selesai < 2 menit.
2. Sebagai developer, saya ingin memakai 1 API key yang sama untuk beberapa perangkat, agar tidak perlu menyimpan banyak kredensial.
3. Sebagai developer, saya ingin membuat API key sendiri lewat UI, agar tidak perlu meminta ke admin.
4. Sebagai developer, saya ingin mencabut akses satu perangkat (revoke key), agar laptop lama tidak bisa lagi mengakses MCP.

### Modul 2 — Inti Gateway (agregasi & routing)

5. Sebagai klien MCP, saya ingin `tools/list` berisi tool dari semua upstream yang saya izinkan, agar model saya melihat satu katalog utuh.
6. Sebagai developer, saya ingin tool diberi namespace (`github__create_pr`), agar tool dengan nama sama dari upstream berbeda tidak saling menimpa.
7. Sebagai developer, saya ingin memanggil `resources/*` dan `prompts/*` juga (bukan hanya tools), agar workflow MCP saya lengkap.
8. Sebagai developer, saya ingin hanya upstream/tool yang saya butuhkan muncul, agar context window hemat dan akurasi pemilihan tool naik.

### Modul 3 — Registry & UI Admin

9. Sebagai admin, saya ingin menambahkan upstream lewat form (stdio atau remote URL), agar tidak perlu edit YAML manual.
10. Sebagai admin, saya ingin melihat status health tiap upstream (healthy/degraded/down + latensi), agar tahu penyebab kegagalan sebelum user melapor.
11. Sebagai admin, saya ingin disable satu upstream tanpa menghapusnya, agar bisa maintenance tanpa memutus konfigurasi orang lain.
12. Sebagai admin, saya ingin menyimpan kredensial upstream sebagai secret reference (env var), agar token tidak tertulis di repo/DB dalam bentuk plaintext.
13. Sebagai engineer, saya ingin manifest YAML tetap bisa dipakai sebagai sumber konfigurasi, agar bisa di-version-control dan di-deploy via CI.

### Modul 4 — Governance (profil & API key)

14. Sebagai admin, saya ingin membuat profil (kumpulan upstream + allowlist tool) dan menautkannya ke API key, agar tiap orang/tim hanya melihat tool yang relevan.
15. Sebagai admin, saya ingin mengatur rate limit & quota per key, agar satu user tidak melumpuhkan upstream shared.
16. Sebagai admin, saya ingin menetapkan mode akses per upstream (shared session vs per-user credential), agar tool yang write-heavy tetap terkontrol.

### Modul 5 — Observability

17. Sebagai admin, saya ingin melihat log pemanggilan tool (siapa, tool apa, durasi, status, error), agar bisa debug dan audit.
18. Sebagai admin, saya ingin metrik usage (top tools, panggilan per user, error rate) dan endpoint `/metrics`, agar bisa di-scraper Prometheus.

### Modul 6 — Marketplace/Template

19. Sebagai admin, saya ingin memilih MCP populer dari katalog template (GitHub, Sentry, Postgres, Filesystem, dsb), mengisi form kredensial, lalu langsung terpasang, agar onboarding upstream baru < 5 menit.

*(Total: 19 user stories)*

---

# BAGIAN 4: Functional Requirements

## Modul 1 — Autentikasi & API Key

### FR-01: Autentikasi klien (Bearer API key)

- **Input:** Header `Authorization: Bearer mcpgw_<key>` pada `POST/GET/DELETE /mcp`
- **Proses:** Hash key (SHA-256) → lookup di DB → cek status, expiry, IP allowlist → load profil & scope
- **Output:** Sesi MCP aktif, atau `401` (invalid) / `403` (suspended) / `429` (limit)
- **Aturan Bisnis:** Plain key hanya ditampilkan sekali saat dibuat; 10x kegagalan dari 1 IP dalam 1 menit → backoff 60 detik.

### FR-02: Pembuatan & pengelolaan API key

- **Input:** Nama key, profil terkait, masa berlaku, opsional IP allowlist
- **Proses:** Generate 256-bit random, simpan hash + metadata, kembalikan plaintext sekali
- **Output:** Key baru + snippet konfigurasi klien
- **Aturan Bisnis:** Minimal 1 profil aktif per key; key tanpa expiry default 90 hari.

### FR-03: Revoke & rotasi key

- **Input:** Key ID, aksi revoke/rotate
- **Proses:** Tandai revoked, tutup sesi aktif dalam ≤ 5 detik, opsional buat pengganti
- **Output:** Key tidak lagi bisa dipakai; audit event tercatat
- **Aturan Bisnis:** Rotate tidak mengubah profil/scope; revoked key tidak bisa di-restore.

### FR-04: Login admin dashboard

- **Input:** Email + password admin
- **Proses:** Verifikasi bcrypt/argon2, buat session cookie `HttpOnly Secure SameSite=Lax`
- **Output:** Akses `/admin`
- **Aturan Bisnis:** 5x gagal → blokir 15 menit; hanya role `admin` yang bisa mutate registry (`viewer` read-only).

## Modul 2 — Registry Upstream MCP

### FR-05: Tambah/edit upstream (stdio)

- **Input:** Nama, slug, `command`, `args`, `env` (secret ref), timeout, enabled
- **Proses:** Spawn via MCP SDK stdio transport → `initialize` handshake → simpan metadata
- **Output:** Upstream terdaftar + hasil handshake (nama, versi, jumlah tool)
- **Aturan Bisnis:** Slug `^[a-z0-9-]{2,32}$` unik; env yang hilang → status `unconfigured` (bukan crash).

### FR-06: Tambah/edit upstream (remote Streamable HTTP / SSE)

- **Input:** URL, auth header/secret ref, opsional custom headers, TLS verify toggle
- **Proses:** Handshake `initialize` + `initialized`, simpan capability upstream (tools/resources/prompts)
- **Output:** Upstream remote aktif
- **Aturan Bisnis:** `http://` ditolak kecuali `localhost`; SSRF guard blokir link-local/metadata IP.

### FR-07: Import/eksport manifest YAML

- **Input:** File `gateway.yaml` (import) atau trigger export
- **Proses:** Validasi skema → diff dengan registry → upsert; rahasia tetap sebagai `${ENV}` reference
- **Output:** Registry tersinkron + laporan diff (added/updated/removed)
- **Aturan Bisnis:** Import bersifat idempotent; secret plaintext di YAML ditolak dengan error eksplisit.

### FR-08: Health check & circuit breaker

- **Input:** Jadwal (default 30s) atau manual trigger
- **Proses:** Ping `tools/list` (atau `ping`) dengan timeout, catat latensi & error
- **Output:** Status `healthy`/`degraded`/`down`/`unconfigured` + timeline status
- **Aturan Bisnis:** 3 kegagalan berturut → `down` + keluarkan dari katalog; auto-recover setelah 2 keberhasilan; exponential backoff maks 5 menit.

### FR-09: Disable/enable upstream & hot reload

- **Input:** Toggle enabled, atau perubahan manifest
- **Proses:** Tutup koneksi upstream → invalidate cache tool → publish event perubahan
- **Output:** Katalog klien ter-update tanpa restart gateway
- **Aturan Bisnis:** Sesi yang sedang di tengah `tools/call` diizinkan selesai (grace 30s).

## Modul 3 — Inti Gateway MCP

### FR-10: Endpoint MCP tunggal + lifecycle sesi

- **Input:** JSON-RPC `initialize`, `tools/list`, `tools/call`, `resources/*`, `prompts/*`, `notifications/*` di `/mcp`
- **Proses:** Validasi protokol & version negotiation, routing ke handler internal/upstream, kembalikan respons
- **Output:** Respons JSON-RPC + header `Mcp-Session-Id`
- **Aturan Bisnis:** Sesi idle > 30 menit di-GC; mendukung `Mcp-Session-Id` & resumability via SSE `Last-Event-ID`.

### FR-11: Agregasi & namespacing tools

- **Input:** `tools/list` dari semua upstream aktif dalam scope key
- **Proses:** Prefiks `<slug>__<tool>`, deteksi duplikat, sanitasi charset, hash deterministik bila nama hasil > 64 char
- **Output:** Katalog tool gabungan dengan `description` + `_meta` (upstream, nama asli, versi, health)
- **Aturan Bisnis:** Nama hasil harus lolos `^[a-zA-Z0-9_.-]{1,64}$`; collision tetap terjaga via slug unik; cache per profil TTL 60s.

### FR-12: Routing `tools/call`

- **Input:** Nama tool ternamespace + arguments
- **Proses:** Parse slug → validasi allowlist → mapping balik ke nama asli → forward ke upstream (retry 1x untuk error transport) → stream progres
- **Output:** Hasil tool (`content`, `isError`) dengan nama asli di `_meta`
- **Aturan Bisnis:** Timeout default 60s (per-upstream configurable, maks 300s); payload request/response dibatasi 1 MB; argumen pass-through tanpa modifikasi.

### FR-13: Proksi resources & prompts

- **Input:** `resources/list`, `resources/read`, `prompts/list`, `prompts/get`
- **Proses:** Namespacing URI/nama dengan pola sama, fan-out agregasi, routing balik
- **Output:** Daftar & konten tergabung
- **Aturan Bisnis:** Upstream tanpa capability terkait dilewati; `resources/subscribe` didukung bila upstream mendukung, selain itu di-deklare tidak tersedia.

### FR-14: Filter tool per profil (hemat context)

- **Input:** Aturan profil: allowlist/denylist upstream dan pola glob nama tool
- **Proses:** Saring hasil agregasi sebelum dikirim ke klien
- **Output:** Katalog lebih kecil sesuai scope key
- **Aturan Bisnis:** Denylist menang atas allowlist; aturan dievaluasi saat request (bukan hanya saat cache dibuat).

## Modul 4 — Governance

### FR-15: Manajemen profil

- **Input:** Nama profil, upstream terpilih, aturan filter, rate limit, default timeout
- **Proses:** Simpan + hitung estimasi jumlah tool, validasi referensi upstream
- **Output:** Profil siap ditautkan ke key
- **Aturan Bisnis:** Profil yang dipakai ≥ 1 key aktif tidak bisa dihapus (harus reassign dulu).

### FR-16: Rate limit & quota

- **Input:** Konfigurasi per key/profil: request/menit, tool-call/jam, konkurensi
- **Proses:** Token bucket di memori (per key) + penghitung harian di SQLite
- **Output:** `200` atau `429` + header `Retry-After`, `X-RateLimit-Remaining`
- **Aturan Bisnis:** Default 120 req/menit & 1.000 tool-call/hari; konkurensi maks 10 call per key.

### FR-17: Audit trail

- **Input:** Setiap aksi admin (CRUD upstream/key/profil) dan tool call
- **Proses:** Append record (actor, aksi, target, timestamp, IP, request id)
- **Output:** Timeline di UI + dapat di-eksport CSV
- **Aturan Bisnis:** Audit log tidak dapat diubah/dihapus via API; retensi default 180 hari.

## Modul 5 — Observability

### FR-18: Log & metrik penggunaan

- **Input:** Event `tools/call` (durasi, status, upstream, ukuran payload, error message)
- **Proses:** Simpan ringkas di SQLite (payload penuh hanya saat debug diaktifkan), agregasi per jam/hari
- **Output:** Dashboard usage + `/metrics` format Prometheus (`mcp_tool_calls_total`, `mcp_tool_call_duration_seconds`, `mcp_upstream_healthy`)
- **Aturan Bisnis:** `/metrics` dilindungi token terpisah; retensi detail 30 hari.

### FR-19: Request tracing

- **Input:** `X-Request-Id` dari klien (atau digenerate)
- **Proses:** Propagasikan ke log gateway + upstream call, kembalikan di header respons
- **Output:** Satu ID untuk menelusuri 1 panggilan dari klien sampai upstream
- **Aturan Bisnis:** Export OpenTelemetry penuh di luar scope V1.

## Modul 6 — Marketplace/Template

### FR-20: Katalog template upstream

- **Input:** Katalog bundled (JSON statis): nama, ikon, deskripsi, skema form kredensial, contoh `command`/URL
- **Proses:** Pilih template → isi form → validasi secret → panggil FR-05/FR-06 → smoke test `tools/list`
- **Output:** Upstream baru aktif + pesan hasil smoke test
- **Aturan Bisnis:** Template hanya berisi instruksi publik (tanpa token); katalog bisa di-refresh/di-overlay dari URL internal; minimal 10 template terpasang di V1.

*(Total: 20 functional requirements)*

---

# BAGIAN 5: Non-Functional Requirements

## Performa

- TTFB `initialize` < 300 ms; `tools/list` (500 tool, cache hit) < 100 ms; (cache miss, 20 upstream) < 1,5 s
- Added latency per `tools/call`: p50 < 100 ms, p95 < 300 ms
- ≥ 1.000 sesi SSE aktif & ≥ 200 tool-call/detik per instance (Bun single-process, event-driven)
- Cold start gateway < 2 s; reload konfigurasi < 500 ms tanpa downtime

## Keamanan

- API key & secret upstream: disimpan sebagai hash/referensi vault (AES-256-GCM dengan key dari `MCPGW_MASTER_KEY`); tidak pernah di-log
- HTTPS/TLS 1.2+ wajib di produksi; HSTS; HTTP→HTTPS redirect
- Login admin: argon2/bcrypt (cost ≥ 12), rate limit, session `HttpOnly/Secure/SameSite=Lax`, CSRF token untuk semua mutating request
- SSRF guard untuk upstream remote (blokir `169.254.169.254`, `127.0.0.0/8` kecuali diizinkan eksplisit) + validasi skema `https://`
- Isolasi scope: 1 key tidak dapat melihat/memanggil tool di luar profilnya (uji wajib per-request)
- RBAC 2 role: `admin` (tulis), `viewer` (baca)

## Skalabilitas & Keandalan

- Target 50 pengguna aktif harian / 10 API key / 50 upstream / 1.000 tool teragregasi
- State sesi di luar proses untuk mode multi-replica (sticky session + Redis di v2); V1 single instance dengan graceful restart
- Tidak ada data hilang akibat restart: registry, key, profil di `bun:sqlite` (WAL); upstream stdio auto-restart
- Upstream `down` tidak boleh menurunkan gateway (degradasi sebagian, bukan failure total)
- Backup DB harian (retensi 14 hari)

## Usability

- Dashboard responsif (mobile/tablet/desktop); dark & light mode; UI teknis berbahasa Inggris + dokumentasi setup bilingual (EN/ID)
- Setup klien < 2 menit: snippet konfigurasi per tool dengan satu klik salin
- Waktu belajar UI admin < 15 menit tanpa dokumentasi; empty state & error message actionable (mis. "env `SENTRY_TOKEN` belum di-set")
- Aksesibilitas dasar WCAG 2.1 AA (kontras, fokus keyboard, label form)

## Kompatibilitas

- Mendukung MCP spec 2025-06-18 ke bawah (negotiasi versi)
- Terverifikasi di: Claude Code, Claude Desktop (remote), Cursor, opencode, mcp-remote
- Mendukung Node ≥ 20 / `npx`, `uvx`/Python, dan binary Docker untuk upstream stdio

---

# BAGIAN 6: Out of Scope & Dependensi

## Out of Scope (v2+)

- **OAuth 2.1 sebagai MCP authorization server** — V1 pakai API key → v2
- **Token vault per-user & refresh OAuth ke upstream** (GitHub App, PKCE per pengguna) → v2
- **Multi-tenant SaaS** (organization, billing, isolasi DB per tenant) — V1 individu/self-host tim
- **Semantic routing / auto-recommendation tool berbasis embedding** → v2
- **Editor `tools/list` dinamis** (rename, deskripsi kustom, merge tool lintas upstream) → v2
- **LLM proxy / prompt transformation & ringkasan output tool** → v2
- **Audit export ke SIEM & OpenTelemetry tracing penuh** → v2
- **Native mobile app** — web dashboard saja

## Dependensi

- **Runtime & framework:** Bun ≥ 1.2, `bun:sqlite` (registry, key, log), SvelteKit 2 + adapter-node, Vite, TypeScript
- **Protokol:** `@modelcontextprotocol/sdk` (client + server, Streamable HTTP & stdio), `zod` (validasi skema), JSON-RPC
- **UI:** Tailwind CSS + Flowbite/DaisyUI, Chart.js/ECharts untuk metrik, CodeMirror/Monaco untuk editor YAML & JSON preview
- **Auth & security:** `argon2`/`bcrypt`, `jose`, session cookie native/Lucia, native fetch/`undici`
- **Ops:** `prom-client` (Prometheus), `pino` (logging), Docker/`docker compose` untuk deploy, nginx/Caddy sebagai TLS terminator
- **Infra:** Server Linux (min 2 vCPU / 4 GB RAM), domain + TLS, env var untuk master key & secret upstream, GitHub Actions untuk test/build/publish image

## Asumsi

- Gateway berjalan di host tepercaya yang bisa menjangkau upstream (stdio butuh shell + Node/Python/Docker terpasang)
- Kredensial upstream disediakan admin sebagai env var/secret reference sebelum upstream dipakai
- Klien mendukung MCP Streamable HTTP (atau memakai `mcp-remote` sebagai penerjemah)
- Upstream MCP tidak bergantung pada state sesi yang ketat antar-request (stateless-friendly)
- Satu upstream boleh dipakai bersama (shared session); model per-user credential masuk v2
- User memiliki koneksi internet stabil dan akses dashboard via browser modern

---

## Catatan Ruang Lingkup

Target pengguna yang dipilih mencakup 4 segmen (individu, tim, platform, non-teknis) dan scope memilih 4 opsi sekaligus. Agar V1 tetap tercapai, pekerjaan dipecah bertahap:

| Tahap | Cakupan |
|---|---|
| **V1.0** | FR-01 – FR-18: endpoint MCP tunggal, namespacing & routing, resources/prompts, registry (UI + YAML), health check, API key, profil, rate limit, audit, log + `/metrics`, dashboard admin |
| **V1.1** | FR-19 tracing penuh, FR-20 template bundled (≥ 10), IP allowlist per key, backup/restore UI |
| **V1.2** | Katalog template yang bisa di-refresh dari sumber eksternal, usage report per tim, onboarding link |
| **v2** | OAuth 2.1 (server + upstream vault), multi-tenant, semantic routing, tool editor dinamis, LLM proxy, HA multi-replica |

## Langkah Berikutnya

1. Review & approve PRD ini.
2. Buat Tech Spec: `Buat Tech Spec berdasarkan PRD yang sudah dibuat`.
