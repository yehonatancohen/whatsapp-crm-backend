/**
 * Warmup message generator.
 *
 * Layered on top of the existing spintax resolver, this adds three sources
 * of entropy that a detection system reads as human:
 *
 *   1. Length variation — real chats mix one-word replies and emojis with
 *      longer messages. A pool that only produces medium-length greetings
 *      is a fingerprint. We draw from MICRO / SHORT / LONG buckets with
 *      explicit probabilities.
 *   2. Filler insertion — occasional prepended/appended conversational
 *      fillers ("btw", "lol", ...) break up templated openings.
 *   3. Typo + correction — real users mistype and send a starred fix.
 *      We occasionally emit a two-message sequence: typo'd primary, then
 *      a "*correctword" follow-up.
 */

import { resolveSpintax } from './spintax';

// ─── Pools ──────────────────────────────────────────────────────────────────

const MICRO = [
  'ok', 'lol', 'haha', 'same', 'yeah', 'fr', 'bet', 'nice', 'yup', 'word',
  '👍', '🔥', '😂', '🙌', '💯', 'k', 'cool', 'sweet',
];

const SHORT = [
  "{Hey|Hi|{Yo|Sup}} {bro|man|dude}, {what's up?|how are you?|how's it going?}",
  "Just {checking in|saying hi}, {everything good?|all good?|how have you been?}",
  "{Good morning|Morning}, {hope you have a good one|have a great day}!",
  "{Yo|Hey}, let me know when you're {free|around} to chat.",
  "{What's good|What's up}? {Haven't heard from you|Been a while}!",
  "{Hope you're doing well|Hope all is well}! {Talk soon|Catch up soon}.",
  "{Hey there|Hi there}, {just wanted to say hi|thought I'd reach out}!",
  "{Happy {Monday|Tuesday|Wednesday|Thursday|Friday}}! {Have a great one|Enjoy your day}.",
  "{you around|you there}?",
  "{call me when free|hit me up later}",
  "{how was your day|how's the day going}?",
  "{what you up to|wyd}?",
];

const LONG = [
  "{Hey|Hi} {man|bro}, {been meaning to message you|wanted to check in}. " +
    "{How's the week going|How have things been}? {Let me know when you have a minute|Talk soon}.",
  "{Yo|Sup}! {Just remembered|Was just thinking} about {that thing we talked about|the other day}. " +
    "{Crazy right|Wild stuff}. {Anyway|Anyways}, {how are you|hope you're good}.",
  "{Morning|Hey}, {hope the week is treating you well|hope you're having a good one}. " +
    "{Nothing urgent|No rush}, {just figured I'd say hi|just wanted to catch up}. " +
    "{Talk when you can|Hit me back whenever}.",
  "{Okay so|Listen}, {you will not believe|you won't guess} {what happened|what I just saw}. " +
    "{Remind me to tell you later|I'll fill you in next time we talk}.",
];

const FILLERS_PREPEND = ['btw ', 'ok so ', 'anyway ', 'tbh '];
const FILLERS_APPEND = [' lol', ' haha', ' just saying', ' tbh'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

type Bucket = 'MICRO' | 'SHORT' | 'LONG';

function pickBucket(): Bucket {
  const r = Math.random();
  if (r < 0.35) return 'MICRO';
  if (r < 0.80) return 'SHORT';
  return 'LONG';
}

/**
 * Adjacent-letter swap on one word of length > 4. Returns { typoText, word }
 * where `word` is the correctly-spelled original word (for the follow-up
 * "*word" correction message).
 */
function makeTypo(text: string): { typoText: string; correctWord: string } | null {
  const tokens = text.split(/(\s+)/); // preserve whitespace
  const candidates: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    // Only swap inside plain-alpha words longer than 4 chars
    if (/^[A-Za-z]{5,}$/.test(w)) candidates.push(i);
  }
  if (candidates.length === 0) return null;
  const idx = pickRandom(candidates);
  const word = tokens[idx];
  // Swap two adjacent chars somewhere in the middle of the word.
  const swapAt = 1 + Math.floor(Math.random() * (word.length - 2));
  const typoWord =
    word.slice(0, swapAt) + word[swapAt + 1] + word[swapAt] + word.slice(swapAt + 2);
  if (typoWord === word) return null;
  tokens[idx] = typoWord;
  return { typoText: tokens.join(''), correctWord: word };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GeneratedMessage {
  /** The primary message to send. May contain a deliberate typo. */
  primary: string;
  /** If present, send this as a follow-up ~3–6s after primary (typo correction). */
  correction?: string;
  /** Bucket used, for logging. */
  bucket: Bucket;
}

export function generateWarmupMessage(): GeneratedMessage {
  const bucket = pickBucket();

  if (bucket === 'MICRO') {
    // Micro messages get no fillers and no typos — they're already chaotic enough.
    return { primary: pickRandom(MICRO), bucket };
  }

  const pool = bucket === 'SHORT' ? SHORT : LONG;
  let text = resolveSpintax(pickRandom(pool));

  // ~25% chance of a filler
  if (Math.random() < 0.25) {
    if (Math.random() < 0.5) {
      text = pickRandom(FILLERS_PREPEND) + text;
    } else {
      text = text + pickRandom(FILLERS_APPEND);
    }
  }

  // ~8% chance of typo + correction (only on non-MICRO, only when we find
  // a suitable word).
  if (Math.random() < 0.08) {
    const typo = makeTypo(text);
    if (typo) {
      return {
        primary: typo.typoText,
        correction: `*${typo.correctWord}`,
        bucket,
      };
    }
  }

  return { primary: text, bucket };
}
