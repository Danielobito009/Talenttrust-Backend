import request from 'supertest';
import express from 'express';
import { errorHandler, notFoundHandler } from './errorHandler';
import { UnauthorizedError } from '../errors/appError';

const app = express();

app.get('/error', (req, res, next) => next(new UnauthorizedError('Stop!')));
app.get('/generic', (req, res, next) => next(new Error('Boom')));
app.get('/empty-msg', (req, res, next) => {
  const err = new Error();
  err.message = '';
  next(err);
});

app.use(notFoundHandler);
app.use(errorHandler);

describe('Error Handler Middleware', () => {
  it('handles AppError correctly', async () => {
    const res = await request(app).get('/error');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('handles generic Error as 500 with safe code', async () => {
    const res = await request(app).get('/generic');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });

  it('uses safe fallback for empty error messages', async () => {
    const res = await request(app).get('/empty-msg');
    expect(res.body.error.message).toBe('An unexpected error occurred');
  });

  it('triggers 404 handler', async () => {
    const res = await request(app).get('/no-where');
    expect(res.status).toBe(404);
  });

  it('never includes stack trace regardless of NODE_ENV', async () => {
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const res = await request(app).get('/error');
    expect(res.body.error).not.toHaveProperty('stack');
    process.env.NODE_ENV = oldEnv;
  });
});