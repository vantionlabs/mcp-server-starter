import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuditLog } from "../../src/audit/AuditLog.ts";
import { ApiKeys } from "../../src/auth/ApiKeys.ts";
import { DatabaseLive } from "../../src/database/Database.ts";

/**
 * Runs against the database in `DATABASE_URL`, and is skipped without one. Start
 * one with `docker compose up -d postgres`. The tables are emptied first, so do
 * not point this at a database you care about.
 */
// oxlint-disable-next-line effecttsgo/process-env -- decides whether to register the suite at all
const live = process.env["DATABASE_URL"] !== undefined;

const TestLayer = Layer.mergeAll(ApiKeys.layer, AuditLog.layer).pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(DatabaseLive),
);

describe.skipIf(!live)("Postgres", () => {
  it.layer(TestLayer, { timeout: 30_000 })((it) => {
    it.effect("creates a key that authenticates until it is revoked", () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`truncate api_keys`;
        const keys = yield* ApiKeys;

        const { id, key } = yield* keys.create({
          name: "billing sync",
          subject: "svc:billing-sync",
          scopes: ["crm:read", "crm:write"],
        });

        const principal = yield* keys.authenticate(key);
        expect(principal).toMatchObject({
          subject: "svc:billing-sync",
          kind: "api_key",
          credentialId: id,
          scopes: ["crm:read", "crm:write"],
        });

        const [stored] = yield* keys.list;
        expect(stored).toMatchObject({ id, hint: key.slice(-6), revokedAt: null });
        expect(stored?.lastUsedAt).toBeInstanceOf(Date);

        expect(yield* keys.revoke(id)).toBe(true);
        expect(yield* keys.revoke(id)).toBe(false);
        const refused = yield* Effect.flip(keys.authenticate(key));
        expect(refused.reason).toBe("Revoked");

        const unknown = yield* Effect.flip(keys.authenticate("mcp_not_a_real_key"));
        expect(unknown.reason).toBe("Invalid");
      }));

    it.effect("stores only the key's hash", () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient;
        const { key } = yield* (yield* ApiKeys).create({ name: "n", subject: "s", scopes: [] });
        const rows = yield* sql<{ count: number; }>`
          select count(*)::int as count from api_keys where hash = ${key} or hint = ${key}
        `;
        expect(rows[0]?.count).toBe(0);
      }));

    it.effect("writes audit entries with their arguments as JSON", () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`truncate audit_log`;

        yield* (yield* AuditLog).record({
          subject: "user_ada",
          principalKind: "user",
          credentialId: "token_1",
          clientName: "claude-code",
          tool: "get_customer",
          arguments: { customerId: "cus_1001" },
          outcome: "ok",
          error: null,
          durationMs: 12,
        });

        const rows = yield* sql<{ tool: string; arguments: unknown; outcome: string; }>`
          select tool, arguments, outcome from audit_log
        `;
        expect(rows).toEqual([{
          tool: "get_customer",
          arguments: { customerId: "cus_1001" },
          outcome: "ok",
        }]);
      }));
  });
});
