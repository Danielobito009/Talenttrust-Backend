/**
 * Reputation Service Tests
 * 
 * Comprehensive test suite for reputation score aggregation logic,
 * including the recency-weighted exponential decay algorithm.
 */

import {
  computeWeightedReputationScore,
  ReputationService
} from './reputation.service';
import { ReputationRepository } from '../repositories/reputationRepository';

// Mock the audit service to avoid side effects
jest.mock('../audit/service', () => ({
  auditService: {
    log: jest.fn()
  }
}));

/**
 * Creates a fixed timestamp for deterministic testing.
 * @returns ISO 8601 timestamp string
 */
function createFixedTimestamp(daysOffset: number, baseDate: Date): string {
  const date = new Date(baseDate.getTime());
  date.setDate(date.getDate() - daysOffset);
  return date.toISOString();
}

describe('computeWeightedReputationScore', () => {
  const now = new Date('2024-01-15T00:00:00.000Z');
  const lambda = 0.005; // Default decay constant

  it('returns 0 for empty ratings array', () => {
    const result = computeWeightedReputationScore([], now, lambda);
    expect(result).toBe(0);
  });

  it('returns the rating value for single rating (age = 0)', () => {
    const rating = {
      rating: 5,
      createdAt: now.toISOString()
    };
    const result = computeWeightedReputationScore([rating], now, lambda);
    expect(result).toBe(5);
  });

  it('returns the rating value for single rating (old age)', () => {
    const rating = {
      rating: 3,
      createdAt: createFixedTimestamp(365, now)
    };
    const result = computeWeightedReputationScore([rating], now, lambda);
    expect(result).toBe(3);
  });

  it('returns common value for two equal ratings with different ages', () => {
    const ratings = [
      { rating: 4, createdAt: createFixedTimestamp(0, now) },
      { rating: 4, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBe(4);
  });

  it('biases score toward newer higher rating', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) }, // New 5
      { rating: 1, createdAt: createFixedTimestamp(1000, now) } // Very old 1
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(3); // Should be closer to 5 than 1
    expect(result).toBeLessThanOrEqual(5);
  });

  it('biases score toward newer lower rating', () => {
    const ratings = [
      { rating: 1, createdAt: createFixedTimestamp(0, now) }, // New 1
      { rating: 5, createdAt: createFixedTimestamp(1000, now) } // Very old 5
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeLessThan(3); // Should be closer to 1 than 5
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it('score remains within input range [1, 5] for all inputs', () => {
    const ratings = [
      { rating: 1, createdAt: createFixedTimestamp(0, now) },
      { rating: 5, createdAt: createFixedTimestamp(100, now) },
      { rating: 3, createdAt: createFixedTimestamp(200, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('higher lambda decays faster', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) }, // New 5
      { rating: 1, createdAt: createFixedTimestamp(100, now) } // Old 1
    ];
    const resultSlow = computeWeightedReputationScore(ratings, now, 0.001);
    const resultFast = computeWeightedReputationScore(ratings, now, 0.01);
    // Fast decay should be closer to 5 (new rating) than slow decay
    expect(resultFast).toBeGreaterThan(resultSlow);
  });

  it('is deterministic with identical inputs', () => {
    const ratings = [
      { rating: 4, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(50, now) },
      { rating: 5, createdAt: createFixedTimestamp(100, now) }
    ];
    const result1 = computeWeightedReputationScore(ratings, now, lambda);
    const result2 = computeWeightedReputationScore(ratings, now, lambda);
    expect(result1).toEqual(result2);
  });

  it('order of inputs does not change result', () => {
    const ratings1 = [
      { rating: 2, createdAt: createFixedTimestamp(10, now) },
      { rating: 5, createdAt: createFixedTimestamp(0, now) }
    ];
    const ratings2 = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 2, createdAt: createFixedTimestamp(10, now) }
    ];
    const result1 = computeWeightedReputationScore(ratings1, now, lambda);
    const result2 = computeWeightedReputationScore(ratings2, now, lambda);
    expect(result1).toEqual(result2);
  });

  it('handles future timestamps (clock skew) gracefully', () => {
    const futureDate = new Date(now.getTime());
    futureDate.setDate(futureDate.getDate() + 10); // 10 days in future
    const ratings = [
      { rating: 5, createdAt: futureDate.toISOString() },
      { rating: 3, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThanOrEqual(3);
    expect(result).toBeLessThanOrEqual(5);
    // Future rating should be treated as age 0
  });

  it('has stable rounding to 2 decimal places', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Round to 2 decimals and check it's stable
    const rounded = parseFloat(result.toFixed(2));
    expect(rounded).toBeGreaterThanOrEqual(3);
    expect(rounded).toBeLessThanOrEqual(5);
    // Rounding should not introduce instability
    const result2 = computeWeightedReputationScore(ratings, now, lambda);
    expect(parseFloat(result2.toFixed(2))).toEqual(rounded);
  });
});

describe('ReputationService.getProfile', () => {
  const mockFindByTargetId = jest.fn();
  const mockDb = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock the repository
    (ReputationRepository as jest.Mock) = jest.fn().mockImplementation(() => ({
      findByTargetId: mockFindByTargetId
    }));
    ReputationService.initialize(mockDb);
  });

  it('returns 0 weightedScore for empty ratings', () => {
    mockFindByTargetId.mockReturnValue([]);
    const profile = ReputationService.getProfile('test-id');
    expect(profile.weightedScore).toBe(0);
    expect(profile.score).toBe(0);
  });

  it('includes weightedScore and scoreAlgorithm in response', () => {
    const now = new Date();
    const ratings = [
      {
        id: '1',
        reviewerId: 'reviewer1',
        targetId: 'test-id',
        rating: 5,
        contextId: 'ctx1',
        createdAt: now.toISOString()
      }
    ];
    mockFindByTargetId.mockReturnValue(ratings);
    const profile = ReputationService.getProfile('test-id');
    expect(profile.weightedScore).toBeDefined();
    expect(profile.scoreAlgorithm).toBeDefined();
    expect(typeof profile.weightedScore).toBe('number');
    expect(typeof profile.scoreAlgorithm).toBe('string');
  });

  it('preserves all existing fields', () => {
    const now = new Date();
    const ratings = [
      {
        id: '1',
        reviewerId: 'reviewer1',
        targetId: 'test-id',
        rating: 4,
        comment: 'Great work!',
        contextId: 'ctx1',
        createdAt: now.toISOString()
      }
    ];
    mockFindByTargetId.mockReturnValue(ratings);
    const profile = ReputationService.getProfile('test-id');
    expect(profile.freelancerId).toBe('test-id');
    expect(profile.score).toBeDefined();
    expect(profile.totalRatings).toBe(1);
    expect(profile.reviews).toHaveLength(1);
    expect(profile.lastUpdated).toBeDefined();
  });

  it('computes correct arithmetic mean for score field', () => {
    const ratings = [
      { id: '1', reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() },
      { id: '2', reviewerId: 'r2', targetId: 't1', rating: 3, contextId: 'c2', createdAt: new Date().toISOString() },
      { id: '3', reviewerId: 'r3', targetId: 't1', rating: 4, contextId: 'c3', createdAt: new Date().toISOString() }
    ];
    mockFindByTargetId.mockReturnValue(ratings);
    const profile = ReputationService.getProfile('t1');
    // Arithmetic mean should be (5+3+4)/3 = 4.0
    expect(profile.score).toBe(4.00);
  });

  it('rounds score and weightedScore to 2 decimal places', () => {
    const ratings = [
      { id: '1', reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() },
      { id: '2', reviewerId: 'r2', targetId: 't1', rating: 4, contextId: 'c2', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 100).toISOString() }
    ];
    mockFindByTargetId.mockReturnValue(ratings);
    const profile = ReputationService.getProfile('t1');
    // Check that scores are rounded to 2 decimals
    expect(profile.score.toString()).toMatch(/^\d+\.\d{2}$/);
    expect(profile.weightedScore.toString()).toMatch(/^\d+\.\d{2}$/);
  });
});
