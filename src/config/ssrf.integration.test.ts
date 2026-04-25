import { envSchema } from './env.schema';

describe('envSchema SSRF Protection', () => {
  it('should reject private URLs in API_BASE_URL', () => {
    const result = envSchema.safeParse({
      API_BASE_URL: 'http://localhost:3000'
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('SSRF protection');
    }
  });

  it('should reject private URLs in STELLAR_HORIZON_URL', () => {
    const result = envSchema.safeParse({
      STELLAR_HORIZON_URL: 'http://127.0.0.1:8000'
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toContain('SSRF protection');
    }
  });

  it('should allow public URLs', () => {
    const result = envSchema.safeParse({
      API_BASE_URL: 'https://api.talenttrust.io',
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org'
    });
    expect(result.success).toBe(true);
  });
});
