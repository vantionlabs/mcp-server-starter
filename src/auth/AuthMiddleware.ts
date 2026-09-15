import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerConfig } from "../server/ServerConfig.ts";
import { ApiKeys, looksLikeApiKey } from "./ApiKeys.ts";
import { OidcVerifier } from "./OidcVerifier.ts";
import { CurrentPrincipal } from "./Principal.ts";
import { protectedResourceMetadataUrl } from "./ProtectedResource.ts";

const bearerToken = (request: HttpServerRequest.HttpServerRequest): Option.Option<string> => {
  const header = request.headers["authorization"];
  if (header === undefined) return Option.none();
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return Option.fromNullishOr(match?.[1]);
};

/**
 * Authenticates every request to the MCP endpoint.
 *
 * A token starting with `mcp_` is an API key and is looked up; anything else is
 * treated as an access token from the identity provider and verified. Either way
 * the result is a `Principal`, set for the rest of the request.
 *
 * A request without a usable credential gets a 401 whose `WWW-Authenticate`
 * header points at the protected resource metadata. That pointer is how an MCP
 * client discovers which identity provider to send the user to, so it has to be
 * on every 401, not only the first.
 */
export const AuthMiddleware = HttpRouter.middleware()(
  Effect.gen(function*() {
    const config = yield* ServerConfig;
    const apiKeys = yield* ApiKeys;
    const oidc = yield* OidcVerifier;

    const challenge = (error: Option.Option<"invalid_token">) => {
      const parts = [
        ...(Option.isSome(config.oidc)
          ? [`resource_metadata="${protectedResourceMetadataUrl(config)}"`]
          : ["realm=\"mcp\""]),
        ...Option.match(error, { onNone: () => [], onSome: (code) => [`error="${code}"`] }),
      ];
      return HttpServerResponse.jsonUnsafe(
        {
          error: Option.getOrElse(error, () => "unauthorized"),
          message: Option.isSome(error)
            ? "The credential was not accepted."
            : "Sign in, or send an API key as a bearer token.",
        },
        {
          status: 401,
          headers: {
            "www-authenticate": `Bearer ${parts.join(", ")}`,
            "cache-control": "no-store",
          },
        },
      );
    };

    return (httpEffect) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = bearerToken(request);
        if (Option.isNone(token)) return challenge(Option.none());

        const principal = looksLikeApiKey(token.value)
          ? apiKeys.authenticate(token.value)
          : oidc.verify(token.value);

        return yield* principal.pipe(
          Effect.flatMap((principal) =>
            Effect.provideService(httpEffect, CurrentPrincipal, Option.some(principal))
          ),
          Effect.catchTags({
            CredentialRejected: () => Effect.succeed(challenge(Option.some("invalid_token"))),
            IdentityProviderUnavailable: () =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  {
                    error: "temporarily_unavailable",
                    message: "The identity provider could not be reached. Retry shortly.",
                  },
                  { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } },
                ),
              ),
          }),
        );
      });
  }),
);
