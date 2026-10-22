import { HttpException } from '@nestjs/common';
import { toErrorBody } from '../filters/all-exceptions.filter.js';
import { bodyParserException } from './json-body.js';

const parserError = (type: string) => Object.assign(new Error('parser internals'), { type });

describe('bodyParserException', () => {
  it('reports unparseable JSON as a validation failure without parser internals', () => {
    expect(toErrorBody(bodyParserException(parserError('entity.parse.failed')))).toEqual({
      status: 400,
      error: { code: 'VALIDATION_FAILED', message: 'The request body is not valid JSON.' },
    });
  });

  it('reports oversized bodies as 413 instead of a server error', () => {
    expect(toErrorBody(bodyParserException(parserError('entity.too.large')))).toEqual({
      status: 413,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
    });
  });

  it('reports other unreadable bodies as 400', () => {
    const exception = bodyParserException(parserError('charset.unsupported'));
    expect(exception).toBeInstanceOf(HttpException);
    expect(toErrorBody(exception).status).toBe(400);
  });

  it('leaves unrelated errors alone', () => {
    const error = new Error('boom');
    expect(bodyParserException(error)).toBe(error);
  });
});
