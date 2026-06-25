import { CreateContractDto } from '../modules/contracts/dto/contract.dto';
import { SorobanService } from './soroban.service';
import type { CursorPaginationInput, CursorPage } from '../contracts/cursor.types';

/**
 * @dev Service layer for managing Freelancer Escrow Contracts.
 * Handles business logic, database interactions (mocked for now),
 * and orchestration with the Soroban smart contract service.
 */
export class ContractsService {
  private sorobanService: SorobanService;

  // Mock database (in-memory; replaced by a real DB repository in production)
  private contracts: any[] = [];

  constructor() {
    this.sorobanService = new SorobanService();
  }

  /**
   * Retrieves all contracts.
   * @deprecated Prefer {@link getContractsPage} for scalable access.
   * @returns Array of contract metadata.
   */
  public async getAllContracts() {
    return this.contracts;
  }

  /**
   * Returns a cursor-paginated page of contracts ordered by `createdAt DESC`.
   *
   * The in-memory implementation mirrors the keyset semantics of the SQLite
   * repository so behaviour is consistent across environments.
   *
   * @param input - Optional `limit` (1–100) and opaque `cursor` string.
   * @returns A {@link CursorPage} with items and next-page cursor.
   */
  public async getContractsPage(
    input: CursorPaginationInput = {},
  ): Promise<CursorPage<any>> {
    // Import primitives here to keep the constructor lightweight
    const { parseLimit, encodeCursor, decodeCursor } = await import(
      '../contracts/cursor.repository'
    );

    const limit = parseLimit(input.limit);

    // Sort descending by createdAt, then id as tie-breaker (mirrors the DB query)
    const sorted = [...this.contracts].sort((a, b) => {
      const tDiff =
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (tDiff !== 0) return tDiff;
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });

    let startIndex = 0;
    if (input.cursor) {
      const pos = decodeCursor(input.cursor);
      const anchorIndex = sorted.findIndex(
        (c) => c.createdAt === pos.createdAt && c.id === pos.id,
      );
      startIndex = anchorIndex === -1 ? sorted.length : anchorIndex + 1;
    }

    const slice = sorted.slice(startIndex, startIndex + limit + 1);
    const hasNextPage = slice.length > limit;
    const pageItems = hasNextPage ? slice.slice(0, limit) : slice;

    const lastItem = pageItems[pageItems.length - 1];
    const nextCursor =
      hasNextPage && lastItem
        ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
        : null;

    return { data: pageItems, nextCursor, hasNextPage, limit };
  }

  /**
   * Creates a new contract off-chain, preparing it for escrow deposit.
   * @param data The contract details conforming to CreateContractDto.
   * @returns The newly created contract object.
   */
  public async createContract(data: CreateContractDto) {
    const newContract = {
      id: crypto.randomUUID(),
      ...data,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    };

    this.contracts.push(newContract);

    // Simulate notifying the Soroban service to prepare the transaction
    await this.sorobanService.prepareEscrow(newContract.id, data.budget);

    return newContract;
  }
}
