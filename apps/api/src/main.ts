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
  app.enableCors({
    origin: [env.webUrl],
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
