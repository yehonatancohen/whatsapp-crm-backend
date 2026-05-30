/**
 * sendWithPreview — WhatsApp link preview helper
 *
 * Scrapes OG metadata in Node (not in the browser), resizes the og:image to a
 * JPEG thumbnail via sharp, then injects all preview fields directly into
 * window.WWebJS.sendMessage via pupPage.evaluate, bypassing WhatsApp Web's
 * broken headless getLinkPreview() path entirely.
 *
 * Enable/disable via WA_LINK_PREVIEW_ENABLED env var (default: true).
 */

import ogs from 'open-graph-scraper';
import axios from 'axios';
import sharp from 'sharp';
import { Client } from 'whatsapp-web.js';
import { logger } from '../shared/logger';

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

interface PreviewData {
  title: string;
  description: string;
  canonicalUrl: string;
  matchedText: string;
  richPreviewType: 0;
  thumbnail: string | null;
  thumbnailWidth: number;
  thumbnailHeight: number;
  doNotPlayInline: true;
}

export async function buildPreview(url: string): Promise<PreviewData> {
  let result: Awaited<ReturnType<typeof ogs>>['result'];
  try {
    ({ result } = await ogs({
      url,
      timeout: 5,
      fetchOptions: { headers: { 'user-agent': 'WhatsApp/2.24.0' } },
    }));
  } catch (e: any) {
    // ogs v6 throws { result, error: string } rather than an Error instance
    const msg: string = e?.error ?? e?.message ?? JSON.stringify(e);
    throw new Error(`OGS failed: ${msg}`);
  }

  let thumbnail: string | null = null;
  let thumbnailWidth = 200;
  let thumbnailHeight = 200;
  const imgUrl = result.ogImage?.[0]?.url;

  if (imgUrl) {
    try {
      const img = await axios.get<ArrayBuffer>(imgUrl, {
        responseType: 'arraybuffer',
        timeout: 5000,
        maxContentLength: 5 * 1024 * 1024,
      });
      const resized = await sharp(Buffer.from(img.data))
        .resize(200, 200, { fit: 'inside' })
        .jpeg({ quality: 70 })
        .toBuffer();
      const meta = await sharp(resized).metadata();
      thumbnailWidth = meta.width ?? 200;
      thumbnailHeight = meta.height ?? 200;
      thumbnail = resized.toString('base64');
    } catch (_e) {
      // continue without thumbnail
    }
  }

  return {
    title: result.ogTitle ?? '',
    description: result.ogDescription ?? '',
    canonicalUrl: result.requestUrl ?? url,
    matchedText: url,
    richPreviewType: 0,
    thumbnail,
    thumbnailWidth,
    thumbnailHeight,
    doNotPlayInline: true,
  };
}

/**
 * Drop-in replacement for client.sendMessage when the text may contain a URL.
 *
 * 1. Detects the first URL in the message body.
 * 2. Scrapes OG metadata + downloads/resizes the og:image in Node.
 * 3. Injects the preview directly into window.WWebJS.sendMessage via pupPage.evaluate.
 * 4. Falls back to client.sendMessage on any error or when no URL is present.
 *
 * Returns the serialized message ID on success, or null on plain fallback.
 */
export async function sendWithPreview(
  client: Client,
  chatId: string,
  text: string,
  opts: Record<string, unknown> = {},
): Promise<string | null> {
  if (process.env.WA_LINK_PREVIEW_ENABLED === 'false') {
    const m = await client.sendMessage(chatId, text, opts as any);
    return m?.id?._serialized ?? null;
  }

  const match = text.match(URL_REGEX);
  if (!match) {
    const m = await client.sendMessage(chatId, text, opts as any);
    return m?.id?._serialized ?? null;
  }

  const url = match[1];
  const t0 = Date.now();
  let preview: PreviewData;

  try {
    preview = await buildPreview(url);
    logger.info(
      { url, hasThumbnail: preview.thumbnail !== null, ms: Date.now() - t0 },
      '[linkPreview] preview ready',
    );
  } catch (e) {
    logger.warn(
      { url, err: (e as Error).message },
      '[linkPreview] scrape failed, sending plain',
    );
    const m = await client.sendMessage(chatId, text, opts as any);
    return m?.id?._serialized ?? null;
  }

  // pupPage is populated after client.initialize(); surface a clear error if absent.
  const pupPage = (client as any).pupPage;
  if (!pupPage) {
    throw new Error(
      '[linkPreview] client.pupPage is not available — ensure the client is initialized',
    );
  }

  // Strip the boolean linkPreview flag; everything else (e.g. quotedMessageId) is passed through.
  const { linkPreview: _ignored, ...passthroughOpts } = opts;

  try {
    const id: string | null = await pupPage.evaluate(
      // Arrow function is NOT serialisable across pupPage.evaluate boundaries;
      // use a plain function expression so Puppeteer can stringify it.
      async function ({
        chatId,
        text,
        preview,
        passthroughOpts,
      }: {
        chatId: string;
        text: string;
        preview: PreviewData;
        passthroughOpts: Record<string, unknown>;
      }) {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const wid = (globalThis as any)
          .require('WAWebWidFactory')
          .createWid(chatId);
        // Use the same fallback as WWebJS.getChat: findOrCreateLatestChat
        const chat =
          (globalThis as any).require('WAWebCollections').Chat.get(wid) ??
          (await (globalThis as any).require('WAWebFindChatAction').findOrCreateLatestChat(wid))?.chat;
        if (!chat) throw new Error(`[linkPreview] chat not found: ${chatId}`);

        // getLinkPreview expects a link object from findLink(), not a raw URL string.
        // Call it the same way WWebJS.sendMessage does internally.
        const { findLink } = (globalThis as any).require('WALinkify');
        const linkObj = findLink(text);
        const mod = (globalThis as any).require('WAWebLinkPreviewChatAction');

        const previewDataPromise: Promise<any> = linkObj
          ? mod.getLinkPreview(linkObj).catch(() => null)
          : Promise.resolve(null);
        const timeoutPromise = new Promise<null>(r => setTimeout(() => r(null), 10000));
        const realPreview = await Promise.race([previewDataPromise, timeoutPromise]);

        if (realPreview) {
          const pd = realPreview.data?.matchedText ? realPreview.data : realPreview;
          // Use WhatsApp's own result — thumbnail is server-generated and correctly formatted
          const res = await (globalThis as any).WWebJS.sendMessage(chat, text, {
            ...passthroughOpts,
            ...pd,
            preview: true,
            subtype: 'url',
            linkPreview: false, // prevent double getLinkPreview call
          });
          return (res as any)?.id?._serialized ?? null;
        }

        // Fallback: inject OGS fields without thumbnail (server rejects raw embedded bytes)
        const res = await (globalThis as any).WWebJS.sendMessage(chat, text, {
          ...passthroughOpts,
          preview: true,
          subtype: 'url',
          title: preview.title,
          description: preview.description,
          canonicalUrl: preview.canonicalUrl || preview.matchedText,
          matchedText: preview.matchedText,
          richPreviewType: 0,
          doNotPlayInline: true,
        });
        return (res as any)?.id?._serialized ?? null;
      },
      { chatId, text, preview, passthroughOpts },
    );
    return id;
  } catch (e) {
    logger.warn(
      { chatId, err: (e as Error).message },
      '[linkPreview] inject failed, sending plain',
    );
    const m = await client.sendMessage(chatId, text, opts as any);
    return m?.id?._serialized ?? null;
  }
}
