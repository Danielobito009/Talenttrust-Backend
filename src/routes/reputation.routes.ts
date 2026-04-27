import { Router } from 'express';
import { ReputationController } from '../controllers/reputation.controller';
import { registry } from '../docs/openapi-registry';
import { updateReputationSchema } from '../modules/reputation/dto/reputation.dto';
import { validateSchema } from '../middleware/validate.middleware';
import { z } from 'zod';
import { authenticateMiddleware } from '../auth/authenticate';
import { requirePermission } from '../auth/middleware';

const router = Router();

/**
 * GET /api/v1/reputation/:id
 * Retrieve a freelancer's reputation profile.
 */
registry.registerPath({
  method: 'get',
  path: '/reputation/{id}',
  summary: 'Get freelancer reputation',
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' }
    }
  ],
  responses: {
    200: {
      description: 'Freelancer reputation profile',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' },
              data: {
                type: 'object',
                properties: {
                  freelancerId: { type: 'string' },
                  score: { type: 'number' },
                  totalRatings: { type: 'number' },
                  reviews: { type: 'array' }
                }
              }
            }
          }
        }
      }
    }
  }
});

router.get('/:id', ReputationController.getProfile);

/**
 * POST /api/v1/reputation/:id/rate
 * Create a new reputation rating. Requires authentication.
 */
registry.registerPath({
  method: 'post',
  path: '/reputation/{id}/rate',
  summary: 'Create reputation rating',
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' }
    }
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/UpdateReputation' }
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Rating created successfully',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' },
              data: { type: 'object' }
            }
          }
        }
      }
    },
    400: { description: 'Invalid payload' },
    403: { description: 'Forbidden - self-rating or unauthorized' },
    409: { description: 'Conflict - duplicate rating' },
    422: { description: 'Validation error' }
  }
});

router.post(
  '/:id/rate',
  authenticateMiddleware,
  requirePermission('reputation', 'update'),
  validateSchema(z.object({ 
    body: updateReputationSchema, 
    params: z.object({ id: z.string().uuid() }) 
  })),
  ReputationController.createRating
);

export default router;
