import { WarmupLevel, WarmupActivityType } from '@prisma/client';

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
