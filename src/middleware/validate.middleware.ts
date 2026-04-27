import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny, ZodError } from 'zod';

export interface ValidationErrorDetail {
  path: string[];
  message: string;
  code: string;
}

export interface ValidationErrorResponse {
  status: 'error';
  code: string;
  message: string;
  details: ValidationErrorDetail[];
}

const mapZodErrorToDetails = (error: ZodError): ValidationErrorDetail[] => {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)),
    message: issue.message,
    code: issue.code,
  }));
};

export const validateSchema = (schema: ZodTypeAny) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const response: ValidationErrorResponse = {
          status: 'error',
          code: 'validation_error',
          message: 'Validation failed',
          details: mapZodErrorToDetails(error),
        };
        return res.status(400).json(response);
      }
      next(error);
    }
  };
};
