import { Request, Response, NextFunction } from 'express';
import { ContractsService } from '../services/contracts.service';
import { CreateContractDto } from '../modules/contracts/dto/contract.dto';
import { parseLimit, decodeCursor } from '../contracts/cursor.repository';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';

const contractsService = new ContractsService();

/**
 * @dev Presentation layer for Contracts.
 * Handles HTTP requests, extracts parameters, and formulates responses.
 * Delegates core logic to the ContractsService.
 */
export class ContractsController {

  /**
   * GET /api/v1/contracts
   *
   * Supports two pagination modes — both are optional and backward-compatible:
   *
   * **Cursor mode** (preferred, O(log n)):
   *   - `?limit=<n>`  — page size, 1–100 (default 20)
   *   - `?cursor=<s>` — opaque cursor from the previous page's `nextCursor`
   *
   * **Legacy offset mode** (still accepted for backward compatibility):
   *   - `?page=<n>&limit=<n>` — the previous in-memory slice behaviour
   *
   * When `cursor` is present the cursor path is used; otherwise the legacy
   * path is used so existing callers are unaffected.
   *
   * @param req - Express request.  Query params: `limit`, `cursor`.
   * @param res - Express response.
   * @param next - Express next-error handler.
   */
  public static async getContracts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Validate limit and cursor up-front so we return 400 before hitting the DB
      let limit: number;
      try {
        limit = parseLimit(req.query['limit']);
      } catch (err) {
        res.status(400).json({
          status: 'error',
          message: (err as Error).message,
        });
        return;
      }

      const rawCursor = req.query['cursor'];
      if (rawCursor !== undefined && typeof rawCursor === 'string') {
        // Validate cursor shape eagerly so we return 400 for garbage values
        try {
          decodeCursor(rawCursor);
        } catch (err) {
          res.status(400).json({
            status: 'error',
            message: (err as Error).message,
          });
          return;
        }
      }

      const cursor =
        typeof rawCursor === 'string' && rawCursor.length > 0
          ? rawCursor
          : undefined;

      const page = await contractsService.getContractsPage({ limit, cursor });
      res.status(200).json({ status: 'success', data: page });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/contracts
   * Create a new escrow contract metadata entry.
   */
  public static async createContract(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const data: CreateContractDto = req.body;
      const newContract = await contractsService.createContract(data);
      res.status(201).json({ status: 'success', data: newContract });
    } catch (error) {
      next(error);
    }
  }
}

// Re-export for convenience in tests
export { CURSOR_DEFAULT_LIMIT };
