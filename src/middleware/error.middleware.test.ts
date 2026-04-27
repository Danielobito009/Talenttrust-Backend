import { Request, Response, NextFunction } from 'express';
import { errorHandler } from './error.middleware';

describe('Error Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {};
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
    // Suppress console.error in tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should handle standard 500 error with safe message', () => {
    const err = new Error('Sensitive DB connection string exposed');
    errorHandler(err, mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith({
      status: 'error',
      statusCode: 500,
      message: 'An unexpected error occurred',
    });
  });

  it('should handle custom error status with safe message', () => {
    const err: any = new Error('Not found');
    err.status = 404;
    errorHandler(err, mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(404);
    expect(mockResponse.json).toHaveBeenCalledWith({
      status: 'error',
      statusCode: 404,
      message: 'Not found',
    });
  });

  it('should obscure 500 errors in all environments', () => {
    const err = new Error('Sensitive DB Error');
    errorHandler(err, mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith({
      status: 'error',
      statusCode: 500,
      message: 'An unexpected error occurred',
    });
  });
});
