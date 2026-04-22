/**
 * Per-account daily activity profile.
 *
 * WhatsApp's detection looks at *when* an account is active, not just how
 * much it sends. A profile that fires 24/7 at a constant rate is a strong
 * bot signal — even at low volume. This module produces a per-account,
 * per-day behavioral profile:
 *
 *   - An "active window" (roughly waking hours) that differs per account.
 *   - 2–4 "burst windows" inside it, mimicking how a real user opens the
 *     app in clusters (morning coffee, lunch, evening) rather than evenly.
 *   - A quota share per burst so the daily message budget is spent in
 *     those bursts, not spread flat.
 *
 * The profile is deterministic in (phoneNumber, date): any scheduler tick
 * on the same day derives the same profile without needing DB state.
 */

// ─── Deterministic PRNG ─────────────────────────────────────────────────────

/** 32-bit FNV-1a hash of a string — small, fast, good enough for a seed. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — deterministic float-in-[0,1) stream from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── Profile types ──────────────────────────────────────────────────────────

export interface BurstWindow {
  /** Minutes since local midnight. */
  startMin: number;
  /** Minutes since local midnight (exclusive). */
  endMin: number;
  /** Fraction of the day's quota allocated to this burst (sums to 1.0). */
  quotaShare: number;
}

export interface DailyProfile {
  activeStartMin: number;
  activeEndMin: number;
  bursts: BurstWindow[];
}

// ─── Profile generation ─────────────────────────────────────────────────────

/**
 * Build a per-account profile for a given calendar day.
 * Stable: same (phoneNumber, date) → same profile.
 */
export function getDailyProfile(phoneNumber: string, date: Date): DailyProfile {
  const rng = mulberry32(hashString(`${phoneNumber}|${dayKey(date)}`));

  // Active window: wake roughly 07:30–09:30, wind down 21:30–23:30.
  const activeStartMin = Math.floor(7.5 * 60 + rng() * 120);
  const activeEndMin = Math.floor(21.5 * 60 + rng() * 120);

  const numBursts = 2 + Math.floor(rng() * 3); // 2, 3, or 4
  const bursts = placeBursts(rng, activeStartMin, activeEndMin, numBursts);

  return { activeStartMin, activeEndMin, bursts };
}

/**
 * Place N non-overlapping burst windows (20–60 min each) inside [start, end].
 * Uses rejection sampling with a separation gap so bursts cluster naturally
 * instead of landing back-to-back or all at the front of the window.
 */
function placeBursts(
  rng: () => number,
  windowStart: number,
  windowEnd: number,
  n: number,
): BurstWindow[] {
  const MIN_LEN = 20;
  const MAX_LEN = 60;
  const MIN_GAP = 30; // minutes between bursts

  const placed: { start: number; end: number }[] = [];

  // Try up to 200 placements; if we can't fit n, return what we have.
  let attempts = 0;
  while (placed.length < n && attempts < 200) {
    attempts++;
    const len = MIN_LEN + Math.floor(rng() * (MAX_LEN - MIN_LEN + 1));
    const latestStart = windowEnd - len;
    if (latestStart <= windowStart) break;
    const start = windowStart + Math.floor(rng() * (latestStart - windowStart + 1));
    const end = start + len;

    const overlaps = placed.some(
      (b) => !(end + MIN_GAP <= b.start || start >= b.end + MIN_GAP),
    );
    if (overlaps) continue;
    placed.push({ start, end });
  }

  placed.sort((a, b) => a.start - b.start);

  // Weighted quota shares — draw Dirichlet-ish weights so distribution is
  // non-uniform (one burst will often carry more of the quota).
  const rawWeights = placed.map(() => 0.4 + rng() * 1.2);
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);

  return placed.map((b, i) => ({
    startMin: b.start,
    endMin: b.end,
    quotaShare: rawWeights[i] / weightSum,
  }));
}

// ─── Queries against a profile ──────────────────────────────────────────────

function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** True iff `now` falls inside the active window. */
export function isInsideActiveHours(profile: DailyProfile, now: Date): boolean {
  const m = minutesSinceMidnight(now);
  return m >= profile.activeStartMin && m < profile.activeEndMin;
}

/** Returns the index of the burst containing `now`, or null. */
export function isInsideBurst(profile: DailyProfile, now: Date): number | null {
  const m = minutesSinceMidnight(now);
  for (let i = 0; i < profile.bursts.length; i++) {
    const b = profile.bursts[i];
    if (m >= b.startMin && m < b.endMin) return i;
  }
  return null;
}

/**
 * Cumulative message target by `now`: sum of quota shares for bursts that
 * have already ended or are currently active (current burst counted in full,
 * on the assumption that by the time the scheduler checks, the burst is live
 * and any budget within it is fair game). Multiplied by daily max.
 *
 * This gates the scheduler: if messagesSentToday is already at or above the
 * target, we wait rather than spending today's budget too early.
 */
export function targetMessagesByNow(
  profile: DailyProfile,
  dailyMax: number,
  now: Date,
): number {
  const m = minutesSinceMidnight(now);
  let share = 0;
  for (const b of profile.bursts) {
    if (m >= b.startMin) share += b.quotaShare;
  }
  return Math.floor(dailyMax * Math.min(share, 1));
}

/**
 * Interval bounds to use when we're inside a burst — override the level's
 * global intervals with tighter, human-typing-session style spacing.
 * Weighted toward shorter delays (most replies in a burst are quick).
 */
export function burstIntervalMs(): { minMs: number; maxMs: number } {
  // 20s floor, 4min ceiling. The caller still adds randomness via the
  // existing scheduler threshold logic.
  return { minMs: 20_000, maxMs: 4 * 60_000 };
}
