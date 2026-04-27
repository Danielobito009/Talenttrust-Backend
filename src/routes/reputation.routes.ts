import { Router } from 'express';
import { ReputationController } from '../controllers/reputation.controller';
import { registry } from '../docs/openapi-registry';
import { updateReputationSchema } from '../modules/reputation/dto/reputation.dto';
import { validateSchema } from '../middleware/validate.middleware';
import { z } from 'zod';

const router = Router();

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
                  rating: { type: 'number' },
                  reviewCount: { type: 'number' }
                }
              }
            }
          }
        }
      }
    }
  }
});

// GET /api/v1/reputation/:id - Retrieve reputation for a freelancer
router.get('/:id', ReputationController.getProfile);

registry.registerPath({
  method: 'put',
  path: '/reputation/{id}',
  summary: 'Update freelancer reputation',
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
    200: {
      description: 'Updated reputation profile',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' }
            }
          }
        }
      }
    }
  }
});

// PUT /api/v1/reputation/:id - Update reputation for a freelancer (add review)
router.put(
  '/:id', 
  validateSchema(z.object({ body: updateReputationSchema, params: z.object({ id: z.string().min(1) }) })),
  ReputationController.updateProfile
);

export default router;
