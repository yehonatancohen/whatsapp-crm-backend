/**
 * vCard 3.0 string builder for the "save my number" warmup nudge.
 *
 * When an account sends a message to a recipient for the very first time,
 * we precede it with a contact card of the sender's own number. WhatsApp
 * renders this as a tappable card with a "Save contact" action — a soft
 * prompt that increases the chance the recipient saves the number, which
 * in turn is a strong positive signal to WhatsApp's trust system.
 *
 * Pass the resulting string to `client.sendMessage(chatId, vcard, { parseVCards: true })`
 * — whatsapp-web.js's injected Utils detects the `BEGIN:VCARD` prefix and
 * ships it as a real contact message rather than plain text.
 */

/** Strip to digits only — required for WA-ID and the TEL URI. */
function digits(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Build a vCard for the given E.164-ish phone number.
 *
 * @param phoneNumber The sender's own phone (may include a leading `+`).
 * @param displayName Optional name to show on the card; falls back to the number.
 */
export function buildOwnVCard(phoneNumber: string, displayName?: string): string {
  const waid = digits(phoneNumber);
  const tel = `+${waid}`;
  const fn = (displayName && displayName.trim()) || tel;

  // CRLF line endings are part of the vCard spec; WhatsApp accepts LF too
  // but CRLF is safer for downstream parsers.
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapeVCardValue(fn)}`,
    `TEL;type=CELL;type=VOICE;waid=${waid}:${tel}`,
    'END:VCARD',
  ].join('\r\n');
}

function escapeVCardValue(v: string): string {
  return v.replace(/([\\,;])/g, '\\$1').replace(/\r?\n/g, '\\n');
}
