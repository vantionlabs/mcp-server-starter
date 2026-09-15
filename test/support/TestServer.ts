import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Duration, Effect, Layer, Option, Ref } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { RateLimiter } from "effect/unstable/persistence";
import { SqlClient } from "effect/unstable/sql";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { type AuditEntry, AuditLog } from "../../src/audit/AuditLog.ts";
import { ApiKeys } from "../../src/auth/ApiKeys.ts";
import { OidcVerifier } from "../../src/auth/OidcVerifier.ts";
import type { Principal } from "../../src/auth/Principal.ts";
import { CrmClient } from "../../src/crm/CrmClient.ts";
import { Routes } from "../../src/server/App.ts";
import { ServerConfig, type ServerSettings } from "../../src/server/ServerConfig.ts";
import { ToolGuard } from "../../src/tools/ToolGuard.ts";

export const ISSUER = "https://id.example.com/";
export const PUBLIC_URL = "http://mcp.test";
export const RESOURCE = `${PUBLIC_URL}/mcp`;

const { privateKey, publicKey } = await generateKeyPair("RS256");
export const jwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }],
});

/** An access token as the identity provider would issue it. Override any claim. */
/** Claims to set, or `undefined` to leave a default claim out of the token. */
type Claims = { readonly [K in keyof JWTPayload]?: JWTPayload[K] | undefined; } & {
  readonly [claim: string]: unknown;
  readonly expiresIn?: string;
};

export const signToken = (claims: Claims): Promise<string> => {
  const { expiresIn = "5m", ...rest } = claims;
  // Defaults go in the payload rather than through `setAudience` and friends,
  // which would overwrite a claim a test passes on purpose.
  return new SignJWT({
    iss: ISSUER,
    aud: RESOURCE,
    sub: "user_ada",
    scope: "crm:read",
    email: "ada@example.com",
    ...rest,
  } as JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
};

export const testSettings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
  port: 0,
  publicUrl: PUBLIC_URL,
  resourceUrl: RESOURCE,
  allowedOrigins: [],
  oidc: Option.some({ issuer: ISSUER, audience: RESOURCE, jwksUrl: Option.none() }),
  rateLimit: { limit: 100, window: Duration.minutes(1) },
  toolTimeout: Duration.seconds(5),
  ...overrides,
});

/** A database that is never queried; the health route is the only user. */
const NoDatabase = Layer.succeed(SqlClient.SqlClient)(undefined as never);

/**
 * The real routes, auth, guard and toolkit, over in-memory boundaries: signing
 * keys instead of an identity provider, maps instead of Postgres, the demo CRM.
 */
export const makeTestServer = async (options: {
  readonly settings?: Partial<ServerSettings>;
  readonly apiKeys?: ReadonlyMap<string, Principal>;
  readonly crm?: Layer.Layer<CrmClient>;
} = {}) => {
  const audit = Ref.makeUnsafe<ReadonlyArray<AuditEntry>>([]);
  const settings = testSettings(options.settings);

  const services = Layer.mergeAll(
    ApiKeys.memory(options.apiKeys ?? new Map()),
    Layer.succeed(OidcVerifier)(
      OidcVerifier.make({ issuer: ISSUER, audience: RESOURCE, keys: jwks }),
    ),
    ToolGuard.layer,
    options.crm ?? CrmClient.layerDemo,
    NoDatabase,
  ).pipe(
    Layer.provide(AuditLog.memory(audit)),
    Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
    Layer.provideMerge(Layer.succeed(ServerConfig)(settings)),
  );

  const { handler, dispose } = HttpRouter.toWebHandler(Routes.pipe(Layer.provide(services)), {
    disableLogger: true,
  });

  const fetch = (input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init));

  /** An MCP client, connected with `token` as its bearer credential. */
  const connect = async (token: string) => {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch,
    });
    // The SDK's own types disagree with `exactOptionalPropertyTypes`.
    await client.connect(transport as unknown as Transport);
    return client;
  };

  const auditEntries = () => Effect.runSync(Ref.get(audit));

  return { fetch, connect, auditEntries, dispose };
};
