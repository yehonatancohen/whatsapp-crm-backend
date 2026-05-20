/**
 * Smoke test for the sendWithPreview / buildPreview pipeline.
 *
 * Usage:
 *   TEST_JWT=<token> TEST_ACCOUNT_ID=<id> TEST_CHAT_ID=<jid> \
 *   TEST_URL=https://example.com \
 *   npx ts-node -r dotenv/config -P tsconfig.scripts.json scripts/test-link-preview.ts
 *
 * Steps:
 *   1. Calls buildPreview() directly in Node to verify OG scraping + image resize.
 *   2. Sends the message via the /api/chat/.../send endpoint to verify end-to-end.
 *   3. Prints the resulting message ID — check the WhatsApp chat for the preview card.
 */

import { buildPreview } from '../src/warmup/linkPreview';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const JWT = process.env.TEST_JWT || '';
const ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || '';
const CHAT_ID = process.env.TEST_CHAT_ID || ''; // e.g. "972501234567@c.us"
const TEST_URL = process.env.TEST_URL || 'https://www.parties247.co.il';

async function main() {
  if (!JWT || !ACCOUNT_ID || !CHAT_ID) {
    console.error('Set TEST_JWT, TEST_ACCOUNT_ID, TEST_CHAT_ID env vars');
    process.exit(1);
  }

  // Step 1: Test buildPreview in Node
  console.log('\n=== Step 1: buildPreview (Node-side OG scraping) ===');
  console.log('Scraping:', TEST_URL);
  const t0 = Date.now();
  try {
    const preview = await buildPreview(TEST_URL);
    console.log('Title      :', preview.title || '(none)');
    console.log('Description:', preview.description?.slice(0, 80) || '(none)');
    console.log('Canonical  :', preview.canonicalUrl);
    console.log('Thumbnail  :', preview.thumbnail ? `${preview.thumbnail.length} base64 chars (${preview.thumbnailWidth}x${preview.thumbnailHeight})` : '(none — will send without image)');
    console.log('Time       :', Date.now() - t0, 'ms');
  } catch (err) {
    console.error('buildPreview failed:', (err as Error).message);
    process.exit(1);
  }

  // Step 2: Send via API
  console.log('\n=== Step 2: Sending message via API ===');
  const body = `[preview-test] ${TEST_URL}`;
  const sendRes = await fetch(
    `${API_BASE}/api/chat/${ACCOUNT_ID}/${encodeURIComponent(CHAT_ID)}/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${JWT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!sendRes.ok) {
    console.error('Send failed:', sendRes.status, await sendRes.text());
    process.exit(1);
  }

  const sendData = (await sendRes.json()) as { id: string };
  console.log('Message ID:', sendData.id);
  console.log('\nCheck WhatsApp — you should see a link preview card with the page image.');
  console.log('If the card shows text only (no thumbnail): og:image was unavailable or failed to download.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
