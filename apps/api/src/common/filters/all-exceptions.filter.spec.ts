import { BadRequestException, NotFoundException } from '@nestjs/common';
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
});
