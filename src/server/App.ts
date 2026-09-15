import { NodeCrypto, NodeRedis } from "@effect/platform-node";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { RateLimiter } from "effect/unstable/persistence";
import type { SqlClient } from "effect/unstable/sql";
import { AuditLog } from "../audit/AuditLog.ts";
import { ApiKeys } from "../auth/ApiKeys.ts";
import { AuthMiddleware } from "../auth/AuthMiddleware.ts";
import { OidcVerifier } from "../auth/OidcVerifier.ts";
import { protectedResourceRoutes } from "../auth/ProtectedResource.ts";
import { CrmClient } from "../crm/CrmClient.ts";
import { CrmScopes, CrmToolkit, CrmToolkitLive } from "../crm/CrmToolkit.ts";
import { DatabaseLive } from "../database/Database.ts";
import { ToolGuard } from "../tools/ToolGuard.ts";
import { HealthRoutes } from "./Health.ts";
import { ServerConfig } from "./ServerConfig.ts";

/**
 * The MCP revisions this server speaks, newest first. A client that offers one of
 * these gets it; anything else is answered with the first.
 */
export const MCP_PROTOCOLS = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
] as const;

/** Every scope any tool checks. Add each new toolkit's scopes here. */
export const ALL_SCOPES: ReadonlyArray<string> = Object.values(CrmScopes);

/**
 * The MCP endpoint at `/mcp`, behind the auth middleware.
 *
 * To expose another system, write a toolkit for it and add it here next to
 * `CrmToolkit`, with its handler layer provided the same way.
 */
const McpRoutes = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* ServerConfig;
    return McpServer.toolkit(CrmToolkit).pipe(
      Layer.provideMerge(
        McpServer.layerHttp({
          name: "mcp-server-starter",
          version: "0.1.0",
          path: "/mcp",
          protocols: MCP_PROTOCOLS,
          allowedOrigins: config.allowedOrigins,
        }),
      ),
      Layer.provide(CrmToolkitLive),
      Layer.provide(AuthMiddleware.layer),
    );
  }),
);

/** Every route the server serves, still needing the services below. */
export const Routes = Layer.mergeAll(
  McpRoutes,
  protectedResourceRoutes(ALL_SCOPES),
  HealthRoutes,
);

/**
 * Rate limit counters in Redis when `REDIS_URL` is set, so every replica shares
 * one budget per caller. Without it they live in this process, which is fine for
 * one instance and for local development.
 */
export const RateLimiterLive: Layer.Layer<RateLimiter.RateLimiter> = Layer.unwrap(
  Effect.gen(function*() {
    const redisUrl = yield* Config.option(Config.Redacted("REDIS_URL"));
    const store = Option.match(redisUrl, {
      onNone: () => RateLimiter.layerStoreMemory,
      onSome: (url) =>
        RateLimiter.layerStoreRedis({ prefix: "mcp:ratelimit:" }).pipe(
          Layer.provide(NodeRedis.layer({ url: Redacted.value(url) })),
        ),
    });
    return RateLimiter.layer.pipe(Layer.provide(store));
  }),
).pipe(Layer.orDie);

/** The production services: Postgres, Redis, the identity provider and the CRM. */
export const ServicesLive: Layer.Layer<
  ServerConfig | ApiKeys | OidcVerifier | ToolGuard | CrmClient | SqlClient.SqlClient
> = Layer.mergeAll(ApiKeys.layer, OidcVerifier.layer, ToolGuard.layer, CrmClient.layer).pipe(
  Layer.provide(AuditLog.layer),
  Layer.provide(RateLimiterLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(ServerConfig.layer),
  Layer.orDie,
);
