# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-09-29

### Fixed

- the upstream-creation form now seals its inline "New secret" field BEFORE validating env references — a form whose env line references the secret typed in the same form now works in one submission.
- the image also carries the container-smoke CI change already pushed after 0.1.2 (the image job boots the container and smokes the packaged image).

## [0.1.2] - 2026-09-29

### Fixed

- the container image ships its SQL migrations, so a fresh `docker run` boots; boot-failure log entries now name the exact cause.

## [0.1.1] - 2026-09-29

### Added

- `http://<ip>:<port>` now works for private and loopback public URLs (a VM's local IP)
  in production, with an `MCPGW_ALLOW_HTTP=true` opt-in for plain http to public hosts.

## [0.1.0] - 2026-09-29

Initial public release of mcp-gateway: one MCP endpoint for many MCP servers. Point
Claude Code, Claude Desktop, Cursor, opencode or Windsurf at a single URL and API key
to reach every upstream MCP tool the gateway admin has configured.

### Added

- stdio upstreams are spawned server-side, so nothing installs on your laptop and no
  upstream credential ever lives there.
- A vault that stores upstream credentials with AES-256-GCM and `secret:<name>`
  references, plus `${ENV_VAR}` support to read the gateway's own environment. A
  credential typed into an env line is refused on every path.
- Per-profile scoping re-evaluated on every request at both `tools/list` and
  `tools/call`, so a key issued for one profile that guesses another profile's tool is
  refused rather than merely hidden from the listing.
- Slug-based namespacing that gives each upstream its own child process and tool
  namespace, so the same MCP server can run against a dev and a prod database at once
  without the two being shared or deduplicated.
- RBAC, API keys and rate limits, plus a login page and an admin dashboard with form
  actions for every mutation.
- `/metrics`, `/healthz`, an audit trail and structured logs.
- A Docker + Caddy self-host deploy stack: TLS with SSE-safe proxying, the gateway, and
  a separate worker so maintenance never delays a request. The worker runs a health
  sweep, session GC, retention and daily snapshots.
- `smoke` and `loadtest` scripts: an end-to-end run driven with a real MCP client, and
  added-latency, concurrency and rate-limit measurement against a running instance.
- OSS-readiness housekeeping: Apache-2.0 LICENSE, SECURITY, CONTRIBUTING and
  CODE_OF_CONDUCT policies, issue and PR templates.
