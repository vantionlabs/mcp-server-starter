import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";

/**
 * `/health` answers while the process is up. `/health/ready` also checks the
 * database, for a platform deciding whether to send this instance traffic.
 */
export const HealthRoutes: Layer.Layer<never, never, HttpRouter.HttpRouter | SqlClient.SqlClient> =
  Layer.unwrap(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient;
      const ok = HttpServerResponse.jsonUnsafe({ status: "ok" });
      return Layer.mergeAll(
        HttpRouter.add("GET", "/health", Effect.succeed(ok)),
        HttpRouter.add(
          "GET",
          "/health/ready",
          Effect.suspend(() => sql`select 1`).pipe(
            Effect.as(ok),
            Effect.catchTag("SqlError", () =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe({ status: "unavailable" }, { status: 503 }),
              )),
          ),
        ),
      );
    }),
  );
