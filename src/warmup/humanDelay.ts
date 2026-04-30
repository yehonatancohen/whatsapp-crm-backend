/**
 * Human Emulation Delay Utility
 *
 * Simulates realistic human typing and "reading" behavior before sending
 * a WhatsApp message, using whatsapp-web.js presence and typing indicators.
 *
 * Flow:
 *   1. Go online  → sendPresenceAvailable()
 *   2. Pre-warm link preview (if requested) — runs in parallel with delays
 *   3. "Read" pause → random 1-3 s
 *   4. Typing indicator → sendStateTyping(chatId)
 *   5. Typed delay  → based on message length (~38-42 WPM, randomised)
 *   6. Await link preview ready
 *   7. Send message → sendMessage(chatId, text)
 */

import { Client } from 'whatsapp-web.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Returns a random integer in [min, max] inclusive. */
function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Returns a random float in [min, max). */
function randFloat(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Link Preview Pre-warming ───────────────────────────────────────────────

/**
 * Pre-fetch link preview data by calling WhatsApp Web's internal link preview
 * Store before the actual sendMessage. This gives WA servers time to fetch OG
 * metadata (title, description, thumbnail) so it's cached when sendMessage
 * calls the same API internally.
 *
 * WA Web changes these Store APIs between versions, so we try multiple paths
 * and fall back to a plain URL regex if the Store URL finder isn't available.
 *
 * Runs with a 10-second timeout to avoid blocking the send indefinitely.
 */
export async function preFetchLinkPreview(client: Client, text: string): Promise<void> {
    try {
        const page = (client as any).pupPage;
        if (!page) return;

        await Promise.race([
            page.evaluate(async (messageText: string) => {
                try {
                    const store = (globalThis as any).Store;
                    if (!store) return;

                    // ── Step 1: extract URL ─────────────────────────────
                    // Try WA's own link finder first; fall back to plain regex.
                    let link: string | null = null;
                    if (typeof store?.Validators?.findLink === 'function') {
                        link = store.Validators.findLink(messageText) ?? null;
                    } else if (typeof store?.URLUtils?.findLink === 'function') {
                        link = store.URLUtils.findLink(messageText) ?? null;
                    }
                    if (!link) {
                        const m = messageText.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/);
                        link = m ? m[0] : null;
                    }
                    if (!link) return;

                    // ── Step 2: pre-fetch via WA's link preview Store ───
                    // WA Web has moved this API across several namespaces over time;
                    // try every known path until one resolves.
                    const previewFns = [
                        store?.LinkPreview?.getLinkPreview?.bind(store.LinkPreview),
                        store?.LinkPreviewStore?.getLinkPreview?.bind(store.LinkPreviewStore),
                        store?.Preview?.getLinkPreview?.bind(store.Preview),
                        store?.OGPreview?.getLinkPreview?.bind(store.OGPreview),
                        // Some builds expose it directly on the Store root
                        typeof store?.getLinkPreview === 'function' ? store.getLinkPreview.bind(store) : undefined,
                    ].filter(Boolean);

                    for (const fn of previewFns) {
                        try {
                            await (fn as Function)(link);
                            break; // first one that resolves wins
                        } catch { /* try next */ }
                    }
                } catch {
                    // Non-fatal — sendMessage will attempt its own preview fetch
                }
            }, text),
            sleep(10_000), // Hard cap: don't block the send more than 10 s
        ]);
    } catch {
        // Non-fatal
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Calculate a realistic typing duration for a given text.
 *
 * Assumptions:
 *  - Average word = 5 characters (standard typing-speed convention).
 *  - Typing speed = 38–42 WPM (randomised per call for variance).
 *  - A small per-character jitter (10-30 ms) is added to prevent
 *    perfectly round numbers, which would be a detection signal.
 *
 * @param text  The message that will be "typed".
 * @returns     Duration in milliseconds.
 */
export function calculateTypingDelay(text: string): number {
    const CHARS_PER_WORD = 5;
    const wordsPerMinute = randFloat(38, 42);
    const msPerChar = (60_000 / wordsPerMinute) / CHARS_PER_WORD;

    const baseDelay = text.length * msPerChar;
    const jitter = text.length * randInt(10, 30); // per-char jitter

    // Enforce a sane floor (800 ms) and ceiling (25 s) to avoid
    // suspiciously short or long typing indicators.
    const total = baseDelay + jitter;
    return Math.max(800, Math.min(total, 25_000));
}

/**
 * Orchestrate a full human-like message send.
 *
 * This function handles presence, typing indicators, delays, and the
 * actual message dispatch — all in the correct order with realistic timing.
 *
 * @param client  An authenticated whatsapp-web.js Client instance.
 * @param chatId  The WID (WhatsApp ID) of the recipient, e.g. "972501234567@c.us".
 * @param text    The fully resolved message text to send.
 */
export async function simulateHumanSend(
    client: Client,
    chatId: string,
    text: string,
    sendOptions?: Record<string, unknown>,
): Promise<void> {
    // 1. Appear online
    await client.sendPresenceAvailable();

    // 2. If link preview is requested, start pre-fetching immediately.
    //    This runs in parallel with reading/typing delays, giving WhatsApp's
    //    servers 4-28 s to fetch the URL's OG metadata before sendMessage needs it.
    const linkPreviewReady = sendOptions?.linkPreview
        ? preFetchLinkPreview(client, text)
        : Promise.resolve();

    // 3. "Reading" pause — mimic the time a user spends reading a conversation
    //    before they start typing a reply.
    const readingPause = randInt(1_000, 3_000);
    await sleep(readingPause);

    // 4. Start the typing indicator so the other side sees "typing…"
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();

    // 5. Wait for the realistic typing duration
    const typingDuration = calculateTypingDelay(text);
    await sleep(typingDuration);

    // 6. Ensure link preview data is cached before sending
    await linkPreviewReady;

    // 7. Send the actual message (pass optional sendOptions e.g. { linkPreview: true })
    await chat.sendMessage(text, sendOptions);
}
