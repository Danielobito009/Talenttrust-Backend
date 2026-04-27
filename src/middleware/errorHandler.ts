import { Request, Response, NextFunction } from 'express';
import { AppError, NotFoundError } from '../errors/appError';
import { safeMessageForCode, sanitizeErrorMessage } from '../errors/safeErrors';

interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export function errorHandler(
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const code = err instanceof AppError ? err.code : 'internal_error';
  const rawMessage = err.message || safeMessageForCode(code);
  const message = err instanceof AppError
    ? sanitizeErrorMessage(rawMessage, code)
    : safeMessageForCode('internal_error');

  const body: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
    },
  };

  res.status(statusCode).json(body);
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError('The requested resource was not found'));
}