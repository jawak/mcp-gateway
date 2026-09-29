# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |
| main    | yes       |

Security fixes land on `main` and in the latest `0.1.x` release. If you run an older
tag, upgrade first; a bug that is already fixed will not get a backport.

## Report a vulnerability

GitHub's private vulnerability reporting is the intake channel: open the Security tab
of this repository and choose "Report a vulnerability". That report reaches only the
maintainers.

If private reporting is unavailable to you, do NOT open a public issue with details. A
public write-up of an attack path turns every deployment of this gateway into a
target. Open an issue that says a vulnerability exists but contains no technical
detail, or hold the report until private reporting is back.

**Never paste `MCPGW_*` values, `Authorization` headers, API keys or credentials into
any report. Redact them.** A gateway key pasted into a report is itself an incident,
and the maintainers have no way to know every place a leaked value was copied from.

### What to include in a report

- The affected URL: the `/mcp` endpoint, a dashboard route, or an API path
- The upstream slug (for example `pg-dev`) when the report involves a specific upstream
- Reproduction steps: numbered and minimal
- The impact as you see it: what an attacker gains, and from where

## Scope

This gateway executes upstream commands as arbitrary code on the host that runs it.
Adding or editing an upstream sets a binary and arguments the gateway then spawns,
with no allowlist and no sandbox; see "What `command` can be" in the README.
Host-compromise reports are therefore in scope, and an admin account should be
treated like SSH access: anyone who can sign in as `admin` can run anything on that
machine, and a leaked admin session is a host compromise, not a data leak.

Also in scope: SSRF through remote upstreams, RBAC bypass, vault weaknesses, and any
path where a credential or a gateway key escapes redaction.

## Mitigations present

The gateway ships with controls measured in
[docs/nfr-report.md](./docs/nfr-report.md):

- Secrets live in a vault encrypted with AES-256-GCM and referenced as `secret:<name>`;
  the API surface lists secret names only, never values.
- Remote upstreams pass an SSRF guard: https only, private ranges and cloud metadata
  IPs refused, redirects not followed.
- RBAC is request-scoped and re-evaluated on every request at both `tools/list` and
  `tools/call`, so a key that guesses a scope outside its profile is refused rather
  than merely hidden from the listing.
- Passwords are hashed with argon2id, and login responses are enumeration-resistant:
  unknown accounts get the same message and the same timing.
- Every create and connection change records the resulting command line in an
  append-only audit trail, redacted.

## Response

A maintainer triages each report as it arrives and works on a best-effort basis;
there is no hard SLA. Follow up on the private report thread rather than a public
issue, so details stay out of public view while the fix is prepared.
