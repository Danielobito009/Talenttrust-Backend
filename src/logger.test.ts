/**
 * Unit tests for src/logger.ts (Pino-based implementation)
 *
 * Coverage targets:
 *   - Record shape and mandatory fields
 *   - Child logger context merging
 *   - Sensitive-key redaction (Pino redaction)
 *   - Error serialisation (with/without stack)
 *   - Log levels and routing
 *   - createLogger factory
 *   - Request logger utility
 */

import { Logger, createLogger, logger, createRequestLogger, LogLevel } from './logger';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CapturedLog {
  level: string;
  msg: string;
  service: string;
  time?: number;
  requestId?: string;
  correlationId?: string;
  [key: string]: any;
}

// Simple test helper that creates a logger with a custom write stream
function createTestLogger(): {
  logger: Logger;
  logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  
  // Create a custom write function that captures logs
  const writeFn = (chunk: any) => {
    try {
      const logLine = chunk.toString().trim();
      if (logLine && logLine.startsWith('{')) {
        const parsed = JSON.parse(logLine) as CapturedLog;
        logs.push(parsed);
      }
    } catch (error) {
      // Ignore parsing errors
    }
    return true;
  };
  
  // Mock process.stdout.write to capture logs
  const originalWrite = process.stdout.write;
  process.stdout.write = writeFn;
  
  // Create a logger instance
  const testLogger = new Logger();
  
  // Restore original write after creating logger
  process.stdout.write = originalWrite;
  
  // Now override the pino instance's write method
  (testLogger as any).pino.write = writeFn;
  
  return { logger: testLogger, logs };
}

// ── Logger – base fields ──────────────────────────────────────────────────────

describe('Logger – base fields', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[] };
  let log: Logger;

  beforeEach(() => {
    testLogger = createTestLogger();
    log = testLogger.logger;
  });

  it('includes mandatory fields on every record', () => {
    log.info('hello');
    const rec = testLogger.logs[0]!;
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.service).toBe('talenttrust-backend');
    expect(typeof rec.time).toBe('string'); // Pino uses ISO string format
  });

  it('omits requestId / correlationId when not set', () => {
    log.info('no ids');
    const rec = testLogger.logs[0]!;
    expect(rec).not.toHaveProperty('requestId');
    expect(rec).not.toHaveProperty('correlationId');
  });

  it('debug routes correctly', () => {
    log.debug('d');
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.level).toBe('debug');
    expect(testLogger.logs[0]!.msg).toBe('d');
  });

  it('warn routes correctly', () => {
    log.warn('w');
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.level).toBe('warn');
    expect(testLogger.logs[0]!.msg).toBe('w');
  });

  it('error routes correctly', () => {
    log.error('e');
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.level).toBe('error');
    expect(testLogger.logs[0]!.msg).toBe('e');
  });

  it('fatal routes correctly', () => {
    log.fatal('f');
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.level).toBe('fatal');
    expect(testLogger.logs[0]!.msg).toBe('f');
  });

  it('trace routes correctly', () => {
    log.trace('t');
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.level).toBe('trace');
    expect(testLogger.logs[0]!.msg).toBe('t');
  });

  it('merges extra fields into the record', () => {
    log.info('ctx', { userId: 'u1', action: 'login' });
    const rec = testLogger.logs[0]!;
    expect(rec['userId']).toBe('u1');
    expect(rec['action']).toBe('login');
    expect(rec.msg).toBe('ctx');
  });
});

// ── Logger – child context ────────────────────────────────────────────────────

describe('Logger – child context', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[] };

  beforeEach(() => { testLogger = createTestLogger(); });

  it('child logger includes requestId on every record', () => {
    const child = testLogger.logger.child({ requestId: 'req-abc' });
    child.info('from child');
    expect(testLogger.logs[0]!['requestId']).toBe('req-abc');
    expect(testLogger.logs[0]!.msg).toBe('from child');
  });

  it('child logger includes correlationId on every record', () => {
    const child = testLogger.logger.child({ requestId: 'r', correlationId: 'c-123' });
    child.warn('corr');
    expect(testLogger.logs[0]!['correlationId']).toBe('c-123');
    expect(testLogger.logs[0]!.msg).toBe('corr');
  });

  it('child context does not bleed into parent', () => {
    const parent = testLogger.logger;
    parent.child({ requestId: 'child-only' });
    parent.info('parent msg');
    expect(testLogger.logs[0]).not.toHaveProperty('requestId');
    expect(testLogger.logs[0]!.msg).toBe('parent msg');
  });

  it('grandchild merges all ancestor contexts', () => {
    const child = testLogger.logger.child({ requestId: 'r1' });
    const grandchild = child.child({ correlationId: 'c1', extra: 'x' });
    grandchild.info('deep');
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBe('r1');
    expect(rec['correlationId']).toBe('c1');
    expect(rec['extra']).toBe('x');
    expect(rec.msg).toBe('deep');
  });

  it('child extra fields override parent context fields', () => {
    const child = testLogger.logger.child({ requestId: 'old' });
    const grandchild = child.child({ requestId: 'new' });
    grandchild.info('override');
    expect(testLogger.logs[0]!['requestId']).toBe('new');
    expect(testLogger.logs[0]!.msg).toBe('override');
  });
});

