import { Router, Request, Response } from 'express';

const router = Router();

const URL_REGEX = /https?:\/\/[^\s<>"']+/i;
const OG_TAG_REGEX = /<meta\s+(?:property|name)=["'](og:[^"']+)["']\s+content=["']([^"']*)["']\s*\/?>/gi;
const OG_TAG_REGEX_REV = /<meta\s+content=["']([^"']*)["']\s+(?:property|name)=["'](og:[^"']+)["']\s*\/?>/gi;
const TITLE_REGEX = /<title[^>]*>([^<]+)<\/title>/i;

/**
 * GET /api/utils/link-preview?url=...
 * Fetches OG metadata (title, description, image) from a URL.
 */
router.get('/link-preview', async (req: Request, res: Response) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string' || !URL_REGEX.test(url)) {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'WhatsApp/2.23.20.0',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      res.status(502).json({ error: 'Failed to fetch URL' });
      return;
    }

    const html = await response.text();
    const og: Record<string, string> = {};

    // Parse og: meta tags (both attribute orders)
    let match;
    while ((match = OG_TAG_REGEX.exec(html)) !== null) {
      og[match[1]] = match[2];
    }
    while ((match = OG_TAG_REGEX_REV.exec(html)) !== null) {
      og[match[2]] = match[1];
    }

    // Fallback to <title> if no og:title
    if (!og['og:title']) {
      const titleMatch = TITLE_REGEX.exec(html);
      if (titleMatch) og['og:title'] = titleMatch[1].trim();
    }

    res.json({
      title: og['og:title'] || null,
      description: og['og:description'] || null,
      image: og['og:image'] || null,
      siteName: og['og:site_name'] || null,
      url: og['og:url'] || url,
    });
  } catch {
    res.status(502).json({ error: 'Failed to fetch URL metadata' });
  }
});

export default router;
