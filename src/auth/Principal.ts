import { Context, Option, Schema } from "effect";

/**
 * Who is behind a request: a person signed in through the identity provider, or
 * an API key issued to a service.
 *
 * Tools never see a token. They see this, so the rules about what a caller may
 * do are written once, against one shape, whichever way the caller signed in.
 */
export class Principal extends Schema.Class<Principal>("Principal")({
  /** Stable id: the token's `sub` for a user, the key's owner for an API key. */
  subject: Schema.String,
  kind: Schema.Literals(["user", "api_key"]),
  /** Something a person reading the audit log recognises: an email, or the key's name. */
  displayName: Schema.String,
  /** The credential that authenticated this request: the token's `jti`, or the key id. */
  credentialId: Schema.String,
  scopes: Schema.Array(Schema.String),
}) {
  hasScope(scope: string): boolean {
    return this.scopes.includes(scope);
  }
}

/**
 * The principal for the request being handled.
 *
 * A reference rather than a service, because the MCP server's tool handlers can
 * only require services that exist when the server starts, and a caller does not
 * exist until a request arrives. The auth middleware sets it per request; the
 * default of `None` is what a handler sees if something reached it without
 * passing through that middleware, and `ToolGuard` refuses that call.
 */
export const CurrentPrincipal = Context.Reference<Option.Option<Principal>>("CurrentPrincipal", {
  defaultValue: () => Option.none(),
});

/** A credential was presented and is not acceptable. */
export class CredentialRejected extends Schema.TaggedError<CredentialRejected>()(
  "CredentialRejected",
  { reason: Schema.Literals(["Expired", "Invalid", "Revoked", "NotConfigured"]) },
) {}

/** The identity provider could not be reached, so a token could not be checked either way. */
export class IdentityProviderUnavailable extends Schema.TaggedError<IdentityProviderUnavailable>()(
  "IdentityProviderUnavailable",
  {},
) {}
