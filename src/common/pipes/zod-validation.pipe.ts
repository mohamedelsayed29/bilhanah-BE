import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates a request part against a shared contract schema.
 * Usage: `@Body(new ZodValidationPipe(createRestaurantSchema)) body: CreateRestaurant`.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'The request contains invalid fields.',
        details: result.error.issues.map((issue) => {
          // Custom rules may attach a machine-readable reason (e.g. RESERVED).
          const reason = issue.code === 'custom' ? issue.params?.['reason'] : undefined;
          return {
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
            ...(typeof reason === 'string' && { reason }),
          };
        }),
      });
    }
    return result.data;
  }
}
