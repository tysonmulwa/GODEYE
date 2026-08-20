// Telemetry FIRST, before anything requires http, express or ioredis.
// Auto-instrumentation patches those modules as they are required; anything
// loaded ahead of the SDK is never instrumented, silently, and the traces just
// have holes in them.
import "./common/telemetry";
import "./common/env"; // loads the repo-root .env

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { env, validateConfig } from "./common/env";
import { ErrorsFilter } from "./common/errors.filter";
import { StructuredLogger } from "./common/logger";

/** The OpenAPI 3.1 document. Exported so CI can emit it without booting a server. */
export function buildOpenApi() {
  return new DocumentBuilder()
    .setTitle("GODEYE API")
    .setDescription("AI Marketing Operating System API")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
}

async function bootstrap() {
  // Before Nest builds anything. A secret that is missing, published in this
  // repository, or format-valid but entropy-free must fail the boot — not the
  // one request, hours later, that happened to be the first to need it.
  validateConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // needed for webhook HMAC validation
    // JSON lines with the trace id on every one, and PII redacted before it is
    // written rather than masked after (row 4).
    bufferLogs: true,
  });
  app.useLogger(app.get(StructuredLogger));

  // One error shape for the whole API (RFC 9457), and the place unhandled
  // exceptions are recorded onto their span.
  app.useGlobalFilters(new ErrorsFilter());

  // Before any guard runs, and before CORS: with this off — which it was —
  // req.ips is empty and req.ip is Railway's edge proxy, so every rate-limit
  // bucket in the system was one bucket for the whole internet, and every IP in
  // the audit trail was the proxy's (S-4).
  //
  // A hop count, never `true`: `trust proxy: true` lets a client forge
  // X-Forwarded-For and hand itself a fresh bucket per request (CWE-348).
  app.set("trust proxy", env.trustProxyHops);
  new Logger("Bootstrap").log(`trust proxy: ${env.trustProxyHops} hop(s)`);

  // CORS first, before anything that can reject a request.
  //
  // This used to sit after the body parsers, and that ordering hid a real bug
  // for weeks. A malformed JSON body is rejected by the parser itself, which
  // returns 400 before any CORS header has been attached, and a response
  // without Access-Control-Allow-Origin is the one thing a browser refuses to
  // show you, so the console said "blocked by CORS policy" while the server
  // had actually said "that is not valid JSON". The same masking applied to
  // every oversized upload: "request entity too large" reached the browser as
  // a CORS failure too. Registered first, the headers are on the response
  // whatever happens afterwards, and the error can speak for itself.
  //
  // WEB_URL accepts a comma-separated list so a rename or a preview deployment
  // can be allowed without a code change. Kept to an explicit allow-list on
  // purpose: with credentials:true a wildcard would let any site on that domain
  // make authenticated requests with a user's cookies.
  const allowedOrigins = env.webUrl
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const corsLogger = new Logger("Cors");
  corsLogger.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Same-origin and server-to-server calls send no Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        return callback(null, true);
      }
      // Name the rejected origin, a CORS failure in the browser never says why.
      corsLogger.warn(`Blocked origin: ${origin} (set WEB_URL to include it)`);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`), false);
    },
    credentials: true,
    // Stated rather than reflected. The `cors` package defaults to echoing back
    // whatever Access-Control-Request-Headers asks for, which works and hides
    // what the API actually accepts. `traceparent` is on the list because the
    // browser sends one on every call (rubric row 4) and it is NOT a
    // CORS-safelisted header, so without it every cross-origin request fails
    // preflight — and the browser reports that as a generic CORS error.
    allowedHeaders: ["Content-Type", "Authorization", "traceparent", "tracestate"],
    // So a client can read its rate-limit budget and its trace id back.
    exposedHeaders: [
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "Retry-After",
    ],
  });

  // Photo uploads are posted as base64 JSON, which the default ~100kb body limit
  // rejects with "request entity too large". Base64 inflates bytes by ~33%, so
  // 30mb covers the 25 MB file cap enforced in the upload schema and the engine.
  app.useBodyParser("json", { limit: "30mb" });
  app.useBodyParser("urlencoded", { limit: "30mb", extended: true });

  app.use(helmet());
  app.use(cookieParser());
  app.enableShutdownHooks();

  // /api/docs is a reconnaissance map: every route, every DTO shape, and the
  // @ApiOperation text describing what each one does. It made S-1 — five
  // controllers with no RolesGuard — discoverable in a single request.
  //
  // The *contract* is still valuable, so it is still generated: `pnpm openapi`
  // writes the same document to a file for CI to diff. Only the public UI is
  // withdrawn. Set ENABLE_API_DOCS=true to mount it somewhere non-production
  // deliberately (a staging box behind auth), never as a default.
  const docsEnabled = env.nodeEnv !== "production" || process.env.ENABLE_API_DOCS === "true";
  if (docsEnabled) {
    SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, buildOpenApi()));
  } else {
    new Logger("Swagger").log("API docs disabled in production (set ENABLE_API_DOCS=true to mount)");
  }

  // Bind 0.0.0.0, not localhost, a container host can't reach a loopback-only
  // listener, and the deploy gets killed as unhealthy.
  await app.listen(env.apiPort, "0.0.0.0");
  new Logger("Bootstrap").log(
    `GODEYE API listening on 0.0.0.0:${env.apiPort} (docs: /api/docs)`,
  );
}

bootstrap();
