import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Ref } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { CurrentPrincipal, Principal } from "../../src/auth/Principal.ts";
import { CrmClient } from "../../src/crm/CrmClient.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly onBehalfOf: string | undefined;
  readonly authorization: string | undefined;
}

/** A CRM that answers from `respond` and remembers every request it received. */
const fakeCrm = (seen: Ref.Ref<ReadonlyArray<Seen>>, respond: (url: URL) => Response) =>
  CrmClient.layerHttp.pipe(
    Layer.provide(
      Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request, url) =>
          Ref.update(seen, (all) => [...all, {
            method: request.method,
            url: url.toString(),
            onBehalfOf: request.headers["x-on-behalf-of"],
            authorization: request.headers["authorization"],
          }]).pipe(Effect.as(HttpClientResponse.fromWeb(request, respond(url))))
        ),
      ),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
      env: { CRM_BASE_URL: "https://crm.internal/api", CRM_API_TOKEN: "server-token" },
    }))),
  );

const ada = new Principal({
  subject: "user_ada",
  kind: "user",
  displayName: "ada@example.com",
  credentialId: "t1",
  scopes: [],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("CrmClient.layerHttp", () => {
  it.effect("names the caller and authenticates as the server", () =>
    Effect.gen(function*() {
      const seen = yield* Ref.make<ReadonlyArray<Seen>>([]);
      const customer = {
        id: "cus_1",
        name: "Acme",
        plan: "team",
        openTickets: 2,
        accountManager: "sam@example.com",
      };

      const result = yield* Effect.flatMap(CrmClient, (crm) => crm.getCustomer("cus_1")).pipe(
        Effect.provideService(CurrentPrincipal, Option.some(ada)),
        Effect.provide(fakeCrm(seen, () => json(customer))),
      );

      expect(result).toMatchObject(customer);
      expect(yield* Ref.get(seen)).toEqual([{
        method: "GET",
        url: "https://crm.internal/api/customers/cus_1",
        onBehalfOf: "user_ada",
        authorization: "Bearer server-token",
      }]);
    }));

  it.effect("turns a 404 into CustomerNotFound and an outage into CrmUnavailable", () =>
    Effect.gen(function*() {
      const seen = yield* Ref.make<ReadonlyArray<Seen>>([]);
      const layer = fakeCrm(
        seen,
        (url) => url.pathname.endsWith("missing") ? json({}, 404) : json({ error: "boom" }, 500),
      );

      const notFound = yield* Effect.flatMap(
        CrmClient,
        (crm) => Effect.flip(crm.getCustomer("missing")),
      ).pipe(
        Effect.provide(layer),
      );
      const unavailable = yield* Effect.flatMap(
        CrmClient,
        (crm) => Effect.flip(crm.addNote("cus_1", "hi")),
      ).pipe(
        Effect.provide(layer),
      );

      expect(notFound._tag).toBe("CustomerNotFound");
      expect(unavailable._tag).toBe("CrmUnavailable");
      // The failed POST was sent once: a retry could have written the note twice.
      expect((yield* Ref.get(seen)).filter((request) => request.method === "POST")).toHaveLength(1);
    }));
});
