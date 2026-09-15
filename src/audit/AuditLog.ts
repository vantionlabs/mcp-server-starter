import { Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";

export type AuditOutcome = "ok" | "denied" | "rate_limited" | "failed";

export interface AuditEntry {
  readonly subject: string;
  readonly principalKind: string;
  readonly credentialId: string;
  /** The MCP client's own name from `initialize`, such as "claude-code". Self-reported. */
  readonly clientName: string | null;
  readonly tool: string;
  readonly arguments: unknown;
  readonly outcome: AuditOutcome;
  /** The error's tag for a refused or failed call. Never the message, which may quote data. */
  readonly error: string | null;
  readonly durationMs: number;
}

export interface AuditLogService {
  readonly record: (entry: AuditEntry) => Effect.Effect<void>;
}

/**
 * The record of every tool call: who, which tool, with what arguments, what
 * happened and how long it took.
 *
 * Writing it is part of the call. If the entry cannot be written, the call fails
 * rather than returning a result nobody can account for later. Tools must not take
 * secrets as arguments, because arguments are stored as given.
 *
 * To ship entries to a log pipeline as well, add it to `record`; every call site
 * goes through here.
 */
export class AuditLog extends Context.Service<AuditLog, AuditLogService>()("AuditLog") {
  static readonly layer: Layer.Layer<AuditLog, never, SqlClient.SqlClient> = Layer.effect(AuditLog)(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient;
      return {
        record: (entry) =>
          sql`
            insert into audit_log ${
            sql.insert({
              subject: entry.subject,
              principalKind: entry.principalKind,
              credentialId: entry.credentialId,
              clientName: entry.clientName,
              tool: entry.tool,
              arguments: JSON.stringify(entry.arguments ?? {}),
              outcome: entry.outcome,
              error: entry.error,
              durationMs: entry.durationMs,
            })
          }
          `.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", Effect.die),
            Effect.withSpan("AuditLog.record", { attributes: { tool: entry.tool } }),
          ),
      };
    }),
  );

  /** Entries kept in a `Ref`, for tests. */
  static memory(entries: Ref.Ref<ReadonlyArray<AuditEntry>>): Layer.Layer<AuditLog> {
    return Layer.succeed(AuditLog)({
      record: (entry) => Ref.update(entries, (all) => [...all, entry]),
    });
  }
}
