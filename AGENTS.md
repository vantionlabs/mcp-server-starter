# Conventions for AI coding agents (and humans)

An MCP server on Effect 4. These rules keep every tool authenticated, scoped,
limited and audited, however many tools get added.

## Effect 4 is a release candidate

- `effect` and every `@effect/*` package are pinned to the same exact rc in
  `package.json`. Bump them together.
- Before using an Effect API you have not already used in this repo, read its
  source in `node_modules/effect/src/` (or `node_modules/@effect/*/src/`). APIs
  moved during the release candidates, so recall from Effect 3 or an older rc is
  often wrong: `Config.Port`, not `Config.port`; `Context.Service`, not
  `Context.Tag`; `Schema.TaggedError`; no `.asEffect()`.
- The MCP server comes from `effect/unstable/ai` (`McpServer`, `Tool`, `Toolkit`).

## Tools

- Every tool handler runs inside `ToolGuard.run`. It is the only place scopes,
  rate limits, time limits and audit entries happen. Never call a system from a
  handler outside it.
- Every tool's `failure` schema includes `...GuardFailures` and each error the
  tool can return. Undeclared failures reach the client as an internal error.
- Annotate `Readonly`, `Destructive`, `Idempotent` and `OpenWorld` on every tool.
  MCP clients assume destructive when unset.
- Tool descriptions are written for a model: when to use the tool, what it
  returns, which tool to call first when an id is needed.
- Tools do not accept secrets as arguments. Arguments are stored in the audit log.
- New scopes go in the toolkit's `…Scopes` object and in `ALL_SCOPES`.

## Auth

- Tools and clients read the caller from `CurrentPrincipal`. Nothing below the
  middleware reads headers or tokens.
- A user and an API key must produce the same `Principal` shape, so no tool has a
  second code path for either.
- Refuse by default: a missing principal, an unknown scope or an unverifiable
  token is a refusal, never a pass.

## Effect style

- Services are `Context.Service` classes with a static `layer`. Yield services
  inside effect bodies; do not pass them as arguments.
- Errors are `Schema.TaggedError` classes. Expose a typed error only when a caller
  can act on it; turn the rest into defects with `Effect.catchTag(..., Effect.die)`.
  Never `Effect.orDie`. `Layer.orDie` is fine on a final composition.
- An error's `message` getter is written for whoever reads it: the agent, for
  tool errors.
- Tracing uses `Effect.fn("Name")` or `Effect.withSpan`. Do not add log lines on
  error paths; the spans carry the failure.
- Configuration is read in `src/server/ServerConfig.ts` (or in the layer that
  owns it, for optional integrations), never with `process.env`.

## Database

- Schema changes are new files in `src/database/migrations/`, registered in
  `src/database/Database.ts`. Never edit a migration that has shipped.
- Columns are snake_case; the client maps them to camelCase.
- The Postgres driver returns timestamps as epoch milliseconds, and cannot infer a
  type for an empty array (use `PgTypes.array`).

## Tests

- `test/Mcp.test.ts` drives the real routes through a real MCP client with
  in-memory boundaries (`test/support/TestServer.ts`). Add a case there for every
  tool: success, refusal without its scope, and each error the agent should see.
- Swap boundaries (identity provider, Postgres, the downstream system) with
  layers. Do not mock Effect or the MCP server.
- Postgres tests run when `DATABASE_URL` is set, and CI sets it.

## Before finishing

```bash
pnpm check && pnpm lint && pnpm format:check && pnpm test
```
