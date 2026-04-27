import { z } from 'zod';
import { registry } from '../../../docs/openapi-registry';

export const updateReputationSchema = z.object({
  reviewerId: z.string().min(1).openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
  rating: z.number().min(1).max(5).openapi({ example: 5 }),
  comment: z.string().optional().openapi({ example: 'Excellent freelancer!' }),
  jobCompleted: z.boolean().optional().openapi({ example: true }),
});

registry.register('UpdateReputation', updateReputationSchema);
