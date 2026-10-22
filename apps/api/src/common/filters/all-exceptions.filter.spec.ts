import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@bilhanah/database';
import { toErrorBody } from './all-exceptions.filter.js';

describe('toErrorBody', () => {
  it('hides details of unexpected errors', () => {
    expect(toErrorBody(new Error('database password leaked'))).toEqual({
      status: 500,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' },
    });
  });

  it('derives the code from the status of built-in exceptions', () => {
    expect(toErrorBody(new NotFoundException('Restaurant not found'))).toEqual({
      status: 404,
      error: { code: 'NOT_FOUND', message: 'Restaurant not found' },
    });
  });

  it('keeps explicit codes and details', () => {
    const exception = new BadRequestException({
      code: 'SUBDOMAIN_TAKEN',
      message: 'This subdomain is already registered.',
      details: { subdomain: 'koshary' },
    });
    expect(toErrorBody(exception)).toEqual({
      status: 400,
      error: {
        code: 'SUBDOMAIN_TAKEN',
        message: 'This subdomain is already registered.',
        details: { subdomain: 'koshary' },
      },
    });
  });

  it('maps a missing required record to 404', () => {
    const missing = new Prisma.PrismaClientKnownRequestError('No record found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    expect(toErrorBody(missing).status).toBe(404);
    expect(toErrorBody(missing).error.code).toBe('NOT_FOUND');
  });
});
