/**
 * Write the OpenAPI 3.1 document to a file, without serving it.
 *
 * S-9 withdrew the public /api/docs UI in production. The contract itself is
 * worth more than the UI was: CI emits it on every build and diffs it against
 * the committed copy, so a breaking change to a route shape is a review comment
 * rather than a support ticket.
 */
import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { AppModule } from "../src/app.module";
import { buildOpenApi } from "../src/main";

async function main() {
  const out = resolve(process.argv[2] ?? "openapi.json");
  const app = await NestFactory.create(AppModule, { logger: false });
  const doc = SwaggerModule.createDocument(app, buildOpenApi());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  await app.close();
  process.stdout.write(`OpenAPI written to ${out}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
