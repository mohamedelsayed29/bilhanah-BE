import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export type ErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

function statusCode(status: number): string {
  return HttpStatus[status] ?? 'ERROR';
}

export function toErrorBody(exception: unknown): { status: number; error: ErrorBody } {
  if (!(exception instanceof HttpException)) {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' },
    };
  }

  const status = exception.getStatus();
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return { status, error: { code: statusCode(status), message: response } };
  }

  const { code, message, details } = response as Partial<ErrorBody> & { message?: unknown };
  return {
    status,
    error: {
      code: typeof code === 'string' ? code : statusCode(status),
      // Nest's built-in exceptions put validation messages in an array.
      message: typeof message === 'string' ? message : exception.message,
      ...(details !== undefined && { details }),
      ...(Array.isArray(message) && details === undefined && { details: message }),
    },
  };
}

/** Renders every HTTP error as `{ error: { code, message, details?, requestId } }`. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    const { status, error } = toErrorBody(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception);
    }

    response.status(status).json({ error: { ...error, requestId: request.id } });
  }
}
