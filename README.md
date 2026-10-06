<p align="center">
  <a href="https://vantion.co">
    <img src="https://raw.githubusercontent.com/vantionlabs/.github/main/profile/banner.png" alt="Vantion Labs" width="100%" />
  </a>
</p>

<h1 align="center">MCP server starter</h1>

<p align="center">
  <b>Typed, scoped and audited access to your systems, for AI agents.</b><br />
  OAuth or API keys, a scope per tool, an audit row per call, and limits that hold across replicas.
</p>

<p align="center">
  <a href="https://github.com/vantionlabs/mcp-server-starter/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/vantionlabs/mcp-server-starter/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-2233f0?style=flat-square" /></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" /></a>
  <a href="https://effect.website"><img alt="Effect 4" src="https://img.shields.io/badge/Effect_4-2233f0?style=flat-square" /></a>
  <a href="https://nodejs.org"><img alt="Node 24" src="https://img.shields.io/badge/Node_24-339933?style=flat-square&logo=nodedotjs&logoColor=white" /></a>
  <a href="https://www.postgresql.org"><img alt="Postgres" src="https://img.shields.io/badge/Postgres-4169E1?style=flat-square&logo=postgresql&logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/licence-MIT-f4f4f6?style=flat-square" /></a>
  <a href="https://vantion.co"><img alt="Vantion Labs" src="https://img.shields.io/badge/by-Vantion_Labs-2233f0?style=flat-square" /></a>
</p>

---

A [Model Context Protocol](https://modelcontextprotocol.io) server for giving AI
agents access to internal systems, from [Vantion Labs](https://vantion.co).
Built on [Effect 4](https://effect.website) and its MCP support in
`effect/unstable/ai`.

It is the part of an agent integration that has to be right before anything else:
who is calling, what they may do, what they did, and how often.

## What you get

- **Sign-in through your identity provider.** The server is an OAuth protected
  resource. An MCP client that meets a 401 reads the metadata it points to, sends
  the user to Keycloak, Auth0, Entra ID, Okta or any OIDC provider, and comes back
  with a token. Tokens are verified locally against the provider's keys.
- **API keys** for jobs and services that cannot do an OAuth flow. Stored as
  hashes, scoped, revocable, and managed with `pnpm api-keys`.
- **Scopes per tool.** Every tool names the scope it needs, and a caller without
  it is refused before the tool runs.
- **Typed tools.** Parameters, results and failures are Effect schemas. Clients
  get a JSON schema, bad input is rejected before your code sees it, and a tool's
  declared errors reach the agent as messages it can act on.
- **An audit log.** Every call, allowed or refused, is written to Postgres with the
  caller, client, tool, arguments, outcome and duration.
- **Rate limits** per caller and tool, in Redis so replicas share one budget.
- **Time limits** on every tool, so a hung downstream system cannot hold a call
  open.
- **Tracing.** Every call, auth check, query and outbound request is a span, sent
  over OTLP when you configure an endpoint.
- **Tests** for auth, scopes, limits and the audit trail, run through a real MCP
  client.

## Quickstart

You need Node 24, pnpm and Docker.

```bash
pnpm install
docker compose up -d          # Postgres and Redis
cp .env.example .env
pnpm dev                      # http://localhost:3000/mcp
```

Create an API key and connect Claude Code to the server:

```bash
pnpm api-keys create --name "my laptop" --subject user:me --scopes crm:read,crm:write

claude mcp add --transport http crm http://localhost:3000/mcp \
  --header "Authorization: Bearer mcp_..."
```

Then ask Claude to "look up customer cus_1001", or "add a note to Globex saying the
renewal call went well". The server ships with a small in-memory CRM so the tools
work before you connect anything real. Every call lands in the `audit_log` table.

To sign users in through your identity provider instead, set `OIDC_ISSUER`. See
[docs/authentication.md](docs/authentication.md).

## How a call flows

```
MCP client ──POST /mcp──> AuthMiddleware ──> McpServer ──> Toolkit handler ──> ToolGuard ──> CrmClient
               │               │                                                   │
               │               ├─ mcp_… key  → ApiKeys (Postgres)                  ├─ scope check
               │               └─ JWT        → OidcVerifier (provider JWKS)        ├─ rate limit (Redis)
               │                                                                   ├─ time limit
               └─ 401 + WWW-Authenticate → /.well-known/oauth-protected-resource   └─ audit_log (Postgres)
```

1. **Authenticate.** The middleware turns the bearer token into a `Principal`, or
   answers 401 with a pointer to the OAuth metadata.
2. **Authorise.** `ToolGuard` checks the scope the tool declared.
3. **Execute.** The tool calls the internal system through a client that forwards
   who the caller is, under a rate limit and a time limit.
4. **Record.** The audit entry is written, whatever the outcome, and the typed
   result goes back to the agent.

## Project layout

```
src/
  Main.ts                  HTTP entry point
  server/                  configuration, app composition, health, telemetry
  auth/                    principal, OIDC verification, API keys, middleware, OAuth metadata
  tools/ToolGuard.ts       scope, rate limit, time limit and audit around every call
  audit/AuditLog.ts        the audit trail
  crm/                     the example system: a client and its toolkit
  database/                Postgres client and migrations
  bin/ApiKeys.ts           create, list and revoke API keys
test/                      MCP client tests, verifier tests, Postgres tests
```

## Adding your own tools

Copy `src/crm/` for each system you expose: a client for the system, and a
toolkit whose handlers go through `ToolGuard`. Then register the toolkit in
`src/server/App.ts`. [docs/adding-tools.md](docs/adding-tools.md) walks through
it.

## Checks

```bash
pnpm check          # TypeScript, with the Effect language service
pnpm lint           # oxlint, with Effect rules
pnpm format:check   # dprint
pnpm test           # the Postgres tests run when DATABASE_URL is set
```

## Deploying

The server is one container. It needs Postgres, and Redis once you run more than
one instance. See [docs/deploying.md](docs/deploying.md).

## Licence

MIT. See [LICENSE](LICENSE). Built by [Vantion Labs](https://vantion.co).
