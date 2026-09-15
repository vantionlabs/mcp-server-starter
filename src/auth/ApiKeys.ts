import { PgTypes } from "@effect/sql-pg";
import { Context, Crypto, Effect, Encoding, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CredentialRejected, Principal } from "./Principal.ts";

/** Every key starts with this, so the middleware can tell a key from a JWT without trying both. */
export const API_KEY_PREFIX = "mcp_";

export const looksLikeApiKey = (token: string): boolean => token.startsWith(API_KEY_PREFIX);

export class ApiKeyRecord extends Schema.Class<ApiKeyRecord>("ApiKeyRecord")({
  id: Schema.String,
  name: Schema.String,
  subject: Schema.String,
  scopes: Schema.Array(Schema.String),
  hint: Schema.String,
  // The Postgres driver returns timestamps as epoch milliseconds.
  createdAt: Schema.DateFromMillis,
  lastUsedAt: Schema.NullOr(Schema.DateFromMillis),
  revokedAt: Schema.NullOr(Schema.DateFromMillis),
}) {}

export interface ApiKeysService {
  readonly authenticate: (key: string) => Effect.Effect<Principal, CredentialRejected>;
  /** Returns the key itself exactly once. Only its hash is stored. */
  readonly create: (input: {
    readonly name: string;
    readonly subject: string;
    readonly scopes: ReadonlyArray<string>;
  }) => Effect.Effect<{ readonly id: string; readonly key: string; }>;
  /** `false` when there was no active key with that id. */
  readonly revoke: (id: string) => Effect.Effect<boolean>;
  readonly list: Effect.Effect<ReadonlyArray<ApiKeyRecord>>;
}

/**
 * API keys, for callers that cannot do an OAuth flow: scheduled jobs, internal
 * services, a script run from a laptop.
 *
 * A key carries its own scopes and a subject, and authenticates to the same
 * `Principal` a signed-in user does, so every tool check and audit entry treats
 * both the same way.
 */
export class ApiKeys extends Context.Service<ApiKeys, ApiKeysService>()("ApiKeys") {
  static readonly layer: Layer.Layer<ApiKeys, never, SqlClient.SqlClient | Crypto.Crypto> = Layer
    .effect(ApiKeys)(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient;
        const crypto = yield* Crypto.Crypto;

        // A platform crypto failure is not something any caller can handle.
        const hashKey = (key: string) =>
          crypto.digest("SHA-256", new TextEncoder().encode(key)).pipe(
            Effect.map(Encoding.encodeHex),
            Effect.catchTag("PlatformError", Effect.die),
          );

        const authenticate = Effect.fn("ApiKeys.authenticate")(function*(key: string) {
          const rows = yield* sql<{
            id: string;
            name: string;
            subject: string;
            scopes: ReadonlyArray<string>;
            revokedAt: number | null;
          }>`
          select id, name, subject, scopes, revoked_at from api_keys where hash = ${yield* hashKey(
            key,
          )}
        `.pipe(Effect.catchTag("SqlError", Effect.die));

          const row = rows[0];
          if (row === undefined) return yield* new CredentialRejected({ reason: "Invalid" });
          if (row.revokedAt !== null) return yield* new CredentialRejected({ reason: "Revoked" });

          // Useful for spotting keys nobody uses any more, but not worth failing a request over.
          yield* sql`update api_keys set last_used_at = now() where id = ${row.id}`.pipe(
            Effect.ignore,
          );

          return new Principal({
            subject: row.subject,
            kind: "api_key",
            displayName: row.name,
            credentialId: row.id,
            scopes: row.scopes,
          });
        });

        const create = Effect.fn("ApiKeys.create")(
          function*(input: Parameters<ApiKeysService["create"]>[0]) {
            const id = `key_${yield* crypto.randomUUIDv4.pipe(
              Effect.catchTag("PlatformError", Effect.die),
            )}`;
            const secret = yield* crypto.randomBytes(32).pipe(
              Effect.catchTag("PlatformError", Effect.die),
            );
            const key = `${API_KEY_PREFIX}${Encoding.encodeBase64Url(secret)}`;
            // Typed explicitly: the driver cannot infer a type for an empty array.
            const scopes = yield* Effect.fromResult(PgTypes.array(input.scopes, PgTypes.OID.text))
              .pipe(
                Effect.catchTag("PgTypesCodecError", Effect.die),
              );
            yield* sql`
            insert into api_keys ${
              sql.insert({
                id,
                name: input.name,
                subject: input.subject,
                scopes,
                hash: yield* hashKey(key),
                hint: key.slice(-6),
              })
            }
          `.pipe(Effect.catchTag("SqlError", Effect.die));
            return { id, key };
          },
        );

        const revoke = Effect.fn("ApiKeys.revoke")(function*(id: string) {
          const rows = yield* sql<{ id: string; }>`
          update api_keys set revoked_at = now()
          where id = ${id} and revoked_at is null
          returning id
        `.pipe(Effect.catchTag("SqlError", Effect.die));
          return rows.length > 0;
        });

        const list = sql`
        select id, name, subject, scopes, hint, created_at, last_used_at, revoked_at
        from api_keys order by created_at desc
      `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ApiKeyRecord))),
          Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
          Effect.withSpan("ApiKeys.list"),
        );

        return { authenticate, create, revoke, list };
      }),
    );

  /**
   * Keys held in memory, for tests and for running without Postgres. `keys` maps a
   * key to the principal it authenticates as.
   */
  static memory(keys: ReadonlyMap<string, Principal>): Layer.Layer<ApiKeys> {
    return Layer.succeed(ApiKeys)({
      authenticate: (key) =>
        Effect.fromOption(Option.fromNullishOr(keys.get(key))).pipe(
          Effect.mapError(() => new CredentialRejected({ reason: "Invalid" })),
        ),
      create: () => Effect.die("ApiKeys.memory cannot create keys"),
      revoke: () => Effect.succeed(false),
      list: Effect.succeed([]),
    });
  }
}
