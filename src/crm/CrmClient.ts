import { Config, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { CurrentPrincipal } from "../auth/Principal.ts";

export class Customer extends Schema.Class<Customer>("Customer")({
  id: Schema.String,
  name: Schema.String,
  plan: Schema.Literals(["free", "team", "enterprise"]),
  openTickets: Schema.Int,
  accountManager: Schema.String,
}) {}

export class CustomerSummary extends Schema.Class<CustomerSummary>("CustomerSummary")({
  id: Schema.String,
  name: Schema.String,
  plan: Schema.Literals(["free", "team", "enterprise"]),
}) {}

export class Note extends Schema.Class<Note>("Note")({
  id: Schema.String,
  customerId: Schema.String,
  body: Schema.String,
  author: Schema.String,
}) {}

export class CustomerNotFound extends Schema.TaggedError<CustomerNotFound>()("CustomerNotFound", {
  customerId: Schema.String,
}) {
  override get message(): string {
    return `No customer with id ${this.customerId}.`;
  }
}

/** The CRM did not answer, or answered with something unexpected. Safe to retry later. */
export class CrmUnavailable extends Schema.TaggedError<CrmUnavailable>()("CrmUnavailable", {}) {
  override get message(): string {
    return "The CRM is not responding. Try again shortly.";
  }
}

export interface CrmClientService {
  readonly getCustomer: (
    customerId: string,
  ) => Effect.Effect<Customer, CustomerNotFound | CrmUnavailable>;
  readonly searchCustomers: (
    query: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<CustomerSummary>, CrmUnavailable>;
  readonly addNote: (
    customerId: string,
    body: string,
  ) => Effect.Effect<Note, CustomerNotFound | CrmUnavailable>;
}

/** Who the CRM should attribute a request to. */
const onBehalfOf = Effect.map(
  CurrentPrincipal,
  Option.match({ onNone: () => "unknown", onSome: (principal) => principal.subject }),
);

/**
 * The internal system the example tools talk to.
 *
 * Replace this with a client for your own system. Keep the shape: a service with
 * typed errors the agent can act on, which forwards who the caller is so the
 * system behind it can apply its own permissions and keep its own records.
 */
export class CrmClient extends Context.Service<CrmClient, CrmClientService>()("CrmClient") {
  /**
   * Talks to a CRM over HTTP at `CRM_BASE_URL`, authenticating as this server
   * with `CRM_API_TOKEN` and naming the caller in `X-On-Behalf-Of`.
   */
  static readonly layerHttp: Layer.Layer<CrmClient, Config.ConfigError, HttpClient.HttpClient> =
    Layer.effect(
      CrmClient,
    )(
      Effect.gen(function*() {
        const baseUrl = yield* Config.URL("CRM_BASE_URL");
        const token = yield* Config.Redacted("CRM_API_TOKEN");
        const http = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.prependUrl(baseUrl.toString()),
              HttpClientRequest.bearerToken(Redacted.value(token)),
              HttpClientRequest.acceptJson,
            )
          ),
        );
        // Reads retry on transient failures. Writes do not: a retried POST whose first
        // attempt did reach the CRM would add the note twice.
        const reads = http.pipe(HttpClient.retryTransient({ times: 2 }));

        const send = <S extends Schema.Top>(
          client: HttpClient.HttpClient,
          request: HttpClientRequest.HttpClientRequest,
          schema: S,
        ) =>
          Effect.flatMap(
            onBehalfOf,
            (caller) =>
              client.execute(request.pipe(HttpClientRequest.setHeader("x-on-behalf-of", caller))),
          ).pipe(
            Effect.flatMap((response) =>
              response.status === 404
                ? Effect.succeedNone
                : HttpClientResponse.filterStatusOk(response).pipe(
                  Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
                  Effect.asSome,
                )
            ),
            Effect.catchTags({
              HttpClientError: () => Effect.fail(new CrmUnavailable({})),
              SchemaError: () => Effect.fail(new CrmUnavailable({})),
            }),
          );

        return {
          getCustomer: (customerId) =>
            send(
              reads,
              HttpClientRequest.get(`/customers/${encodeURIComponent(customerId)}`),
              Customer,
            ).pipe(
              Effect.flatMap(Effect.fromOption),
              Effect.catchTag(
                "NoSuchElementError",
                () => Effect.fail(new CustomerNotFound({ customerId })),
              ),
              Effect.withSpan("CrmClient.getCustomer"),
            ),
          searchCustomers: (query, limit) =>
            send(
              reads,
              HttpClientRequest.get("/customers").pipe(
                HttpClientRequest.setUrlParams({ q: query, limit: String(limit) }),
              ),
              Schema.Array(CustomerSummary),
            ).pipe(
              Effect.map(Option.getOrElse(() => [])),
              Effect.withSpan("CrmClient.searchCustomers"),
            ),
          addNote: (customerId, body) =>
            send(
              http,
              HttpClientRequest.post(`/customers/${encodeURIComponent(customerId)}/notes`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ body }),
              ),
              Note,
            ).pipe(
              Effect.flatMap(Effect.fromOption),
              Effect.catchTag("NoSuchElementError", () =>
                Effect.fail(new CustomerNotFound({ customerId }))),
              Effect.withSpan("CrmClient.addNote"),
            ),
        };
      }),
    );

  /**
   * A small CRM held in memory, so the server does something useful before it is
   * connected to anything real. Notes are kept until the process restarts.
   */
  static readonly layerDemo: Layer.Layer<CrmClient> = Layer.effect(CrmClient)(
    Effect.gen(function*() {
      const customers: ReadonlyArray<Customer> = [
        new Customer({
          id: "cus_1001",
          name: "Northwind Traders",
          plan: "enterprise",
          openTickets: 3,
          accountManager: "maria@example.com",
        }),
        new Customer({
          id: "cus_1002",
          name: "Globex Logistics",
          plan: "team",
          openTickets: 0,
          accountManager: "sam@example.com",
        }),
        new Customer({
          id: "cus_1003",
          name: "Initech Software",
          plan: "free",
          openTickets: 1,
          accountManager: "maria@example.com",
        }),
      ];
      const notes = yield* Ref.make<ReadonlyArray<Note>>([]);

      const find = (customerId: string) =>
        Effect.fromOption(Option.fromNullishOr(customers.find((c) => c.id === customerId))).pipe(
          Effect.mapError(() => new CustomerNotFound({ customerId })),
        );

      return {
        getCustomer: find,
        searchCustomers: (query, limit) =>
          Effect.succeed(
            customers
              .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
              .slice(0, limit)
              .map((c) => new CustomerSummary({ id: c.id, name: c.name, plan: c.plan })),
          ),
        addNote: (customerId, body) =>
          Effect.gen(function*() {
            yield* find(customerId);
            const author = yield* onBehalfOf;
            const existing = yield* Ref.get(notes);
            const note = new Note({
              id: `note_${existing.length + 1}`,
              customerId,
              body,
              author,
            });
            yield* Ref.set(notes, [...existing, note]);
            return note;
          }),
      };
    }),
  );

  /** The HTTP client when `CRM_BASE_URL` is set, the demo otherwise. */
  static readonly layer: Layer.Layer<CrmClient, never, HttpClient.HttpClient> = Layer.unwrap(
    Effect.map(
      Config.option(Config.URL("CRM_BASE_URL")),
      Option.match({ onNone: () => CrmClient.layerDemo, onSome: () => CrmClient.layerHttp }),
    ),
  ).pipe(Layer.orDie);
}
