import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Layer, String } from "effect";
import { Migrator, type SqlClient } from "effect/unstable/sql";
import Initial from "./migrations/0001_initial.ts";

/**
 * The Postgres client, configured from `DATABASE_URL`.
 *
 * Column names are snake_case in the database and camelCase in TypeScript; the
 * transforms convert both ways so neither side has to compromise.
 */
export const PgLive: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never> = Layer.unwrap(
  Effect.gen(function*() {
    const url = yield* Config.Redacted("DATABASE_URL");
    return PgClient.layer({
      url,
      transformQueryNames: String.camelToSnake,
      transformResultNames: String.snakeToCamel,
    });
  }),
).pipe(Layer.orDie);

/**
 * Applies pending migrations before anything else touches the database.
 *
 * The migrator takes a lock and records what it ran, so several replicas starting
 * together apply each migration exactly once. Add a migration by adding a file to
 * `migrations/` and a line to this record.
 */
export const MigrationsLive: Layer.Layer<never, never, SqlClient.SqlClient> = Layer.effectDiscard(
  Migrator.make({})({
    loader: Migrator.fromRecord({
      "0001_initial": Initial,
    }),
    table: "schema_migrations",
  }),
).pipe(Layer.orDie);

/** The client with the schema guaranteed to be current. */
export const DatabaseLive: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient> = MigrationsLive
  .pipe(Layer.provideMerge(PgLive));
