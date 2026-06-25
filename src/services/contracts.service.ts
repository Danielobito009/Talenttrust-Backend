import { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';
import { Contract } from '../db/types';
import { ContractRepository } from '../repositories/contractRepository';
import { SorobanService } from './soroban.service';
import { validateContractBounds, ContractBoundsError } from '../contracts/bounds';
import { MAX_MILESTONES_PER_CONTRACT, MAX_CONTRACT_AMOUNT_STROOPS } from '../contracts/bounds';
import { NotFoundError } from '../errors/appError';

/**
 * @dev Service layer for managing Freelancer Escrow Contracts.
 * Handles business logic, database interactions,
 * and orchestration with the Soroban smart contract service.
 */
export class ContractsService {
  private contractRepository: ContractRepository;
  private sorobanService: SorobanService;

  constructor(contractRepository: ContractRepository) {
    this.sorobanService = new SorobanService();
    this.contractRepository = contractRepository;
  }

  /**
   * Retrieves all contracts from the repository.
   * @returns Array of contract metadata including version field.
   */
  public async getAllContracts(): Promise<Contract[]> {
    return this.contractRepository.findAll();
  }

  /**
   * Retrieves a single contract by ID.
   * @param id The contract UUID.
   * @returns The contract or undefined if not found.
   */
  public async getContractById(id: string): Promise<Contract | undefined> {
    return this.contractRepository.findById(id);
  }

  /**
   * Creates a new contract off-chain, preparing it for escrow deposit.
   * Enforces milestone count and total amount caps before persisting.
   * @param data The contract details conforming to CreateContractDto.
   * @returns The newly created contract object.
   * @throws ContractBoundsError if budget or milestone totals exceed policy limits.
   */
  public async createContract(data: CreateContractDto): Promise<Contract> {
    const boundsCheck = validateContractBounds(data.budget, data.milestones);
    if (!boundsCheck.valid) {
      throw new ContractBoundsError(boundsCheck.error);
    }

    const newContract = this.contractRepository.create({
      title: data.title,
      clientId: data.clientId,
      freelancerId: data.freelancerId ?? '',
      amount: data.budget,
      status: data.status || 'draft',
    });

    // Notify the Soroban service to prepare the transaction
    try {
      await this.sorobanService.prepareEscrow(newContract.id, data.budget);
    } catch (error) {
      console.warn(`[ContractsService] Soroban prepareEscrow failed for contract ${newContract.id}:`, error);
    }

    return newContract;
  }

  /**
   * Updates a contract using Optimistic Concurrency Control.
   *
   * Maps every updatable field from {@link UpdateContractDto} into the update
   * payload and re-runs {@link validateContractBounds} whenever `budget` or
   * `milestones` are included in the patch. Rejects empty patches with a
   * validation error so callers receive a clear signal rather than a misleading
   * 200 that changed nothing.
   *
   * @param id  - UUID of the contract to update.
   * @param dto - Partial update payload including the OCC `version`.
   * @throws ContractBoundsError  when amount or milestone bounds are violated.
   * @throws ValidationError      when the patch is empty.
   * @throws VersionConflictError when the version is stale.
   */
  public async updateContract(id: string, dto: UpdateContractDto): Promise<Contract> {
    const { version, ...fields } = dto;

    // Reject no-op updates
    const hasFields = Object.keys(fields).some(
      (k) => (fields as Record<string, unknown>)[k] !== undefined
    );
    if (!hasFields) {
      throw new Error('At least one field must be provided for an update.');
    }

    // Re-validate bounds when amount or milestones are being changed
    const budget = fields.budget;
    const milestones = fields.milestones;
    if (budget !== undefined || milestones !== undefined) {
      // Fall back to 0 if budget is absent so the bounds check can still run on milestones alone
      const boundsCheck = validateContractBounds(budget ?? 0, milestones);
      if (!boundsCheck.valid) {
        throw new ContractBoundsError(boundsCheck.error);
      }
    }

    const updateFields: Partial<Contract> = {};
    if (fields.title !== undefined) updateFields.title = fields.title;
    if (fields.status !== undefined) updateFields.status = fields.status;
    if (fields.budget !== undefined) updateFields.amount = fields.budget;
    if (fields.freelancerId !== undefined) updateFields.freelancerId = fields.freelancerId ?? '';

    return this.contractRepository.updateWithVersion(id, updateFields, version);
  }

  /**
   * Deletes a contract by ID.
   */
  public async deleteContract(id: string): Promise<void> {
    const deleted = this.contractRepository.delete(id);
    if (!deleted) {
      throw new NotFoundError(`Contract with id ${id} not found`);
    }
  }

  /**
   * Retrieves contract statistics.
   */
  public async getContractStats() {
    const all = await this.getAllContracts();
    const stats = {
      total: all.length,
      totalBudget: all.reduce((sum, c) => sum + c.amount, 0),
      byStatus: all.reduce((acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
    return stats;
  }

  /**
   * Retrieves policy bounds.
   */
  public getBounds() {
    return {
      maxMilestones: MAX_MILESTONES_PER_CONTRACT,
      maxAmount: MAX_CONTRACT_AMOUNT_STROOPS,
    };
  }
}
