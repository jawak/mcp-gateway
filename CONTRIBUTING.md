# Contributing

Pull requests welcome. This file covers the mechanics: getting a dev environment up, the
gate CI runs, and how commits and PRs are written. The deep material lives in two places
already, so this file links to it instead of copying it and the two sources cannot drift:

- [Notes for contributors in the README](./README.md#notes-for-contributors): the runtime
  invariants that affect tests, startup, and spawning, with the reasoning behind each.
- [`docs/nfr-report.md`](./docs/nfr-report.md): measured latency, concurrency and
  rate-limit behavior, and the defects found getting there.

## Quickstart

```sh
# fork the repo on GitHub, clone your fork, then:
git checkout -b my-fix
bun install
cp .env.example .env      # set MCPGW_MASTER_KEY + MCPGW_ADMIN_PASSWORD
bun run dev               # dashboard + /mcp on http://localhost:5173
```

That's the whole setup. `bun run dev` migrates the database and bootstraps the admin by
itself, so a fresh clone runs with one command and `bun run db:migrate` is never required
first. Two values in `.env` are worth filling in before you rely on the login page:
`MCPGW_MASTER_KEY` (64 hex chars, `openssl rand -hex 32`) and `MCPGW_ADMIN_PASSWORD` (at
least 12 characters; a shorter one is reported at boot and the account is not created,
though the gateway still starts). Blank variables count as unset, so the copied example
file boots as-is either way.

If you're working on the worker, `bun run worker:dev` runs it from TypeScript source with
no build step.

## Tests, build, and the CI gate

`bun run verify` is the gate: check + lint + test + build, in that order. The CI workflow
runs the same four steps explicitly on every pull request, then a separate `smoke` job
boots the production build and drives a real MCP client through login, upstream,
profile, key, and `tools/call` over `/mcp`. If your change touches startup, the
registry, or anything that path walks, `smoke` is the job watching it and the first line
of its log is the interesting one, before the failure cascades.

`bun run test` runs on `bun:test`, not Vitest, because the data layer is `bun:sqlite`,
which Node cannot load. There is no Vitest config in the repo to find and none to add.
When you change startup, readiness, or the registry, the README's notes for contributors
say what kind of test case to add; read that section rather than guessing.

`bun run lint` is `prettier --check . && eslint .`, which covers every `.md` file too.
Markdown goes through Prettier like everything else; `bun run format` fixes wrapping and
`bun run verify` will catch it before CI does.

## Commit style

Conventional commits, matching the repo log:

```text
fix: the smoke script sent the default password CI never bootstrapped
chore: prettier indentation on the stripe fixture
test(redact): build the stripe fixture from parts
```

The shape is `type(scope): summary`, all lowercase. The summary is a full sentence that
says what was wrong or what changed, not a two-word label, because a year from now
`git log --oneline` is the only story anyone reads. Scope is optional; use it when the
area matters, as in `test(backup):`.

## Pull requests

Fill in [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md): what
changed, why, and how you verified it, including any command you ran and what it printed.
Expect the CI workflow on the PR with its checks for `verify`, `smoke`, and an image build, all green
before review. If `smoke` fails on a PR that didn't touch the gateway, read its log from
the top anyway; a credential or environment mismatch between the bootstrap and the smoke
steps shows up as a failure that points at the wrong thing, and the comments in the
workflow explain what to look for.
