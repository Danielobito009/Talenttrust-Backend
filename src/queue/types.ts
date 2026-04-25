/**
 * Queue Job Type Definitions
 * 
 * Defines the structure and types for all background jobs in the system.
 * Each job type has a specific payload structure for type safety.
 */

/**
 * Available job types in the system
 */
export enum JobType {
  EMAIL_NOTIFICATION = 'email-notification',
  CONTRACT_PROCESSING = 'contract-processing',
  REPUTATION_UPDATE = 'reputation-update',
  REPUTATION_RECOMPUTE = 'reputation-recompute',
  BLOCKCHAIN_SYNC = 'blockchain-sync',
}

/**
 * Email notification job payload
 */
export interface EmailNotificationPayload {
  to: string;
  subject: string;
  body: string;
  templateId?: string;
}

/**
 * Contract processing job payload
 */
export interface ContractProcessingPayload {
  contractId: string;
  action: 'create' | 'update' | 'finalize';
  metadata?: Record<string, unknown>;
}

/**
 * Reputation update job payload
 */
export interface ReputationUpdatePayload {
  userId: string;
  contractId: string;
  rating: number;
  feedback?: string;
}

/**
 * Reputation recompute job payload
 */
export interface ReputationRecomputePayload {
  batchSize?: number;
  forceRecompute?: boolean;
  resumeFromCheckpoint?: boolean;
}

/**
 * Blockchain synchronization job payload
 */
export interface BlockchainSyncPayload {
  network: 'stellar' | 'soroban';
  startBlock?: number;
  endBlock?: number;
}

/**
 * Union type for all job payloads
 */
export type JobPayload =
  | EmailNotificationPayload
  | ContractProcessingPayload
  | ReputationUpdatePayload
  | ReputationRecomputePayload
  | BlockchainSyncPayload;

/**
 * Job result structure
 */
export interface JobResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}
