import { Cause, Context, Effect, Layer, Option, Schedule, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ServerConfig } from "../server/ServerConfig.ts";
import { CredentialRejected, IdentityProviderUnavailable, Principal } from "./Principal.ts";

export interface OidcVerifierService {
  readonly verify: (
    token: string,
  ) => Effect.Effect<Principal, CredentialRejected | IdentityProviderUnavailable>;
}

/**
 * Checks access tokens issued by an OpenID Connect provider: Keycloak, Authentik,
 * Auth0, Okta, Entra ID, WorkOS, Zitadel, or anything else that publishes a JWKS.
 *
 * Verification is local. The provider's signing keys are fetched once and cached
 * by `jose`, which refetches when it meets a key id it has not seen, so key
 * rotation needs no restart and a request never waits on the provider.
 */
export class OidcVerifier extends Context.Service<OidcVerifier, OidcVerifierService>()(
  "OidcVerifier",
) {
  /** A verifier for one issuer and audience, checking signatures against `keys`. */
  static make(options: {
    readonly issuer: string;
    readonly audience: string;
    readonly keys: JWTVerifyGetKey;
  }): OidcVerifierService {
    return {
      verify: Effect.fn("OidcVerifier.verify")(function*(token: string) {
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, options.keys, {
              issuer: options.issuer,
              audience: options.audience,
              // A token without a subject cannot be attributed to anyone.
              requiredClaims: ["sub"],
            }),
          catch: rejection,
        });
        return principalFromClaims(payload);
      }),
    };
  }

  /** API keys only: every bearer token that is not a key is refused. */
  static readonly disabled: OidcVerifierService = {
    verify: () => Effect.fail(new CredentialRejected({ reason: "NotConfigured" })),
  };

  static readonly layer: Layer.Layer<OidcVerifier, never, ServerConfig | HttpClient.HttpClient> =
    Layer.effect(OidcVerifier)(
      Effect.gen(function*() {
        const config = yield* ServerConfig;
        if (Option.isNone(config.oidc)) return OidcVerifier.disabled;
        const oidc = config.oidc.value;

        const jwksUrl = Option.isSome(oidc.jwksUrl)
          ? oidc.jwksUrl.value
          : yield* discoverJwksUrl(oidc.issuer);

        return OidcVerifier.make({
          issuer: oidc.issuer,
          audience: oidc.audience,
          keys: createRemoteJWKSet(new URL(jwksUrl)),
        });
      }),
    );
}

/** Startup cannot continue: without the provider's keys, every user would be refused. */
export class OidcDiscoveryFailed extends Schema.TaggedError<OidcDiscoveryFailed>()(
  "OidcDiscoveryFailed",
  { issuer: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not read the OIDC discovery document for ${this.issuer}. Check OIDC_ISSUER, or set OIDC_JWKS_URL.\n${this.detail}`;
  }
}

const DiscoveryDocument = Schema.Struct({ jwks_uri: Schema.String });

/**
 * Reads `jwks_uri` from the provider's discovery document.
 *
 * Done at startup, with a few retries for a provider that is still booting beside
 * this server. A server that cannot find its provider's keys would refuse every
 * user, so failing to start is the clearer outcome.
 */
const discoverJwksUrl = (issuer: string) =>
  HttpClient.get(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DiscoveryDocument)),
    Effect.map((document) => document.jwks_uri),
    Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 4 }),
    Effect.catchCause((cause) =>
      Effect.die(new OidcDiscoveryFailed({ issuer, detail: Cause.pretty(cause) }))
    ),
    Effect.withSpan("OidcVerifier.discover", { attributes: { issuer } }),
  );

const rejection = (error: unknown): CredentialRejected | IdentityProviderUnavailable => {
  if (error instanceof errors.JWTExpired) return new CredentialRejected({ reason: "Expired" });
  if (error instanceof errors.JWKSTimeout) return new IdentityProviderUnavailable({});
  if (error instanceof errors.JOSEError) return new CredentialRejected({ reason: "Invalid" });
  // Anything else is `fetch` failing to reach the JWKS endpoint.
  return new IdentityProviderUnavailable({});
};

/**
 * Scopes arrive as a space-separated `scope` string (Auth0, Okta, Keycloak, the
 * OAuth spec) or as `scp`, a string or an array (Entra ID). Accept both, so the
 * provider can be swapped without touching the tools.
 */
const scopesFrom = (payload: JWTPayload): ReadonlyArray<string> => {
  const raw = payload["scope"] ?? payload["scp"];
  if (typeof raw === "string") return raw.split(" ").filter((scope) => scope.length > 0);
  if (Array.isArray(raw)) return raw.filter((scope): scope is string => typeof scope === "string");
  return [];
};

const stringClaim = (payload: JWTPayload, name: string): string | undefined => {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const principalFromClaims = (payload: JWTPayload): Principal => {
  // `jwtVerify` was told to require `sub`, so it is present.
  const subject = payload.sub ?? "";
  return new Principal({
    subject,
    kind: "user",
    displayName: stringClaim(payload, "email") ?? stringClaim(payload, "preferred_username")
      ?? subject,
    credentialId: payload.jti ?? subject,
    scopes: scopesFrom(payload),
  });
};
