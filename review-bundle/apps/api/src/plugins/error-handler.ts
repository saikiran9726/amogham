import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ErrorCodes } from '@restaurant-os/shared';

/**
 * Detects whether an error represents a database outage or transient connection failure.
 */
export function isDatabaseOutageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, unknown>;
  const code = String(err.code || '');
  const message = String(err.message || '').toLowerCase();

  const outageCodes = [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'ENOTFOUND',
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '53300', // too_many_connections
  ];

  if (outageCodes.includes(code)) return true;

  if (
    message.includes('connection terminated') ||
    message.includes('connection lost') ||
    message.includes('econnrefused') ||
    message.includes('connection timeout') ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('remaining connection slots are reserved') ||
    message.includes('too many clients already') ||
    message.includes('max_connections') ||
    message.includes('pool is drained') ||
    message.includes('client has been closed')
  ) {
    return true;
  }

  return false;
}

/**
 * Detects whether an error contains internal database query or schema details.
 */
export function isDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, unknown>;
  const message = String(err.message || '').toLowerCase();
  const name = String(err.name || '').toLowerCase();
  const code = String(err.code || '');

  return (
    name.includes('postgres') ||
    name.includes('drizzle') ||
    message.includes('select ') ||
    message.includes('update ') ||
    message.includes('insert ') ||
    message.includes('delete ') ||
    message.includes('relation ') ||
    message.includes('column ') ||
    code.startsWith('23') ||
    code.startsWith('42') ||
    code.startsWith('08') ||
    code.startsWith('57')
  );
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (
      error: FastifyError | AppError | ZodError | Error,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const requestId = request.id;

      // 1. Zod Validation Errors -> 400
      if (error instanceof ZodError) {
        request.log.warn({ err: error, requestId }, 'Zod validation error');
        return reply.status(400).send({
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Validation failed',
            requestId,
            details: error.flatten(),
          },
        });
      }

      // 2. Database Outage / Transient Connection Failure -> 503 with Retry-After
      if (isDatabaseOutageError(error) || (error instanceof AppError && error.statusCode === 503)) {
        request.log.error({ err: error, requestId }, 'Database service outage detected');
        reply.header('Retry-After', '5');
        return reply.status(503).send({
          error: {
            code: ErrorCodes.SERVICE_UNAVAILABLE,
            message: 'Database service temporarily unavailable. Please retry shortly.',
            requestId,
          },
        });
      }

      // 3. Custom Domain AppError
      if (error instanceof AppError) {
        request.log.warn({ err: error, requestId }, `AppError: ${error.message}`);
        const message =
          error.statusCode >= 500 && (process.env.NODE_ENV !== 'test' || isDatabaseError(error))
            ? 'Internal server error'
            : error.message;

        return reply.status(error.statusCode).send({
          error: {
            code: error.code,
            message,
            requestId,
            ...(error.details ? { details: error.details } : {}),
          },
        });
      }

      // 4. Fastify Validation Errors
      const fastifyErr = error as FastifyError;
      if (fastifyErr.validation) {
        request.log.warn({ err: fastifyErr, requestId }, 'Fastify schema validation error');
        return reply.status(400).send({
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: fastifyErr.message || 'Validation error',
            requestId,
            details: fastifyErr.validation,
          },
        });
      }

      // 5. Accurate Status Code Mapping for non-AppError (400, 413, 415, 429)
      if (fastifyErr.statusCode === 429) {
        return reply.status(429).send({
          error: {
            code: ErrorCodes.RATE_LIMIT_EXCEEDED,
            message: fastifyErr.message || 'Rate limit exceeded',
            requestId,
          },
        });
      }

      if (fastifyErr.statusCode === 413) {
        return reply.status(413).send({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: fastifyErr.message || 'Payload too large',
            requestId,
          },
        });
      }

      if (fastifyErr.statusCode === 415) {
        return reply.status(415).send({
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: fastifyErr.message || 'Unsupported media type',
            requestId,
          },
        });
      }

      if (fastifyErr.statusCode === 400) {
        return reply.status(400).send({
          error: {
            code: ErrorCodes.BAD_REQUEST,
            message: fastifyErr.message || 'Bad request',
            requestId,
          },
        });
      }

      // 6. Unhandled / Internal Server Error (500)
      const statusCode =
        fastifyErr.statusCode && fastifyErr.statusCode >= 400 ? fastifyErr.statusCode : 500;
      request.log.error({ err: error, requestId }, 'Unhandled exception');

      const message =
        statusCode >= 500 && (process.env.NODE_ENV !== 'test' || isDatabaseError(error))
          ? 'Internal server error'
          : error.message || 'Internal server error';

      return reply.status(statusCode).send({
        error: {
          code: statusCode >= 500 ? ErrorCodes.INTERNAL_SERVER_ERROR : ErrorCodes.BAD_REQUEST,
          message,
          requestId,
        },
      });
    },
  );

  // Uniform 404 Not Found response structure
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: ErrorCodes.NOT_FOUND,
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    });
  });
}
