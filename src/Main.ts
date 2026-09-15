import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the Node server needs a Node http server
import { createServer } from "node:http";
import { Routes, ServicesLive } from "./server/App.ts";
import { TelemetryLive } from "./server/Telemetry.ts";

const HttpLive = HttpRouter.serve(Routes).pipe(
  Layer.provide(ServicesLive),
  Layer.provide(
    NodeHttpServer.layerConfig(createServer, {
      port: Config.Port("PORT").pipe(Config.withDefault(3000)),
    }),
  ),
);

// Telemetry wraps the running program rather than sitting in the layer graph: a
// layer that nothing depends on is never built.
NodeRuntime.runMain(Layer.launch(HttpLive).pipe(Effect.provide(TelemetryLive)));
