import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const pipe = new ZodValidationPipe(z.object({ name: z.string().min(2), tables: z.coerce.number() }));

describe('ZodValidationPipe', () => {
  it('returns parsed output', () => {
    expect(pipe.transform({ name: 'Koshary', tables: '12' })).toEqual({
      name: 'Koshary',
      tables: 12,
    });
  });

  it('reports each invalid field', () => {
    try {
      pipe.transform({ name: 'K' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as { code: string; details: { path: string }[] };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details.map((issue) => issue.path)).toEqual(['name', 'tables']);
    }
  });
});
