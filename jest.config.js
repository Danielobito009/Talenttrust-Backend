/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  setupFiles: ['<rootDir>/src/test-setup.ts'],
  ...(process.env.CI
    ? {}
    : {
        // Skip BullMQ when no Redis; long load tests (optional locally). CI runs the full set with Redis.
        testPathIgnorePatterns: [
          '/node_modules/',
          'queue-manager.test.ts',
          'api/jobs.test',
          'tests/load',
          'tests/stress',
        ],
      }),
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/index.ts', // entry point — not unit-testable (binds port)
    '!src/tests/load/**',
    '!src/tests/stress/**',
    '!src/deploy.ts',
    '!src/server.ts',
    '!src/queue/index.ts',
    '!src/services/soroban/index.ts',
    '!src/observability/index.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 87,
      statements: 87,
      functions: 87,
      branches: 80,
    },
  },
  coverageReporters: ['text', 'lcov', 'json-summary'],
};
