# Datadog MCP Server over OAuth (EU runbook)

This is the operator runbook for connecting the gateway to Datadog's hosted MCP server
with `authMode: oauth`. It uses the Datadog EU1 site as the worked example; the same steps
apply to other commercial sites with that site's MCP host. Government sites are not
supported by Datadog's MCP server.

## Shared identity, not per-user OAuth

The gateway implements a **shared OAuth client** per upstream: one dynamic client
registration and one consent grant, reused by every caller.

| Concern              | What actually happens                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Who authorizes       | One gateway admin clicks Connect and completes the Datadog consent screen once per upstream.                                                |
| Who calls            | Every gateway API key, profile, and MCP session acts as the Datadog user who consented. The gateway does not forward the caller's identity. |
| Datadog permissions  | That user's roles, RBAC, data access controls, and IP allowlist apply to every tool call.                                                   |
| Datadog Audit Trail  | MCP Server events attribute to the consenting Datadog user, not to an individual gateway key holder.                                        |
| Revocation / expiry  | Revoking the grant or disconnecting the upstream affects **all** gateway callers.                                                           |
| Per-user attribution | Not offered. Do not promise per-user identity or per-key Datadog attribution.                                                               |

If you need different Datadog identities for different teams, use separate upstreams and
separate consents. They are still shared within each upstream.

## Before you start

### Datadog side (one-time, administrator)

1. You need a Datadog organization on a commercial site. This runbook uses EU1
   (`app.datadoghq.eu`).
2. In **Organization Settings → Preferences**, confirm **MCP Access** is enabled. Nothing
   connects while it is off.
3. Enable **MCP Write Access** only if the upstream must create or modify Datadog
   resources. It is off by default.
4. Make sure the consenting user's role has `mcp_read`, plus `mcp_write` for write tools,
   plus the normal resource-level permissions for the toolsets you expose. The Datadog
   Standard role has both MCP permissions by default; custom roles need them added under
   **Organization Settings → Roles**.
5. Keep an administrator available for the redirect allowlist in step 2 below. Only an
   organization admin can change it.

### Gateway side

1. Set `MCPGW_PUBLIC_URL` to the gateway's public **origin** (scheme + host + optional
   port), for example `https://gateway.example.com`. Production must be HTTPS.
2. Compute the exact callback URL. The gateway always uses the origin root, regardless of
   any path in `MCPGW_PUBLIC_URL`:

   ```sh
   MCPGW_PUBLIC_URL=https://gateway.example.com \
     bun -e 'console.log(new URL(process.env.MCPGW_PUBLIC_URL).origin + "/oauth/callback")'
   ```

   Result: `https://gateway.example.com/oauth/callback`.

