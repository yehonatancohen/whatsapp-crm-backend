/**
 * Legacy WarmupScheduler — DEPRECATED
 *
 * The setTimeout-based scheduler has been replaced by BullMQ workers
 * in Phase 4. See warmupWorker.ts and warmupQueue.ts for the new
 * implementation.
 *
 * This class is retained only for backward compatibility and will
 * be removed in a future release.
 */

import { logger } from '../shared/logger';

/** @deprecated Use BullMQ-based warmup workers instead. */
export class WarmupScheduler {
  constructor(
    private _minIntervalMs: number = 2 * 60 * 1000,
    private _maxIntervalMs: number = 8 * 60 * 1000,
  ) {}

  public start(): void {
    logger.warn('WarmupScheduler.start() is deprecated — use BullMQ warmup workers instead');
  }

  public stop(): void {
    logger.warn('WarmupScheduler.stop() is deprecated — use BullMQ warmup workers instead');
  }
}
