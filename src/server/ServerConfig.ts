import { Config, Context, Duration, Effect, Layer, Option } from "effect";

export interface OidcSettings {
  /** The issuer every token must carry in `iss`, exactly as the provider publishes it. */
  readonly issuer: string;
  /** The audience every token must carry in `aud`. Defaults to the MCP resource URL. */
  readonly audience: string;
  /** Set to skip discovery, for providers whose discovery document is not public. */
  readonly jwksUrl: Option.Option<string>;
}

export interface ServerSettings {
  readonly port: number;
  /** Where clients reach this server, without a trailing slash. */
  readonly publicUrl: string;
  /** The MCP endpoint's full URL. OAuth calls this the protected resource. */
  readonly resourceUrl: string;
  /** Browser origins allowed to call the MCP endpoint. Clients without an `Origin` are always allowed. */
  readonly allowedOrigins: ReadonlyArray<string>;
  /** `None` means API keys only. */
  readonly oidc: Option.Option<OidcSettings>;
  /** Calls one principal may make to one tool per window. */
  readonly rateLimit: { readonly limit: number; readonly window: Duration.Duration; };
  /** How long a tool may run before the call is abandoned and reported as timed out. */
  readonly toolTimeout: Duration.Duration;
}

/**
 * Every setting the server reads, resolved once at startup.
 *
 * Reading the environment in one place means a missing or malformed value stops
 * the process before it listens, rather than on the first request that needs it.
 */
export class ServerConfig extends Context.Service<ServerConfig, ServerSettings>()("ServerConfig") {
  static readonly layer: Layer.Layer<ServerConfig, Config.ConfigError> = Layer.effect(ServerConfig)(
    Effect.gen(function*() {
      const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));
      const publicUrl = yield* Config.NonEmptyString("PUBLIC_URL").pipe(
        Config.withDefault(`http://localhost:${port}`),
        Config.map((url) => url.replace(/\/+$/, "")),
      );
      const resourceUrl = `${publicUrl}/mcp`;

      const allowedOrigins = yield* Config.String("ALLOWED_ORIGINS").pipe(
        Config.withDefault(""),
        Config.map((value) =>
          value.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0)
        ),
      );

      const issuer = yield* Config.option(Config.NonEmptyString("OIDC_ISSUER"));
      const audience = yield* Config.NonEmptyString("OIDC_AUDIENCE").pipe(
        Config.withDefault(resourceUrl),
      );
      const jwksUrl = yield* Config.option(Config.NonEmptyString("OIDC_JWKS_URL"));

      const limit = yield* Config.Int("RATE_LIMIT_PER_WINDOW").pipe(Config.withDefault(60));
      const window = yield* Config.Duration("RATE_LIMIT_WINDOW").pipe(
        Config.withDefault(Duration.minutes(1)),
      );
      const toolTimeout = yield* Config.Duration("TOOL_TIMEOUT").pipe(
        Config.withDefault(Duration.seconds(10)),
      );

      return {
        port,
        publicUrl,
        resourceUrl,
        allowedOrigins,
        oidc: Option.map(issuer, (issuer) => ({ issuer, audience, jwksUrl })),
        rateLimit: { limit, window },
        toolTimeout,
      };
    }),
  );
}
