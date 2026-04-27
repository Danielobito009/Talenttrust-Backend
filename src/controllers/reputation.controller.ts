import { Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { ForbiddenError, ConflictError, ValidationError, AppError } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';

/**
 * @title Reputation Controller
 * @dev Handles HTTP requests for the reputation system with proper error handling.
 */
export class ReputationController {
  /**
   * GET /api/v1/reputation/:id
   * Retrieve a freelancer's reputation profile.
   */
  public static async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const profile = ReputationService.getProfile(id);
      res.status(200).json({ status: 'success', data: profile });
    } catch (error) {
      handleControllerError(error, res);
    }
  }

  /**
   * POST /api/v1/reputation/:id/rate
   * Create a new reputation rating for a freelancer.
   */
  public static async createRating(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const targetId = req.params.id;
      const { reviewerId, rating, comment, contextId } = req.body;

      // Ensure reviewer is the authenticated user
      const authenticatedUserId = req.user?.userId;
      if (!authenticatedUserId) {
        res.status(401).json({ status: 'error', message: 'Authentication required' });
        return;
      }

      if (reviewerId !== authenticatedUserId) {
        throw new ForbiddenError('Cannot rate on behalf of another user');
      }

      const entry = ReputationService.createRating(
        reviewerId,
        targetId,
        rating,
        contextId,
        comment
      );

      res.status(201).json({ status: 'success', data: entry });
    } catch (error) {
      handleControllerError(error, res);
    }
  }
}

/**
 * Centralized error handler for controller methods.
 */
function handleControllerError(error: unknown, res: Response): void {
  if (error instanceof ValidationError) {
    res.status(422).json({ status: 'error', message: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ status: 'error', message: error.message });
  } else if (error instanceof ConflictError) {
    res.status(409).json({ status: 'error', message: error.message });
  } else if (error instanceof AppError) {
    res.status(error.statusCode).json({ status: 'error', message: error.message });
  } else {
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
}
