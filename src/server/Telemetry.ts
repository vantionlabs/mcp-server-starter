// The subpath rather than the package index, which also loads the browser SDK.
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config, Effect, Option, Redacted } from "effect";

/**
 * Exports traces over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set: Grafana,
 * Honeycomb, Datadog, Langfuse, a local collector.
 *
 * Every tool call already runs in a span (see `ToolGuard`), as do auth checks,
 * database queries and outbound HTTP calls. This decides where those spans go.
 * With no endpoint the tracer is not installed, rather than retrying against
 * nothing and filling the log with connection errors.
 */
export const TelemetryLive = NodeSdk.layer(
  Effect.gen(function*() {
    const endpoint = yield* Config.option(Config.NonEmptyString("OTEL_EXPORTER_OTLP_ENDPOINT"));
    const serviceName = yield* Config.NonEmptyString("OTEL_SERVICE_NAME").pipe(
      Config.withDefault("mcp-server"),
    );
    /** Sent as the `Authorization` header, which is what hosted collectors expect. */
    const authorization = yield* Config.option(Config.Redacted("OTEL_EXPORTER_OTLP_AUTHORIZATION"));

    return {
      resource: { serviceName },
      ...(Option.isNone(endpoint) ? {} : {
        // Batched, so exporting never sits on the path of a tool call.
        spanProcessor: new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${endpoint.value.replace(/\/+$/, "")}/v1/traces`,
            ...(Option.isNone(authorization)
              ? {}
              : { headers: { authorization: Redacted.value(authorization.value) } }),
          }),
        ),
      }),
    };
  }),
);
