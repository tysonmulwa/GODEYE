import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { ZodType, ZodTypeDef } from "zod";

@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  // 3-param ZodType so schemas whose input differs from output (defaults, transforms) fit
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Validation failed",
        errors: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}
