import {
  BadRequestException,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import { COMMON_ERROR_CODES } from '@bilhanah/contracts';
import express, { type RequestHandler } from 'express';

/**
 * Turns an Express body-parser error (identified by its `type`) into an HTTP
 * exception with a standard code. Parser messages are not exposed.
 */
export function bodyParserException(error: unknown): unknown {
  const type = (error as { type?: unknown } | null)?.type;
  switch (type) {
    case 'entity.parse.failed':
      return new BadRequestException({
        code: COMMON_ERROR_CODES.VALIDATION_FAILED,
        message: 'The request body is not valid JSON.',
      });
    case 'entity.too.large':
      return new PayloadTooLargeException({
        code: COMMON_ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: 'The request body is too large.',
      });
    default:
      // Unsupported charset or encoding, aborted request, and similar.
      return typeof type === 'string'
        ? new HttpException('The request body could not be read.', HttpStatus.BAD_REQUEST)
        : error;
  }
}

/**
 * JSON body parser registered ahead of Nest's own, which keeps only the
 * parser's message and turns oversized bodies into 500s.
 */
export function jsonBody(limit = '100kb'): RequestHandler {
  const parse = express.json({
    limit,
    // External POS webhooks are verified against the exact bytes they were signed over.
    verify: (request, _response, buffer) => {
      if (request.url?.startsWith('/v1/public/pos/webhooks/')) (request as typeof request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  });
  return (request, response, next) =>
    parse(request, response, (error?: unknown) => next(error && bodyParserException(error)));
}