3. Make sure the reverse proxy routes that exact origin-root path to the gateway. Do not
   rewrite it to a subpath. See [Path-prefix limitation](#path-prefix-limitation).
4. Sign in to the dashboard as an `admin`. Viewers can see the OAuth panel but cannot
   Connect, Reconnect, or Disconnect.

## 1. Create the OAuth upstream

In **Admin → Upstreams → New upstream**:

- **Transport:** HTTP.
- **URL:** the site-specific MCP endpoint, including any toolsets query. For EU1, a
  read-oriented starting point is:

  ```text
  https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp?toolsets=core
  ```

  Use `?toolsets=all` to expose every generally available toolset, or a comma-separated
  subset such as `?toolsets=core,apm,llmobs`. Datadog's default when the parameter is
  omitted is `core`. Large toolsets consume a lot of client context; start narrow.

- **Auth mode:** OAuth.
- **OAuth scopes:** `mcp_all` (the default). Datadog advertises this as its only OAuth
  scope. See [`mcp_all`](#mcp_all-and-write-access).
- **Static auth fields:** leave empty. OAuth and a static header cannot be combined; the
  gateway rejects that configuration.

The `unstable` segment is part of Datadog's preview API path. Keep the URL exactly as
Datadog publishes it for your site.

After saving, open the upstream detail page. The OAuth panel shows the exact redirect URI,
the scope, the status, and a **Connect** button. Until consent completes, the upstream is
reported as **Authorization required** (unconfigured), not down, and the gateway does not
contact Datadog in the background.

## 2. Allowlist the redirect URI in Datadog

This is the step most failed connections miss.

1. In Datadog, open **Organization Settings → Preferences**
   (`https://app.datadoghq.eu/organization-settings/preferences` for EU1).
2. Scroll to **MCP OAuth Redirect URLs**.
3. Add the exact callback from the gateway panel, for example
   `https://gateway.example.com/oauth/callback`.
4. Save the entry with its inline save control. An entry that looks listed but was not
   saved is not applied.
5. Use the exact scheme, host, port, and path. Do not add a wildcard, a query string, or a
   trailing slash, and do not allowlist the OAuth issuer or the MCP endpoint instead of
   the callback.

Changing `MCPGW_PUBLIC_URL` later changes the callback. Update this allowlist before
clicking Connect again.

## 3. Connect and choose consent

1. On the upstream detail page, click **Connect**. The gateway performs discovery and
   dynamic client registration, then redirects the browser to Datadog.
2. Sign in to the intended Datadog organization and **site**. The consent screen shows
   both; a mismatch here is the most common region failure.
3. Choose the access profile deliberately:

   | Profile            | Grant                                                                   | Use when                                              |
   | ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
   | **Limited access** | Read-only, excluding sensitive permissions. No `mcp_write` grant.       | Default for observability queries.                    |
   | **Full access**    | Read and write, including sensitive permissions, including `mcp_write`. | The upstream must create or modify Datadog resources. |

   Do not assume Limited is preselected: the consent screen may default to Full. Check the
   selected profile (and its read/write counts) before clicking **Authorize**.

4. Datadog redirects to `/oauth/callback`. The gateway validates the single-use `state`,
   exchanges the code, seals the tokens in its vault, and marks the upstream **Connected**
   with an expiry.

### `mcp_all` and write access

`mcp_all` is the OAuth scope the gateway requests; Datadog's protected-resource and
authorization-server metadata advertise it as the supported scope. It is a grant bundle,
not a promise of write access.

`mcp_write` is a **Datadog role permission**, not an OAuth scope. Write tools require all
of the following, and missing any one leaves them unavailable:

1. **Full access** on the OAuth consent screen (so the token carries the write grant).
2. **MCP Write Access** enabled for the organization in **Organization Settings →
   Preferences**.
3. `mcp_write` on the consenting user's Datadog role, plus the resource-level permissions
   for whatever is being changed.

If you only need reads, choose Limited and leave the organization's MCP Write Access off.
An org-level write toggle cannot be bypassed by selecting Full at consent.

## 4. Verify

- The OAuth panel shows **Connected** and an expiry. The client ID is shown for reference;
  no token is ever displayed.
- `/healthz` counts the upstream as healthy after it connects.
- Through `/mcp`, the tool catalog contains the `datadog__*` tools for the selected
  toolsets.
- Call one read-only tool, for example `datadog__search_datadog_logs` with a small time
  range and a low `max_tokens`, and confirm the result is not an error.

The gateway refreshes access tokens with a single-flight, per-upstream lock. A refresh
failure does not turn the upstream into a crash loop; it becomes **Authorization required**
until an admin reconnects.

## 5. Revocation and Disconnect

There are two independent controls, and they do different things:

| Action                               | Where                                           | Effect                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revoke the Datadog grant             | Datadog **Personal Settings → Authorized Apps** | Revokes the consent at Datadog. Affects every gateway caller. The gateway notices when its access token can no longer be used and refresh fails with `invalid_grant`. |
| Disconnect locally                   | Gateway upstream detail page → **Disconnect**   | Deletes the gateway's sealed access token, refresh token, pending state, and client registration. It does **not** revoke the grant in Datadog.                        |
| Change org MCP access / write access | Datadog **Organization Settings → Preferences** | Applies organization-wide, independent of any single grant.                                                                                                           |
| Change role permissions              | Datadog **Organization Settings → Roles**       | Applies to that user and therefore to this shared upstream.                                                                                                           |

In **Authorized Apps**, the gateway's client appears as `mcp-gateway (<gateway host>)`.
Revoking there is the right action when a person leaves or a consent should be withdrawn.
To remove the gateway's local credentials now and force re-authorization, also click
**Disconnect** on the upstream. To recover after either action, click **Connect** and
consent again.

## 6. Troubleshooting

| Symptom / error                           | Where it appears                          | Meaning and fix                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Mismatching redirect URI`                | Datadog authorize page, before consent    | The callback is not allowlisted exactly, or the entry was not saved. Add the full `${MCPGW_PUBLIC_URL.origin}/oauth/callback` under **MCP OAuth Redirect URLs**, save it, confirm the gateway's public origin did not change, and retry. It is not fixed by editing scopes or roles.                                                                                                                                     |
| `invalid_scope`                           | Gateway error redirect / Datadog response | Datadog does not recognize the requested scope. Use `mcp_all`; do not put `mcp_write` in the scope field (it is a role permission). Clear custom scopes, recreate the upstream if needed, and reconnect.                                                                                                                                                                                                                 |
| `invalid_target`                          | Datadog token/authorization response      | Datadog rejected the RFC 8707 `resource` value. First confirm the upstream URL is the exact MCP endpoint for the organization's site, not an OAuth issuer or app URL. If it persists with the correct endpoint, this is a gateway/Datadog compatibility issue: the gateway derives `resource` from protected-resource metadata, and omitting it for that upstream is a provider change, not a Datadog allowlist setting. |
| `authorization_required`                  | Gateway status / health                   | The upstream has no usable token, or a refresh failed. Click **Connect**. Check that the grant still exists in **Authorized Apps**, that **MCP Access** is enabled, and that the upstream is not still waiting for the allowlist. This state is intentional, not a transient `down`.                                                                                                                                     |
| `invalid_grant`                           | Gateway error redirect / refresh failure  | The authorization code expired or was already used, or the refresh token was revoked or expired. Reconnect. A code is single-use; replaying the callback URL will not work. If it happens immediately after a successful consent, check **Authorized Apps** for a revocation.                                                                                                                                            |
| Region mismatch (wrong `SITE`, wrong org) | Datadog sign-in / consent screen          | The MCP host and the consent site must match the organization. EU1 organizations use `https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp`; US or AP organizations use their own `mcp.<site>` host. Select the correct site on the sign-in screen, then use that site's endpoint.                                                                                                                                       |
| `Invalid or expired OAuth callback` (400) | Gateway callback                          | The `state` is unknown, expired, or already consumed, or the callback was replayed. Start again from **Connect**. Pending states are short-lived and single-use by design.                                                                                                                                                                                                                                               |
| `access_denied`                           | Gateway error redirect                    | The consent was cancelled or denied. Click **Connect** and authorize; if an admin revoked MCP access, restore **MCP Access** first.                                                                                                                                                                                                                                                                                      |

For any failure, the upstream detail page shows a short redacted error and records an
audit event. Authorization codes, state values, verifiers, and tokens are never written to
the URL, logs, audit trail, or the upstream's `last_error`.

## Path-prefix limitation

The callback is always `${MCPGW_PUBLIC_URL.origin}/oauth/callback`, at the **origin root**.
A path in `MCPGW_PUBLIC_URL` is ignored when the gateway builds the redirect URI.

If the dashboard is served under a subpath, for example `https://example.com/gateway`, the
reverse proxy must still route `https://example.com/oauth/callback` directly to the
gateway, and the Datadog allowlist entry must be that origin-root URL. Do not redirect the
callback to `/gateway/oauth/callback`; Datadog compares the redirect URI exactly, and the
gateway's pending state expects the URI it registered. `MCPGW_PUBLIC_URL` should be the
public origin, not a subpath.

## No hardcoded Datadog endpoints

The gateway ships no Datadog endpoint, client ID, or tenant-specific value. It uses the URL
stored on the upstream row, discovers protected-resource and authorization-server metadata
from that URL, and registers itself dynamically. The EU1 URL in this runbook is an example
to paste, not a built-in default. Discovery is cached on the OAuth row for that upstream:
after changing the URL, click **Disconnect** first so the next **Connect** performs fresh
discovery (or recreate the upstream). Changing sites also requires updating the Datadog
allowlist entry if the public origin changed.

The same OAuth path works for any MCP server that supports protected-resource metadata,
authorization-server metadata, public dynamic client registration, and PKCE S256. Datadog
is the worked example, not a special case in the code.

## See also

- Datadog MCP Server setup: `https://docs.datadoghq.com/mcp_server/setup/`
- Datadog MCP tools and toolsets: `https://docs.datadoghq.com/mcp_server/tools/`
- Datadog organization preferences: `https://app.datadoghq.eu/organization-settings/preferences`
