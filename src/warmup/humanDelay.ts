/**
 * Human Emulation Delay Utility
 *
 * Simulates realistic human typing and "reading" behavior before sending
 * a WhatsApp message, using whatsapp-web.js presence and typing indicators.
 *
 * Flow:
 *   1. Go online  → sendPresenceAvailable()
 *   2. Build link preview data (if requested) — fetched server-side, runs in parallel
 *   3. "Read" pause → random 1-3 s
 *   4. Typing indicator → sendStateTyping(chatId)
 *   5. Typed delay  → based on message length (~38-42 WPM, randomised)
 *   6. Await link preview data ready
 *   7. Send message → sendMessage(chatId, text, { ...previewOptions })
 *
 * Link preview strategy:
 *   WhatsApp Web's internal getLinkPreview() returns null in a headless/bot
 *   context because it requires an active chat to be open in the browser UI.
 *   We bypass it entirely by fetching OG tags and the og:image ourselves
 *   on the Node.js side, then injecting jpegThumbnail + metadata directly
 *   into the sendMessage options. This is the only reliable approach for bots.
 */

import { Client } from 'whatsapp-web.js';
import { logger } from '../shared/logger';
import * as https from 'https';
import * as http from 'http';
import * as sharp from 'sharp';

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

// ─── Link Preview (Server-side OG approach) ─────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"']+/i;
const OG_TAG_REGEX = /<meta\s+(?:property|name)=["'](og:[^"']+)["']\s+content=["']([^"']*)["']\s*\/?>|<meta\s+content=["']([^"']*)["']\s+(?:property|name)=["'](og:[^"']+)["']\s*\/?>|<title[^>]*>([^<]+)<\/title>/gi;

/** Regex-based OG scraper (no cheerio needed) */
function parseOgTags(html: string): Record<string, string> {
    const og: Record<string, string> = {};
    let m;
    const re = /<meta\s[^>]*>/gi;
    while ((m = re.exec(html)) !== null) {
        const tag = m[0];
        const propMatch = /(?:property|name)=["'](og:[^"']+)["']/i.exec(tag);
        const contentMatch = /content=["']([^"']*)["']/i.exec(tag);
        if (propMatch && contentMatch) {
            og[propMatch[1]] = contentMatch[1];
        }
    }
    if (!og['og:title']) {
        const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
        if (titleMatch) og['og:title'] = titleMatch[1].trim();
    }
    return og;
}

/** Download a URL to a Buffer (follows up to 3 redirects). */
function downloadBuffer(url: string, redirectsLeft = 3): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = (mod as any).get(url, { timeout: 10_000 }, (res: any) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                return resolve(downloadBuffer(res.headers.location as string, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
    });
}

export interface LinkPreviewOptions {
    /** Set to false so Utils.js skips its broken getLinkPreview() call */
    linkPreview: false;
    /** Signals WhatsApp to render this message as a link preview card */
    preview: true;
    subtype: 'url';
    title: string;
    description: string;
    canonicalUrl: string;
    matchedText: string;
    /** Base64-encoded JPEG thumbnail (no data: prefix) */
    jpegThumbnail?: string;
}

/**
 * Build link preview options by fetching OG tags and downloading the
 * og:image on the Node.js side. Returns options ready to spread into
 * client.sendMessage(). Bypasses WhatsApp Web's broken headless
 * getLinkPreview() entirely.
 *
 * Returns null if no URL is found in the text or fetching fails.
 */
export async function buildLinkPreviewOptions(text: string): Promise<LinkPreviewOptions | null> {
    try {
        // Find first URL in the message text
        const urlMatch = URL_REGEX.exec(text);
        if (!urlMatch) return null;
        const url = urlMatch[0];

        // Fetch the page HTML with a WhatsApp-like user agent
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        let html = '';
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'WhatsApp/2.23.20.0',
                    'Accept': 'text/html,application/xhtml+xml',
                },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            html = await res.text();
        } finally {
            clearTimeout(timer);
        }

        const og = parseOgTags(html);
        const title = og['og:title'] || '';
        const description = og['og:description'] || '';
        const canonicalUrl = og['og:url'] || url;
        const imageUrl = og['og:image'] || '';

        if (!title && !imageUrl) {
            logger.warn({ url }, 'buildLinkPreviewOptions: no OG title or image found');
            return null;
        }

        const previewOpts: LinkPreviewOptions = {
            linkPreview: false,
            preview: true,
            subtype: 'url',
            title,
            description,
            canonicalUrl,
            matchedText: url,
        };

        // Download og:image and convert to base64 JPEG thumbnail
        if (imageUrl) {
            try {
                const imgBuf = await downloadBuffer(imageUrl);
                // Resize to ≤300×300 JPEG to keep WhatsApp happy with thumbnail size
                const sharpLib = (sharp as any).default ?? sharp;
                const jpegBuf = await sharpLib(imgBuf)
                    .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toBuffer();
                previewOpts.jpegThumbnail = jpegBuf.toString('base64');
                logger.info({ url, imageUrl, jpegBytes: jpegBuf.length }, 'buildLinkPreviewOptions: thumbnail ready');
            } catch (imgErr) {
                logger.warn({ url, imageUrl, err: (imgErr as Error)?.message }, 'buildLinkPreviewOptions: image download failed, sending preview without thumbnail');
            }
        }

        return previewOpts;
    } catch (err) {
        logger.warn({ err: (err as Error)?.message }, 'buildLinkPreviewOptions: failed');
        return null;
    }
}

/**
 * @deprecated Use buildLinkPreviewOptions instead.
 * Kept for backward compatibility — now a no-op since we no longer poll
 * WhatsApp Web's broken getLinkPreview().
 */
export async function preFetchLinkPreview(_client: Client, _text: string): Promise<void> {
    // No-op: replaced by buildLinkPreviewOptions
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

    // 2. If link preview is requested, start building it immediately (server-side).
    //    Runs in parallel with reading/typing delays so the image download
    //    completes before we call sendMessage.
    const linkPreviewPromise = sendOptions?.linkPreview
        ? buildLinkPreviewOptions(text)
        : Promise.resolve(null);

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

    // 6. Merge server-side preview data into send options
    const linkPreviewData = await linkPreviewPromise;
    const finalOptions: Record<string, unknown> = { ...(sendOptions || {}) };
    if (linkPreviewData) {
        // Remove the boolean linkPreview flag and inject our own preview fields
        delete finalOptions.linkPreview;
        Object.assign(finalOptions, linkPreviewData);
    }

    // 7. Send the actual message with merged options
    await chat.sendMessage(text, finalOptions as any);
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
    // Start server-side link preview build immediately (runs concurrently with presence/typing).
    const linkPreviewPromise = sendOptions?.linkPreview
        ? buildLinkPreviewOptions(text)
        : Promise.resolve(null);

    await client.sendPresenceAvailable();
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();

    // Await the preview data and merge into options
    const linkPreviewData = await linkPreviewPromise;
    const finalOptions: Record<string, unknown> = { ...(sendOptions || {}) };
    if (linkPreviewData) {
        delete finalOptions.linkPreview;
        Object.assign(finalOptions, linkPreviewData);
    }

    await chat.sendMessage(text, finalOptions as any);
}
