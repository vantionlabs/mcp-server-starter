# Adding tools

The example in `src/crm/` is the pattern to copy: one directory per system you
expose, holding a client for that system and a toolkit of tools that use it.

## 1. A client for the system

`src/billing/BillingClient.ts` is a service with one method per operation and
typed errors the agent can act on:

```ts
export class InvoiceNotFound extends Schema.TaggedError<InvoiceNotFound>()("InvoiceNotFound", {
  invoiceId: Schema.String,
}) {
  override get message(): string {
    return `No invoice with id ${this.invoiceId}.`;
  }
}

export class BillingClient extends Context.Service<BillingClient, {
  readonly getInvoice: (id: string) => Effect.Effect<Invoice, InvoiceNotFound | BillingUnavailable>;
}>()("BillingClient") {
  static readonly layer = Layer.effect(BillingClient)(/* ... */);
}
```

Things to carry over from `CrmClient`:

- **Forward the caller.** Read `CurrentPrincipal` and send the subject to the
  system, so it can apply its own permissions and keep its own records.
- **Errors with messages meant for the agent.** The message is what the agent
  reads when the call fails. Say what happened and what to do next.
- **Retry reads, not writes.** A retried write whose first attempt did arrive
  runs twice.
- **No secrets in results.** Everything a tool returns goes to the model.

## 2. A toolkit

`src/billing/BillingToolkit.ts`:

```ts
export const BillingScopes = { read: "billing:read" } as const;

const GetInvoice = Tool.make("get_invoice", {
  description: "Look up one invoice by id: amount, status and due date.",
  parameters: Schema.Struct({
    invoiceId: Schema.String.annotate({ description: "The invoice id, such as inv_2041." }),
  }),
  success: Invoice,
  failure: Schema.Union([InvoiceNotFound, BillingUnavailable, ...GuardFailures]),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BillingToolkit = Toolkit.make(GetInvoice);

export const BillingToolkitLive = BillingToolkit.toLayer(
  Effect.gen(function*() {
    const guard = yield* ToolGuard;
    const billing = yield* BillingClient;
    return BillingToolkit.of({
      get_invoice: (params) =>
        guard.run(
          { tool: "get_invoice", scope: BillingScopes.read, arguments: params },
          () => billing.getInvoice(params.invoiceId),
        ),
    });
  }),
);
```

The rules that matter:

- **Every handler goes through `guard.run`.** That is where the scope check, rate
  limit, time limit and audit entry happen. A handler that skips it skips all four.
- **Include `...GuardFailures` in `failure`.** The MCP server only passes a
  failure's message to the client when the tool declares that failure. Anything
  undeclared is reported as an internal error.
- **Describe the tool for a model.** The description and parameter descriptions
  are the only documentation the agent gets. Say when to use the tool, and point
  to the tool to use first if it needs an id the agent may not have.
- **Annotate honestly.** Clients treat a tool as destructive unless told
  otherwise, and may ask the user before each call.
- **Don't take secrets as arguments.** Arguments are stored in the audit log as
  given.

## 3. Register it

In `src/server/App.ts`, add the toolkit next to `CrmToolkit` and its scopes to
`ALL_SCOPES`:

```ts
return McpServer.toolkit(Toolkit.merge(CrmToolkit, BillingToolkit)).pipe(
  // ...
  Layer.provide(CrmToolkitLive),
  Layer.provide(BillingToolkitLive),
  // ...
);
```

Add the client's layer to `ServicesLive`, and the new scopes at your identity
provider.

## 4. Test it

`test/Mcp.test.ts` connects a real MCP client to the server with in-memory
boundaries. Add the cases that matter for your tool: a successful call, the call
refused without its scope, and each error the agent should see. Replace the
client with a `Layer.succeed(BillingClient)({ ... })` stub so the test does not
need the real system.

## Resources and prompts

`effect/unstable/ai` also supports MCP resources and prompts, through
`McpServer.resource` and `McpServer.prompt`. They are not guarded by `ToolGuard`,
so check `CurrentPrincipal` yourself in any that expose data.
