/**
 * Warmup Engine — public API barrel file.
 *
 * Re-exports all warmup utilities so consumers can do:
 *   import { resolveSpintax, simulateHumanSend } from './warmup';
 */

export { resolveSpintax } from './spintax';
export { calculateTypingDelay, simulateHumanSend } from './humanDelay';
export { WarmupScheduler } from './scheduler';
export { getLevelConfig, getNextLevel } from './levelConfig';
export type { LevelConfig } from './levelConfig';
export {
  getWarmupStatus,
  toggleWarmup,
  checkLevelUp,
  getWarmupHistory,
  resetDailyCounts,
  getWarmupOverview,
} from './warmupService';
export { warmupCycleQueue, warmupSchedulerQueue } from './warmupQueue';
export { createSchedulerWorker, createCycleWorker } from './warmupWorker';
