# Progress & Bug Tracker

## Status: 2026-06-19

### Deployed & Running
- Server: Oracle ARM64, 130.110.238.248
- API: https://api.parties247.co.il/api/health → `{"status":"healthy"}`
- Worker: running (`parties247-worker` container)
- Cloudflare tunnel: active (`cloudflared.service`)

### WhatsApp Accounts
All accounts currently show `QR_READY` — sessions expired while server was down.
**Action required**: scan QR codes via the frontend to re-authenticate.

---

## Bug Fixes (2026-06-19)

### Bug 1: OG image preview thumbnail missing in campaigns
**Symptom**: Messages with URLs sent via campaigns showed a link preview card (title + description) but no thumbnail image.

**Root cause**: `sendWithPreview()` in `src/warmup/linkPreview.ts` has two paths:
1. Primary: uses WA's own `getLinkPreview()` via `pupPage.evaluate` (includes server-generated thumbnail)
2. Fallback: uses OGS-scraped data — but `preview.thumbnail` (base64 JPEG) was **not included** in the WWebJS.sendMessage call

**Fix**: Added `jpegThumbnail: preview.thumbnail` to the fallback path in `sendWithPreview`.

**File changed**: `src/warmup/linkPreview.ts` (line ~192)

---

### Bug 2: DIRECT_MESSAGE campaign sends 0/N messages
**Symptom**: Starting a campaign to private contacts would immediately complete with "0 sent, N failed" — no messages delivered.

**Root cause**: `simulateFastSend()` in `src/warmup/humanDelay.ts` calls `client.getChatById(chatId)` to get the chat object for sending a typing indicator. For contacts with no existing conversation (never chatted with this number before), `getChatById` returns `null`. Calling `.sendStateTyping()` on null throws a TypeError, which is caught by the campaign worker and marks the message as FAILED.

**Fix**: Added a try/catch around the `getChatById` + `sendStateTyping` block. If the chat doesn't exist or the call fails, the typing indicator is skipped and the send proceeds normally.

**File changed**: `src/warmup/humanDelay.ts` (`simulateFastSend` function)

---

## Testing Checklist

### How to verify Bug 2 fix (private chat)
1. [ ] Authenticate at least one WhatsApp account (scan QR)
2. [ ] Create a contact list with a phone number that has NO existing chat history
3. [ ] Create a DIRECT_MESSAGE campaign with that contact list
4. [ ] Start the campaign
5. [ ] Expected: message appears as SENT (not 0/1 failed)
6. [ ] Check worker logs: `docker logs -f parties247-worker`

### How to verify Bug 1 fix (OG thumbnail)
1. [ ] Authenticate a WhatsApp account
2. [ ] Create a campaign with a message containing a URL (e.g., https://example.com)
3. [ ] Start campaign
4. [ ] On the recipient's phone: verify the link preview shows an image thumbnail
5. [ ] Check API logs for `[linkPreview] preview ready` or fallback log lines:
   `docker logs -f parties247-api | grep linkPreview`

---

## Deployment Notes

### How to rebuild & deploy after code changes
```bash
# On the oracle server:
cd /tmp
rm -rf whatsapp-crm-build
git clone https://github.com/yehonatancohen/whatsapp-crm-backend.git whatsapp-crm-build
cd whatsapp-crm-build
docker build -t yehonatancohen/whatsapp-crm-backend:latest .
docker push yehonatancohen/whatsapp-crm-backend:latest
# Watchtower will auto-restart the containers within 60 seconds
```

### If containers are down (cold start)
```bash
cd /home/ubuntu/whatsapp-crm
docker compose up -d
```

### Useful log commands
```bash
docker logs -f parties247-api    # API + WA client events
docker logs -f parties247-worker # Campaign / warmup worker
docker ps                        # Container health status
```
