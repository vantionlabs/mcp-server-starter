import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { GuardFailures, ToolGuard } from "../tools/ToolGuard.ts";
import {
  CrmClient,
  CrmUnavailable,
  Customer,
  CustomerNotFound,
  CustomerSummary,
  Note,
} from "./CrmClient.ts";

// MCP clients treat a tool as destructive unless told otherwise, and some ask the
// user before every destructive call. Annotate each tool honestly: these hints
// are what lets a client run a read without interrupting anyone.

/** Every scope these tools check. Advertised in the protected resource metadata. */
export const CrmScopes = {
  read: "crm:read",
  write: "crm:write",
} as const;

const GetCustomer = Tool.make("get_customer", {
  description:
    "Look up one customer by id: plan, open support tickets and account manager. Use search_customers first if you only have a name.",
  parameters: Schema.Struct({
    customerId: Schema.String.annotate({ description: "The customer id, such as cus_1001." }),
  }),
  success: Customer,
  failure: Schema.Union([CustomerNotFound, CrmUnavailable, ...GuardFailures]),
})
  .annotate(Tool.Title, "Get customer")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchCustomers = Tool.make("search_customers", {
  description: "Find customers whose name contains the query. Returns at most `limit` matches.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({ description: "Part of the customer's name." }),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({
      description: "How many matches to return, from 1 to 25.",
    }),
  }),
  success: Schema.Struct({ customers: Schema.Array(CustomerSummary) }),
  failure: Schema.Union([CrmUnavailable, ...GuardFailures]),
})
  .annotate(Tool.Title, "Search customers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AddCustomerNote = Tool.make("add_customer_note", {
  description:
    "Add a note to a customer's record. The note is attributed to the person or key calling this tool.",
  parameters: Schema.Struct({
    customerId: Schema.String.annotate({ description: "The customer id, such as cus_1001." }),
    body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).annotate({
      description: "The note, in plain text, up to 2000 characters.",
    }),
  }),
  success: Note,
  failure: Schema.Union([CustomerNotFound, CrmUnavailable, ...GuardFailures]),
})
  .annotate(Tool.Title, "Add customer note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/**
 * The example tools. Copy this file for each system you expose: a toolkit per
 * system keeps its scopes, schemas and client together.
 */
export const CrmToolkit = Toolkit.make(GetCustomer, SearchCustomers, AddCustomerNote);

export const CrmToolkitLive = CrmToolkit.toLayer(
  Effect.gen(function*() {
    const guard = yield* ToolGuard;
    const crm = yield* CrmClient;

    return CrmToolkit.of({
      get_customer: (params) =>
        guard.run(
          { tool: "get_customer", scope: CrmScopes.read, arguments: params },
          () => crm.getCustomer(params.customerId),
        ),
      search_customers: (params) =>
        guard.run(
          { tool: "search_customers", scope: CrmScopes.read, arguments: params },
          () =>
            Effect.map(crm.searchCustomers(params.query, params.limit), (customers) => ({
              customers,
            })),
        ),
      add_customer_note: (params) =>
        guard.run(
          { tool: "add_customer_note", scope: CrmScopes.write, arguments: params },
          () => crm.addNote(params.customerId, params.body),
        ),
    });
  }),
);
