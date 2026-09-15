# Deploying

The server is a single container built from the `Dockerfile`. Node 24 runs the
TypeScript sources directly, so there is no build step to keep in sync.

It needs:

- **Postgres** for API keys and the audit log. Migrations run on startup, under a
  lock, so replicas starting together are safe.
- **Redis** for rate limits, once there is more than one instance. Without
  `REDIS_URL` each instance counts on its own.
- **HTTPS in front of it.** OAuth tokens and API keys are bearer credentials.

## Environment

See `.env.example` for every setting. The ones that matter in production:

| Variable | Notes |
| --- | --- |
| `PUBLIC_URL` | The URL clients use, such as `https://mcp.example.com`. Tokens must be issued for `PUBLIC_URL/mcp`. |
| `DATABASE_URL` | |
| `REDIS_URL` | |
| `OIDC_ISSUER` | Leave empty for API keys only. |
| `ALLOWED_ORIGINS` | Only if a browser app calls the server directly. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Where traces go. |

## Health checks

- `GET /health` returns 200 while the process is up. Use it for liveness.
- `GET /health/ready` also queries Postgres and returns 503 when it cannot. Use it
  for readiness.

## Running more than one instance

MCP over streamable HTTP keeps a session per client, and this server keeps
sessions in memory. A client whose requests land on an instance that did not
create its session gets a 404 and has to start a new session.

So either:

- run one instance, which is plenty for most internal tool servers, or
- route each client to the same instance, with sticky sessions on the
  `Mcp-Session-Id` header or on the client's address.

Rate limits are shared across instances through Redis either way.

## Railway

1. Create a project with Postgres and Redis.
2. Add a service from this repository. Railway builds the `Dockerfile`.
3. Set `DATABASE_URL` and `REDIS_URL` from the database services, `PUBLIC_URL` to
   the service's domain, and `OIDC_ISSUER` if you use sign-in.
4. Set the health check path to `/health/ready`.
5. Create the first API key from a shell with the same `DATABASE_URL`:
   `pnpm api-keys create ...`.

## The audit log

`audit_log` grows by one row per tool call. Decide how long you keep it, and
either delete old rows on a schedule or export them to your log store and
truncate. The table is indexed by subject and by tool, each with time.
