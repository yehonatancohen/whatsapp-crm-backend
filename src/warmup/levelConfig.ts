import { WarmupLevel, WarmupActivityType, WarmupIntensity } from '@prisma/client';

export interface LevelConfig {
  level: WarmupLevel;
  maxMessagesPerDay: number;
  minDaysAtLevel: number;
  minTotalMessages: number;
  activities: WarmupActivityType[];
  intervalMinMs: number;
  intervalMaxMs: number;
}

const LEVEL_CONFIGS: Record<WarmupLevel, LevelConfig> = {
  [WarmupLevel.L1]: {
    level: WarmupLevel.L1,
    maxMessagesPerDay: 5,
    minDaysAtLevel: 3,
    minTotalMessages: 10,
    activities: [WarmupActivityType.MESSAGE_SENT],
    intervalMinMs: 8 * 60 * 1000,
    intervalMaxMs: 15 * 60 * 1000,
  },
  [WarmupLevel.L2]: {
    level: WarmupLevel.L2,
    maxMessagesPerDay: 15,
    minDaysAtLevel: 4,
    minTotalMessages: 40,
    activities: [WarmupActivityType.MESSAGE_SENT, WarmupActivityType.PROFILE_UPDATE],
    intervalMinMs: 5 * 60 * 1000,
    intervalMaxMs: 12 * 60 * 1000,
  },
  [WarmupLevel.L3]: {
    level: WarmupLevel.L3,
    maxMessagesPerDay: 30,
    minDaysAtLevel: 7,
    minTotalMessages: 120,
    activities: [
      WarmupActivityType.MESSAGE_SENT,
      WarmupActivityType.MESSAGE_RECEIVED,
      WarmupActivityType.PROFILE_UPDATE,
    ],
    intervalMinMs: 3 * 60 * 1000,
    intervalMaxMs: 8 * 60 * 1000,
  },
  [WarmupLevel.L4]: {
    level: WarmupLevel.L4,
    maxMessagesPerDay: 50,
    minDaysAtLevel: 7,
    minTotalMessages: 300,
    activities: [
      WarmupActivityType.MESSAGE_SENT,
      WarmupActivityType.MESSAGE_RECEIVED,
      WarmupActivityType.PROFILE_UPDATE,
      WarmupActivityType.STATUS_POST,
    ],
    intervalMinMs: 2 * 60 * 1000,
    intervalMaxMs: 6 * 60 * 1000,
  },
  [WarmupLevel.L5]: {
    level: WarmupLevel.L5,
    maxMessagesPerDay: 100,
    minDaysAtLevel: 0, // No level-up from L5
    minTotalMessages: 0, // No level-up from L5
    activities: [
      WarmupActivityType.MESSAGE_SENT,
      WarmupActivityType.MESSAGE_RECEIVED,
      WarmupActivityType.PROFILE_UPDATE,
      WarmupActivityType.STATUS_POST,
    ],
    intervalMinMs: 1 * 60 * 1000,
    intervalMaxMs: 4 * 60 * 1000,
  },
};

/** Get the configuration for a given warmup level. */
export function getLevelConfig(level: WarmupLevel): LevelConfig {
  return LEVEL_CONFIGS[level];
}

/**
 * Apply an intensity modifier to a level config.
 * GHOST: very slow recovery for banned accounts (20% messages, 5× intervals, messages only)
 * LOW:   gentler warmup (50% messages, 2× intervals)
 * NORMAL: default behaviour (unchanged)
 * HIGH:  faster warmup (150% messages, 70% intervals)
 */
export function applyIntensity(config: LevelConfig, intensity: WarmupIntensity): LevelConfig {
  switch (intensity) {
    case WarmupIntensity.GHOST:
      return {
        ...config,
        maxMessagesPerDay: Math.max(1, Math.floor(config.maxMessagesPerDay * 0.2)),
        intervalMinMs: config.intervalMinMs * 5,
        intervalMaxMs: config.intervalMaxMs * 5,
        activities: [WarmupActivityType.MESSAGE_SENT],
      };
    case WarmupIntensity.LOW:
      return {
        ...config,
        maxMessagesPerDay: Math.max(2, Math.floor(config.maxMessagesPerDay * 0.5)),
        intervalMinMs: config.intervalMinMs * 2,
        intervalMaxMs: config.intervalMaxMs * 2,
      };
    case WarmupIntensity.HIGH:
      return {
        ...config,
        maxMessagesPerDay: Math.floor(config.maxMessagesPerDay * 1.5),
        intervalMinMs: Math.max(60_000, Math.floor(config.intervalMinMs * 0.7)),
        intervalMaxMs: Math.max(90_000, Math.floor(config.intervalMaxMs * 0.7)),
      };
    default: // NORMAL
      return config;
  }
}

/** Get the next warmup level, or null if already at max. */
export function getNextLevel(level: WarmupLevel): WarmupLevel | null {
  const order: WarmupLevel[] = [
    WarmupLevel.L1,
    WarmupLevel.L2,
    WarmupLevel.L3,
    WarmupLevel.L4,
    WarmupLevel.L5,
  ];
  const idx = order.indexOf(level);
  if (idx < 0 || idx >= order.length - 1) return null;
  return order[idx + 1];
}
