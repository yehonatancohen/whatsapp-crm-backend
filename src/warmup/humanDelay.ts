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
import { logger } from '../shared/logger';

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

// ─── Link Preview Pre-warming ────────────────────────────────────────────────

/**
 * Pre-fetch link preview data by calling WhatsApp Web's internal getLinkPreview
 * before sendMessage. This triggers WhatsApp's servers to fetch the URL's OG
 * metadata (title, description, thumbnail image) so the data is cached by the
 * time sendMessage's own getLinkPreview call runs.
 *
 * Polls until jpegThumbnail is present in the response (meaning the image was
 * fully fetched by WA servers), or until the 30-second timeout is reached.
 * Without this polling, the thumbnail is frequently missing because WA servers
 * fetch the page text first and the image asynchronously.
 */
export async function preFetchLinkPreview(client: Client, text: string): Promise<void> {
    try {
        const page = (client as any).pupPage;
        if (!page) {
            logger.warn({ textLen: text.length }, 'preFetchLinkPreview: no pupPage');
            return;
        }

        const result = await Promise.race([
            page.evaluate(async (messageText: string) => {
                const out: { status: string; url?: string; error?: string; attempts?: number } = { status: 'unknown' };
                try {
                    const g = globalThis as any;
                    const { findLink } = g.window.require('WALinkify');
                    const link = findLink(messageText);
                    if (!link) {
                        out.status = 'no-url-found';
                        return out;
                    }
                    out.url = typeof link === 'string' ? link : link?.href ?? String(link);

                    const getLinkPreview = g.window
                        .require('WAWebLinkPreviewChatAction')
                        .getLinkPreview;

                    // Poll until the thumbnail (jpegThumbnail) is available.
                    // WA servers fetch page text first and the image asynchronously,
                    // so the first response often has data but no thumbnail yet.
                    let attempts = 0;
                    const sleep = (ms: number) => new Promise((r: any) => setTimeout(r, ms));
                    while (attempts < 12) { // 12 × 2 s = 24 s max (inside the 30 s race)
                        const preview = await getLinkPreview(link);
                        if (preview?.data?.jpegThumbnail) {
                            out.status = 'fetched-with-thumbnail';
                            out.attempts = attempts + 1;
                            return out;
                        }
                        if (preview?.data) {
                            // Data arrived but no thumbnail yet — keep polling
                            out.status = 'fetched-no-thumbnail';
                        } else {
                            out.status = 'no-data';
                        }
                        attempts++;
                        await sleep(2_000);
                    }
                    // Timed out waiting for thumbnail; sendMessage will use whatever is cached
                    out.attempts = attempts;
                    return out;
                } catch (e: any) {
                    out.status = 'error';
                    out.error = e?.message || String(e);
                    return out;
                }
            }, text),
            sleep(30_000).then(() => ({ status: 'timeout-30s' })),
        ]);

        logger.info({ result, textPreview: text.slice(0, 80) }, 'preFetchLinkPreview: status');
    } catch (err) {
        logger.warn({ err: (err as Error)?.message }, 'preFetchLinkPreview: outer error');
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

    // 6. Ensure link preview data (including thumbnail) is cached before sending
    await linkPreviewReady;

    // 7. Send the actual message (pass optional sendOptions e.g. { linkPreview: true })
    await chat.sendMessage(text, sendOptions);
}

/**
 * Sends a message with minimal presence signalling and no artificial sleep.
 * Used by campaign and promotion workers where the BullMQ delay in
 * scheduleNextJob controls the rate; no extra latency is added here so the
 * configured messagesPerMinute is honoured accurately even at high rates.
 *
 * When linkPreview is requested, pre-warm the cache in parallel with the
 * presence/typing setup so WhatsApp's servers have time to fetch OG metadata
 * (including the thumbnail image) before sendMessage's internal getLinkPreview
 * call runs. Without this, campaigns and promotions sent without any warm-up
 * time result in a preview card with no thumbnail image.
 */
export async function simulateFastSend(
    client: Client,
    chatId: string,
    text: string,
    sendOptions?: Record<string, unknown>,
): Promise<void> {
    // Start link preview warm-up immediately so WA servers can fetch OG data
    // (including thumbnail) while we're setting up presence — both run concurrently.
    const linkPreviewReady = sendOptions?.linkPreview
        ? preFetchLinkPreview(client, text)
        : Promise.resolve();

    await client.sendPresenceAvailable();
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();

    // Ensure preview data (with thumbnail) is cached before the send triggers getLinkPreview
    await linkPreviewReady;

    await chat.sendMessage(text, sendOptions);
}
