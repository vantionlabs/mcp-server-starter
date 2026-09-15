import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { McpSchema } from "effect/unstable/ai";
import { RateLimiter } from "effect/unstable/persistence";
import { AuditLog, type AuditOutcome } from "../audit/AuditLog.ts";
import { CurrentPrincipal, type Principal } from "../auth/Principal.ts";
import { ServerConfig } from "../server/ServerConfig.ts";

/** The caller signed in, but lacks the scope this tool needs. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  tool: Schema.String,
  scope: Schema.String,
}) {
  override get message(): string {
    return `Calling ${this.tool} needs the ${this.scope} scope, which this credential does not have.`;
  }
}

/** Too many calls to this tool from this caller in the current window. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  tool: Schema.String,
  retryAfterSeconds: Schema.Finite,
}) {
  override get message(): string {
    return `Too many calls to ${this.tool}. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}

/** The tool ran past its time limit and was stopped. */
export class ToolTimedOut extends Schema.TaggedError<ToolTimedOut>()("ToolTimedOut", {
  tool: Schema.String,
  seconds: Schema.Finite,
}) {
  override get message(): string {
    return `${this.tool} did not finish within ${this.seconds} seconds.`;
  }
}

/**
 * No principal reached the tool. Over HTTP the auth middleware makes this
 * impossible; it exists so a transport added later without auth fails closed.
 */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {}) {
  override get message(): string {
    return "This tool needs an authenticated caller.";
  }
}

/**
 * The failures every guarded tool can return. Add them to each tool's `failure`
 * schema: the MCP server only passes a failure's message to the client when the
 * tool declared it, and reports anything else as an internal error.
 */
export const GuardFailures = [Forbidden, RateLimited, ToolTimedOut, Unauthenticated] as const;
export type GuardFailure = Forbidden | RateLimited | ToolTimedOut | Unauthenticated;

export interface GuardedCall {
  readonly tool: string;
  /** The scope the caller must hold. */
  readonly scope: string;
  /** Recorded in the audit log as given. */
  readonly arguments: unknown;
}

export interface ToolGuardService {
  readonly run: <A, E, R>(
    call: GuardedCall,
    use: (principal: Principal) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GuardFailure, R>;
}

const outcomeOf = <A, E>(
  exit: Exit.Exit<A, E>,
): { outcome: AuditOutcome; error: string | null; } => {
  if (Exit.isSuccess(exit)) return { outcome: "ok", error: null };
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) {
    return {
      outcome: "failed",
      error: Cause.hasInterruptsOnly(exit.cause) ? "Interrupted" : "Defect",
    };
  }
  const error: unknown = failure.value;
  // Tools declare their failures as tagged errors; the tag is what gets recorded,
  // because a message can quote the data the tool was handling.
  const tag = Predicate.hasProperty(error, "_tag") ? String(error._tag) : "UnknownError";
  if (Schema.is(Forbidden)(error) || Schema.is(Unauthenticated)(error)) {
    return { outcome: "denied", error: tag };
  }
  if (Schema.is(RateLimited)(error)) return { outcome: "rate_limited", error: tag };
  return { outcome: "failed", error: tag };
};

/**
 * Wraps every tool call in the same four steps, so no tool can skip one:
 *
 * 1. find the principal and check the tool's scope,
 * 2. take a token from the caller's rate limit for this tool,
 * 3. run the tool with a time limit,
 * 4. write the audit entry, whatever happened.
 *
 * Refusals are audited too. A log of only the calls that succeeded cannot answer
 * the question people bring to an audit log, which is whether someone tried
 * something they should not have.
 */
export class ToolGuard extends Context.Service<ToolGuard, ToolGuardService>()("ToolGuard") {
  static readonly layer: Layer.Layer<
    ToolGuard,
    never,
    AuditLog | RateLimiter.RateLimiter | ServerConfig
  > = Layer.effect(ToolGuard)(
    Effect.gen(function*() {
      const audit = yield* AuditLog;
      const limiter = yield* RateLimiter.RateLimiter;
      const config = yield* ServerConfig;

      const run = <A, E, R>(
        call: GuardedCall,
        use: (principal: Principal) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | GuardFailure, R> =>
        Effect.gen(function*() {
          const started = yield* Clock.currentTimeMillis;
          const principal = yield* CurrentPrincipal;
          const client = yield* Effect.serviceOption(McpSchema.McpServerClient);

          const guarded: Effect.Effect<A, E | GuardFailure, R> = Effect.gen(function*() {
            if (Option.isNone(principal)) return yield* new Unauthenticated({});
            if (!principal.value.hasScope(call.scope)) {
              return yield* new Forbidden({ tool: call.tool, scope: call.scope });
            }

            yield* limiter.consume({
              key: `tool:${principal.value.subject}:${call.tool}`,
              limit: config.rateLimit.limit,
              window: config.rateLimit.window,
              onExceeded: "fail",
            }).pipe(
              Effect.catchTag("RateLimiterError", (error) =>
                error.reason._tag === "RateLimitExceeded"
                  ? Effect.fail(
                    new RateLimited({
                      tool: call.tool,
                      retryAfterSeconds: Math.ceil(Duration.toSeconds(error.reason.retryAfter)),
                    }),
                  )
                  // The limit store is unreachable. Nothing the agent can do about
                  // that, so it is a defect: the call fails closed as an internal
                  // error, and the cause is reported rather than shown to the client.
                  : Effect.die(error)),
            );

            return yield* use(principal.value).pipe(
              Effect.timeoutOrElse({
                duration: config.toolTimeout,
                orElse: () =>
                  Effect.fail(
                    new ToolTimedOut({
                      tool: call.tool,
                      seconds: Duration.toSeconds(config.toolTimeout),
                    }),
                  ),
              }),
            );
          });

          return yield* guarded.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function*() {
                const finished = yield* Clock.currentTimeMillis;
                const { outcome, error } = outcomeOf(exit);
                yield* Effect.annotateCurrentSpan({ "mcp.tool.outcome": outcome });
                yield* audit.record({
                  subject: Option.match(principal, {
                    onNone: () => "anonymous",
                    onSome: (p) => p.subject,
                  }),
                  principalKind: Option.match(principal, {
                    onNone: () => "none",
                    onSome: (p) => p.kind,
                  }),
                  credentialId: Option.match(principal, {
                    onNone: () => "none",
                    onSome: (p) => p.credentialId,
                  }),
                  clientName: Option.match(client, {
                    onNone: () => null,
                    onSome: (c) => c.clientInfo.name,
                  }),
                  tool: call.tool,
                  arguments: call.arguments,
                  outcome,
                  error,
                  durationMs: finished - started,
                });
              })
            ),
          );
        }).pipe(
          Effect.withSpan(`tool ${call.tool}`, {
            attributes: { "mcp.tool.name": call.tool, "mcp.tool.scope": call.scope },
          }),
        );

      return { run };
    }),
  );
}
