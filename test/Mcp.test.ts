import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option } from "effect";
import { Principal } from "../src/auth/Principal.ts";
import { CrmClient } from "../src/crm/CrmClient.ts";
import { makeTestServer, RESOURCE, signToken } from "./support/TestServer.ts";

const textOf = (result: Record<string, unknown>): string =>
  (result["content"] as ReadonlyArray<{ text: string; }>).map((part) => part.text).join("");

const post = (fetch: (input: string, init?: RequestInit) => Promise<Response>, token?: string) =>
  fetch(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "curl", version: "1" },
      },
    }),
  });

describe("connecting", () => {
  it("answers a request without a token with a challenge that leads to the identity provider", async () => {
    const server = await makeTestServer();
    const response = await post(server.fetch);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      "Bearer resource_metadata=\"http://mcp.test/.well-known/oauth-protected-resource/mcp\"",
    );

    const metadata = await server.fetch("http://mcp.test/.well-known/oauth-protected-resource/mcp");
    expect(await metadata.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: ["https://id.example.com/"],
      scopes_supported: ["crm:read", "crm:write"],
    });
    await server.dispose();
  });

  it("refuses expired tokens and tokens issued for another server", async () => {
    const server = await makeTestServer();
    const expired = await signToken({ expiresIn: "-1m" });
    const otherAudience = await signToken({ aud: "https://other.example.com/mcp" });

    for (const token of [expired, otherAudience, "not-a-jwt"]) {
      const response = await post(server.fetch, token);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("error=\"invalid_token\"");
    }
    await server.dispose();
  });

  it("accepts an API key and treats it like any other caller", async () => {
    const server = await makeTestServer({
      apiKeys: new Map([[
        "mcp_test_key",
        new Principal({
          subject: "svc:billing-sync",
          kind: "api_key",
          displayName: "billing sync",
          credentialId: "key_1",
          scopes: ["crm:read"],
        }),
      ]]),
    });
    const client = await server.connect("mcp_test_key");

    const result = await client.callTool({
      name: "get_customer",
      arguments: { customerId: "cus_1002" },
    });
    expect(result.isError).toBe(false);
    expect(server.auditEntries()).toMatchObject([
      {
        subject: "svc:billing-sync",
        principalKind: "api_key",
        credentialId: "key_1",
        outcome: "ok",
      },
    ]);

    await client.close();
    await server.dispose();
  });

  it("serves the metadata only when an identity provider is configured", async () => {
    const server = await makeTestServer({ settings: { oidc: Option.none() } });
    const response = await post(server.fetch);
    expect(response.headers.get("www-authenticate")).toBe("Bearer realm=\"mcp\"");
    const metadata = await server.fetch("http://mcp.test/.well-known/oauth-protected-resource");
    expect(metadata.status).toBe(404);
    await server.dispose();
  });
});

describe("tools", () => {
  it("lists every tool with its schema and honest hints", async () => {
    const server = await makeTestServer();
    const client = await server.connect(await signToken({}));
    const { tools } = await client.listTools();

    expect(
      tools.map((
        tool,
      ) => [tool.name, tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint]),
    ).toEqual([
      ["get_customer", true, false],
      ["search_customers", true, false],
      ["add_customer_note", false, false],
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({ required: ["customerId"] });

    await client.close();
    await server.dispose();
  });

  it("returns a typed result and records who called what", async () => {
    const server = await makeTestServer();
    const client = await server.connect(await signToken({ jti: "token_1" }));

    const result = await client.callTool({
      name: "get_customer",
      arguments: { customerId: "cus_1001" },
    });

    expect(result.structuredContent).toEqual({
      id: "cus_1001",
      name: "Northwind Traders",
      plan: "enterprise",
      openTickets: 3,
      accountManager: "maria@example.com",
    });
    expect(server.auditEntries()).toMatchObject([{
      subject: "user_ada",
      principalKind: "user",
      credentialId: "token_1",
      clientName: "test-client",
      tool: "get_customer",
      arguments: { customerId: "cus_1001" },
      outcome: "ok",
      error: null,
    }]);

    await client.close();
    await server.dispose();
  });

  it("refuses a tool whose scope the caller lacks, and audits the attempt", async () => {
    const server = await makeTestServer();
    const client = await server.connect(await signToken({ scope: "crm:read" }));

    const result = await client.callTool({
      name: "add_customer_note",
      arguments: { customerId: "cus_1001", body: "Renewal call went well." },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("needs the crm:write scope");
    expect(server.auditEntries()).toMatchObject([
      { tool: "add_customer_note", outcome: "denied", error: "Forbidden" },
    ]);

    await client.close();
    await server.dispose();
  });

  it("reads scopes from `scp` as Entra ID sends them, and attributes writes to the caller", async () => {
    const server = await makeTestServer();
    const client = await server.connect(
      await signToken({ scope: undefined, scp: ["crm:read", "crm:write"] }),
    );

    const result = await client.callTool({
      name: "add_customer_note",
      arguments: { customerId: "cus_1001", body: "Renewal call went well." },
    });

    expect(result.structuredContent).toMatchObject({ author: "user_ada", customerId: "cus_1001" });
    await client.close();
    await server.dispose();
  });

  it("passes a tool's own error to the agent", async () => {
    const server = await makeTestServer();
    const client = await server.connect(await signToken({}));

    const result = await client.callTool({
      name: "get_customer",
      arguments: { customerId: "cus_9999" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("No customer with id cus_9999.");
    expect(server.auditEntries()).toMatchObject([{ outcome: "failed", error: "CustomerNotFound" }]);

    await client.close();
    await server.dispose();
  });

  it("rejects arguments that do not match the schema before the tool runs", async () => {
    const server = await makeTestServer();
    const client = await server.connect(await signToken({}));

    const result = await client.callTool({
      name: "search_customers",
      arguments: { query: "a", limit: 500 },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Expected a value between 1 and 25");
    expect(server.auditEntries()).toEqual([]);

    await client.close();
    await server.dispose();
  });

  it("limits calls per caller and tool", async () => {
    const server = await makeTestServer({
      settings: { rateLimit: { limit: 2, window: Duration.minutes(1) } },
    });
    const ada = await server.connect(await signToken({}));
    const grace = await server.connect(await signToken({ sub: "user_grace" }));
    const call = (client: typeof ada) =>
      client.callTool({ name: "search_customers", arguments: { query: "o", limit: 5 } });

    await call(ada);
    await call(ada);
    const limited = await call(ada);
    const otherCaller = await call(grace);

    expect(limited.isError).toBe(true);
    expect(textOf(limited)).toContain("Too many calls to search_customers");
    expect(otherCaller.isError).toBe(false);
    expect(server.auditEntries().map((entry) => entry.outcome)).toEqual([
      "ok",
      "ok",
      "rate_limited",
      "ok",
    ]);

    await ada.close();
    await grace.close();
    await server.dispose();
  });

  it("stops a tool that runs past its time limit", async () => {
    const hanging = Layer.succeed(CrmClient)({
      getCustomer: () => Effect.never,
      searchCustomers: () => Effect.never,
      addNote: () => Effect.never,
    });
    const server = await makeTestServer({
      crm: hanging,
      settings: { toolTimeout: Duration.millis(50) },
    });
    const client = await server.connect(await signToken({}));

    const result = await client.callTool({
      name: "get_customer",
      arguments: { customerId: "cus_1001" },
    });

    expect(textOf(result)).toContain("did not finish within 0.05 seconds");
    expect(server.auditEntries()).toMatchObject([{ outcome: "failed", error: "ToolTimedOut" }]);

    await client.close();
    await server.dispose();
  });
});
