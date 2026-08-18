import "./common/env"; // must be first, loads the repo-root .env

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { env } from "./common/env";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // needed for webhook HMAC validation
  });

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
  });

  // Photo uploads are posted as base64 JSON, which the default ~100kb body limit
  // rejects with "request entity too large". Base64 inflates bytes by ~33%, so
  // 30mb covers the 25 MB file cap enforced in the upload schema and the engine.
  app.useBodyParser("json", { limit: "30mb" });
  app.useBodyParser("urlencoded", { limit: "30mb", extended: true });

  app.use(helmet());
  app.use(cookieParser());
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle("GODEYE API")
    .setDescription("AI Marketing Operating System API")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swagger));

  // Bind 0.0.0.0, not localhost, a container host can't reach a loopback-only
  // listener, and the deploy gets killed as unhealthy.
  await app.listen(env.apiPort, "0.0.0.0");
  new Logger("Bootstrap").log(
    `GODEYE API listening on 0.0.0.0:${env.apiPort} (docs: /api/docs)`,
  );
}

bootstrap();
