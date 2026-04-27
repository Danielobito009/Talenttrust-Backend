import { Request, Response, NextFunction } from 'express';
import { sanitizeErrorMessage, safeMessageForCode } from '../errors/safeErrors';

/**
 * @dev Global error handling middleware.
 * Ensures that unexpected errors never leak stack traces or internal
 * logic to the client in any environment.
 * 
 * @param err The error object.
 * @param req The Express Request.
 * @param res The Express Response.
 * @param next The Express NextFunction.
 */
export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  const statusCode = err.status || 500;

  // 500-level errors always get a generic message — the raw cause is internal.
  // Lower status codes use sanitized versions of the original message.
  const message = statusCode >= 500
    ? safeMessageForCode('internal_error')
    : sanitizeErrorMessage(err.message || 'An error occurred', 'bad_request');

  console.error(`[Error] ${statusCode}`, err.stack);

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message,
  });
};
