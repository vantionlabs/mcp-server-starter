import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { parseArgs } from "node:util";
import { ApiKeys } from "../auth/ApiKeys.ts";
import { DatabaseLive } from "../database/Database.ts";

const usage = `Manage API keys.

  pnpm api-keys create --name <name> --subject <subject> --scopes <scope,scope>
  pnpm api-keys list
  pnpm api-keys revoke <id>

Example:
  pnpm api-keys create --name "billing sync" --subject svc:billing-sync --scopes crm:read`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    subject: { type: "string" },
    scopes: { type: "string" },
  },
});

const program = Effect.gen(function*() {
  const keys = yield* ApiKeys;
  const [command, id] = positionals;

  switch (command) {
    case "create": {
      if (values.name === undefined || values.subject === undefined) {
        return yield* Console.log(usage);
      }
      const scopes = (values.scopes ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
      const created = yield* keys.create({ name: values.name, subject: values.subject, scopes });
      yield* Console.log(`Created ${created.id} with scopes: ${scopes.join(", ") || "(none)"}`);
      yield* Console.log(`\n  ${created.key}\n`);
      return yield* Console.log("This is the only time the key is shown. Store it now.");
    }
    case "list": {
      const all = yield* keys.list;
      if (all.length === 0) return yield* Console.log("No API keys.");
      return yield* Console.table(all.map((key) => ({
        id: key.id,
        name: key.name,
        subject: key.subject,
        scopes: key.scopes.join(" "),
        ends: `…${key.hint}`,
        lastUsed: key.lastUsedAt?.toISOString() ?? "never",
        status: key.revokedAt === null ? "active" : "revoked",
      })));
    }
    case "revoke": {
      if (id === undefined) return yield* Console.log(usage);
      const revoked = yield* keys.revoke(id);
      return yield* Console.log(revoked ? `Revoked ${id}.` : `No active key with id ${id}.`);
    }
    case undefined:
    default:
      return yield* Console.log(usage);
  }
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(
      ApiKeys.layer.pipe(Layer.provide(DatabaseLive), Layer.provide(NodeCrypto.layer)),
    ),
  ),
);
