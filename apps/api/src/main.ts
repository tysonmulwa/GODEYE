import "./common/env"; // must be first — loads the repo-root .env

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { env } from "./common/env";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true, // needed for webhook HMAC validation
  });

  app.use(helmet());
  app.use(cookieParser());
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
    origin: (origin, callback) => {
      // Same-origin and server-to-server calls send no Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        return callback(null, true);
      }
      // Name the rejected origin — a CORS failure in the browser never says why.
      corsLogger.warn(`Blocked origin: ${origin} (set WEB_URL to include it)`);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`), false);
    },
    credentials: true,
  });
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle("GODEYE API")
    .setDescription("AI Marketing Operating System — API")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swagger));

  // Bind 0.0.0.0, not localhost — a container host can't reach a loopback-only
  // listener, and the deploy gets killed as unhealthy.
  await app.listen(env.apiPort, "0.0.0.0");
  new Logger("Bootstrap").log(
    `GODEYE API listening on 0.0.0.0:${env.apiPort} (docs: /api/docs)`,
  );
}

bootstrap();