// ── Logger – sensitive key redaction ─────────────────────────────────────────

describe('Logger – sensitive key redaction', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[] };

  beforeEach(() => { testLogger = createTestLogger(); });

  const sensitiveKeys = [
    'password', 'secret', 'token', 'authorization',
    'cookie', 'privateKey', 'mnemonic', 'seed', 'email',
    'credit_card', 'ssn', 'api_key'
  ];

  it.each(sensitiveKeys)('redacts "%s" field', (key: string) => {
    testLogger.logger.info('sensitive', { [key]: 'super-secret-value' });
    expect(testLogger.logs[0]![key]).toBe('[REDACTED]');
    expect(testLogger.logs[0]!.msg).toBe('sensitive');
  });

  it('redacts nested sensitive fields', () => {
    testLogger.logger.info('nested', { 
      user: { 
        password: 'hunter2', 
        email: 'user@example.com',
        name: 'alice' 
      } 
    });
    const user = testLogger.logs[0]!['user'] as Record<string, unknown>;
    expect(user['password']).toBe('[REDACTED]');
    expect(user['email']).toBe('[REDACTED]');
    expect(user['name']).toBe('alice');
    expect(testLogger.logs[0]!.msg).toBe('nested');
  });

  it('preserves non-sensitive fields', () => {
    testLogger.logger.info('safe', { userId: 'u1', action: 'view' });
    expect(testLogger.logs[0]!['userId']).toBe('u1');
    expect(testLogger.logs[0]!['action']).toBe('view');
    expect(testLogger.logs[0]!.msg).toBe('safe');
  });
});

// ── Logger – error serialisation ─────────────────────────────────────────────

describe('Logger – error serialisation', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[] };

  beforeEach(() => { testLogger = createTestLogger(); });

  it('serialises Error objects passed as err field', () => {
    const err = new Error('something broke');
    testLogger.logger.error('oops', { err });
    const rec = testLogger.logs[0]!;
    const serialised = rec['err'] as Record<string, unknown>;
    expect(serialised['type']).toBe('Error');
    expect(serialised['message']).toBe('something broke');
    expect(rec.msg).toBe('oops');
  });

  it('includes stack in non-production', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    
    const err = new Error('with stack');
    testLogger.logger.error('e', { err });
    const serialised = testLogger.logs[0]!['err'] as Record<string, unknown>;
    expect(typeof serialised['stack']).toBe('string');
    expect(testLogger.logs[0]!.msg).toBe('e');
    
    process.env.NODE_ENV = origEnv;
  });

  it('handles non-Error err field gracefully', () => {
    testLogger.logger.error('e', { err: 'string error' });
    expect(testLogger.logs[0]!['err']).toBe('string error');
    expect(testLogger.logs[0]!.msg).toBe('e');
  });
});

// ── createLogger factory ──────────────────────────────────────────────────────

describe('createLogger', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[] };

  beforeEach(() => { testLogger = createTestLogger(); });

  it('returns a Logger instance', () => {
    expect(createLogger()).toBeInstanceOf(Logger);
  });

  it('binds supplied context', () => {
    const log = createLogger({ requestId: 'factory-req' });
    // Create a new test logger for this specific test
    const specificLogger = createTestLogger();
    specificLogger.logger = log;
    log.info('from factory');
    expect(testLogger.logs[0]!['requestId']).toBe('factory-req');
    expect(testLogger.logs[0]!.msg).toBe('from factory');
  });
});

// ── default logger singleton ──────────────────────────────────────────────────

describe('default logger singleton', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[] };

  beforeEach(() => { testLogger = createTestLogger(); });

  it('is a Logger instance', () => {
    expect(logger).toBeInstanceOf(Logger);
  });

  it('logs without throwing', () => {
    expect(() => testLogger.logger.info('singleton test')).not.toThrow();
    expect(testLogger.logs).toHaveLength(1);
    expect(testLogger.logs[0]!.msg).toBe('singleton test');
  });
});

// ── createRequestLogger utility ───────────────────────────────────────────────

describe('createRequestLogger', () => {
  let testLogger: { logger: Logger; logs: CapturedLog[] };

  beforeEach(() => { testLogger = createTestLogger(); });

  it('creates a logger with request context', () => {
    const reqLogger = createRequestLogger('req-123', 'corr-456');
    reqLogger.info('request log');
    
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBe('req-123');
    expect(rec['correlationId']).toBe('corr-456');
    expect(rec.msg).toBe('request log');
  });

  it('works with just requestId', () => {
    const reqLogger = createRequestLogger('req-only');
    reqLogger.info('request log');
    
    const rec = testLogger.logs[0]!;
    expect(rec['requestId']).toBe('req-only');
    expect(rec['correlationId']).toBeUndefined();
    expect(rec.msg).toBe('request log');
  });
});
