# Authentication

Every request to `/mcp` carries a bearer token. The server accepts two kinds:

| Token | For | Checked by |
| --- | --- | --- |
| An access token (JWT) from your identity provider | People, through an MCP client such as Claude, Cursor or an internal agent | `src/auth/OidcVerifier.ts`, against the provider's published keys |
| An API key starting with `mcp_` | Jobs, services, scripts | `src/auth/ApiKeys.ts`, against a hash in Postgres |

Both become the same `Principal`: a subject, a display name, the credential id
and a list of scopes. Tools, the rate limiter and the audit log only ever see
that.

## Signing in through an identity provider

Set `OIDC_ISSUER` to your provider's issuer URL, exactly as it appears in the `iss`
claim of its tokens. At startup the server reads
`<issuer>/.well-known/openid-configuration` to find the provider's signing keys.
If that fails, it refuses to start and says why.

### How a client finds the provider

This is the OAuth 2.0 Protected Resource Metadata flow (RFC 9728) that the MCP
authorization spec builds on:

1. The client calls `/mcp` without a token.
2. The server answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://your-server/.well-known/oauth-protected-resource/mcp"`.
3. The client fetches that document. It names the resource
   (`https://your-server/mcp`), the provider in `authorization_servers`, and the
   scopes the tools use.
4. The client runs the OAuth authorization code flow with the provider, asking
   for a token for that resource, and retries with it.

The server never sees a password, runs no login page, and stores no sessions for
users.

### What a token must contain

- `iss` equal to `OIDC_ISSUER`.
- `aud` containing `OIDC_AUDIENCE`, which defaults to `PUBLIC_URL/mcp`. A token
  issued for another API is refused, so a token leaked from one service cannot be
  replayed against this one.
- `sub`, the user's stable id.
- Scopes, as a space-separated `scope` claim or a `scp` claim (string or array).
- A valid signature from one of the provider's current keys, and an `exp` in the
  future.

`email` or `preferred_username` is used as the display name when present.

### Registering the MCP client with your provider

The MCP client needs an OAuth client at your provider. Providers differ here:
some support dynamic client registration, which lets an MCP client register
itself; others need you to create a client for it and give it the client id.
Check what your MCP client supports, and what your provider allows, before
choosing.

### Provider notes

These are starting points. Check them against your provider's current
documentation.

- **Keycloak.** Issuer is `https://<host>/realms/<realm>`. Create client scopes
  named `crm:read` and `crm:write`, and add an audience mapper so tokens carry
  `PUBLIC_URL/mcp` in `aud`.
- **Auth0.** Create an API whose identifier is `PUBLIC_URL/mcp`, with the scopes
  as permissions. Issuer is `https://<tenant>.auth0.com/` including the trailing
  slash.
- **Microsoft Entra ID.** Issuer is `https://login.microsoftonline.com/<tenant-id>/v2.0`.
  Expose an API with the scopes. Tokens carry the app's id URI as `aud`, so set
  `OIDC_AUDIENCE` to it. Scopes arrive in `scp`, which the server reads.
- **Okta, Authentik, Zitadel, WorkOS.** Any provider that issues JWT access tokens
  and publishes a discovery document works. Opaque (non-JWT) access tokens do
  not: they need an introspection call, which this server does not make.

If your provider's discovery document is not reachable from the server but its
JWKS is, set `OIDC_JWKS_URL`.

## API keys

```bash
pnpm api-keys create --name "billing sync" --subject svc:billing-sync --scopes crm:read
pnpm api-keys list
pnpm api-keys revoke key_…
```

- The key is printed once. Only its SHA-256 hash is stored, with the last six
  characters kept so a leaked key can be matched to its row.
- `subject` is who the key acts as, and what the audit log records. Use something
  a person can trace back to an owner.
- Revoking takes effect on the next request.
- `last_used_at` shows keys nobody uses any more.

Keys suit machine callers. A person should sign in through the provider, so
their access follows them when they change role or leave.

## Scopes

A scope is a string a tool checks, such as `crm:read`. Each toolkit exports the
scopes it uses, and `ALL_SCOPES` in `src/server/App.ts` advertises them in the
metadata. The same names must exist at your provider for tokens to carry them.

Keep scopes coarse: one read and one write scope per system is usually enough.
Rules like "only their own accounts" belong in the system behind the tool, which
receives the caller's identity with every request.

## Responses

| Situation | Response |
| --- | --- |
| No token | `401`, challenge with `resource_metadata` |
| Expired, forged, revoked or wrong-audience token | `401`, challenge with `error="invalid_token"` |
| Provider's keys unreachable | `503` with `Retry-After` |
| Valid token, missing scope for a tool | The tool call returns an error result naming the scope. The attempt is audited as `denied`. |
