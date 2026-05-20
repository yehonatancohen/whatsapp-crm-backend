/**
 * Diagnostic script: tests whether the link preview mechanism works for a given URL.
 *
 * Usage:
 *   npx ts-node -e "require('./scripts/test-link-preview')"
 *   OR set TEST_JWT, TEST_ACCOUNT_ID, TEST_CHAT_ID, TEST_URL in env and run.
 *
 * What it does:
 *   1. Calls the /api/utils/link-preview endpoint to verify OG tag parsing
 *   2. Sends a test message with the URL to the specified chat
 *   3. Logs the result so you can check if the preview showed up
 */

const API_BASE = process.env.API_BASE || 'https://api.parties247.co.il';
const JWT = process.env.TEST_JWT || '';
const ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || '';
const CHAT_ID = process.env.TEST_CHAT_ID || '';  // e.g. "972501234567@c.us" or group JID
const TEST_URL = process.env.TEST_URL || 'https://www.parties247.co.il/event/21-5';

async function main() {
  if (!JWT || !ACCOUNT_ID || !CHAT_ID) {
    console.error('Set TEST_JWT, TEST_ACCOUNT_ID, TEST_CHAT_ID env vars');
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${JWT}`,
    'Content-Type': 'application/json',
  };

  // Step 1: Check OG parsing
  console.log('\n=== Step 1: OG tag parsing ===');
  const ogRes = await fetch(`${API_BASE}/api/utils/link-preview?url=${encodeURIComponent(TEST_URL)}`, { headers });
  const ogData = await ogRes.json();
  console.log(JSON.stringify(ogData, null, 2));

  if (!ogData.image) {
    console.warn('⚠  No og:image found — link preview will have no thumbnail even if WhatsApp shows a card');
  } else {
    console.log('✓ og:image URL:', ogData.image);
  }

  // Step 2: Send the test message
  console.log('\n=== Step 2: Sending test message ===');
  const body = `[TEST] Link preview check: ${TEST_URL}`;
  const sendRes = await fetch(`${API_BASE}/api/chat/${ACCOUNT_ID}/${encodeURIComponent(CHAT_ID)}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
  });

  if (!sendRes.ok) {
    console.error('Send failed:', sendRes.status, await sendRes.text());
    process.exit(1);
  }

  const sendData = await sendRes.json();
  console.log('Message sent, id:', sendData.id);
  console.log('Check the WhatsApp chat to see if the image preview appeared.');
  console.log('\nExpected: a link preview card with the event image thumbnail.');
  console.log('If only text or a card without image: preFetchLinkPreview is not caching the thumbnail in time.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
