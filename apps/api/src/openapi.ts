import { DocumentBuilder } from "@nestjs/swagger";

/**
 * The OpenAPI 3.1 document builder.
 *
 * Its own module, because main.ts calls `bootstrap()` at the bottom of the
 * file: importing anything from there starts an HTTP listener and runs the
 * boot-time config gate. That is why `scripts/emit-openapi.ts` could never have
 * worked even with the ts-node it was missing, and why the contract spec could
 * not read the document.
 *
 * A helper that cannot be imported without a side effect is a helper nothing
 * will use.
 */
export function buildOpenApi() {
  return new DocumentBuilder()
    // 3.1.0, not the library default of 3.0.0. The file was titled "OpenAPI
    // 3.1" and emitted 3.0 -- a version claim nothing checked. 3.1 is the one
    // aligned with JSON Schema, so a generated client validates the same shapes
    // the API validates.
    .setOpenAPIVersion("3.1.0")
    .setTitle("GODEYE API")
    .setDescription("AI Marketing Operating System API")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
}
