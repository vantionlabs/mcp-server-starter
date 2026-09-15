import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { ServerConfig, type ServerSettings } from "../server/ServerConfig.ts";

const METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * Where a client finds this server's OAuth metadata. RFC 9728 puts it at the
 * well-known path followed by the resource's own path.
 */
export const protectedResourceMetadataUrl = (config: ServerSettings): string =>
  `${config.publicUrl}${METADATA_PATH}/mcp`;

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * This is how an MCP client that has never seen this server learns where to send
 * the user to sign in: the 401 points here, and this names the identity provider.
 * The client then runs the OAuth flow with that provider directly and comes back
 * with a token whose audience is `resource`.
 *
 * Served at both the path-specific location and the bare well-known path, because
 * clients differ in which one they try first. Not served when OIDC is off, since
 * there is no provider to point at.
 */
export const protectedResourceRoutes = (
  scopes: ReadonlyArray<string>,
): Layer.Layer<never, never, HttpRouter.HttpRouter | ServerConfig> =>
  Layer.unwrap(
    Effect.gen(function*() {
      const config = yield* ServerConfig;
      if (Option.isNone(config.oidc)) return Layer.empty;

      const metadata = HttpServerResponse.jsonUnsafe(
        {
          resource: config.resourceUrl,
          authorization_servers: [config.oidc.value.issuer],
          scopes_supported: scopes,
          bearer_methods_supported: ["header"],
          resource_name: "MCP server",
        },
        { headers: { "cache-control": "public, max-age=3600" } },
      );

      return Layer.mergeAll(
        HttpRouter.add("GET", `${METADATA_PATH}/mcp`, Effect.succeed(metadata)),
        HttpRouter.add("GET", METADATA_PATH, Effect.succeed(metadata)),
      );
    }),
  );
