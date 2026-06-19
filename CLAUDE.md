# Sheder / Parties247 WhatsApp CRM — Backend

## Tech Stack
- **Runtime**: Node.js + TypeScript, compiled to `dist/`
- **Framework**: Express.js
- **WhatsApp**: whatsapp-web.js v1.34.7 + Puppeteer v24 (stealth)
- **Queue**: BullMQ + Redis
- **DB**: Prisma + PostgreSQL
- **Logger**: pino v10 (`src/shared/logger.ts`)

## Project Layout
```
src/
  accounts/          WhatsApp account management + WA client lifecycle
  campaigns/         Bulk DIRECT_MESSAGE / GROUP_MESSAGE campaigns
  promotions/        Promotions (similar to campaigns but with scheduling)
  scheduled-messages/ One-time scheduled messages
  warmup/            Bot-to-bot warmup sessions + link preview helpers
  chat/              Direct API send endpoint
  shared/            DB, Redis, Socket.IO, middleware, errors
```

## Key Send Paths
| Use-case | Entry point |
|---|---|
| Campaign / promotion bulk sends | `simulateFastSend()` in `src/warmup/humanDelay.ts` |
| Scheduled messages | `src/scheduled-messages/services/scheduledMessageWorker.ts` |
| Direct API send | `POST /api/chat/:accountId/:chatId/send` in `src/chat/routes.ts` |
| Warmup bot-to-bot | `simulateHumanSend()` in `src/warmup/humanDelay.ts` |

## Link Preview Architecture
**File**: `src/warmup/linkPreview.ts` — `sendWithPreview(client, chatId, text, opts)`

**Why custom**: `options.linkPreview = true` in WWebJS calls internal `getLinkPreview()` which never works headlessly (CORS/timing/UA issues). Must bypass it.

**Strategy**:
1. Detects first URL in message text
2. Scrapes OG metadata server-side via `open-graph-scraper` (Node, not browser)
3. Downloads + resizes `og:image` to JPEG via `sharp` / `axios`
4. Inside `pupPage.evaluate`, tries WA's own `WAWebLinkPreviewChatAction.getLinkPreview()` with 10s timeout
5. If that works → uses WA's result (server-generated thumbnail, best quality)
6. Fallback → injects OGS-scraped fields + `jpegThumbnail: base64` directly into `WWebJS.sendMessage`

**Key rule**: Always pass `linkPreview: false` to `WWebJS.sendMessage` to prevent double getLinkPreview call.

**Feature flag**: `WA_LINK_PREVIEW_ENABLED=false` disables completely.

## Account Selection for Campaigns
`src/campaigns/services/accountSelector.ts` — round-robin among AUTHENTICATED accounts that haven't hit `dailyLimitPerAccount`. Minimum warmup level: L3 (currently not enforced at DB query level — account must have status `AUTHENTICATED`).

## Campaign Worker
`src/campaigns/services/campaignWorker.ts`:
- `createCampaignProcessorWorker()` — BullMQ worker, processes one message per job
- `createCampaignSchedulerWorker()` — ticks every 60s, starts SCHEDULED campaigns when `scheduledAt` arrives
- For GROUP_MESSAGE: verifies selected account is a group admin before sending
- For DIRECT_MESSAGE: builds `${cleanPhone}@c.us` chatId

## Deployment
- **Server**: Oracle ARM64 (aarch64) at 130.110.238.248
- **Access**: `ssh -i ~/.ssh/oracle-hitnagdut.key ubuntu@130.110.238.248`
- **Domain**: https://api.parties247.co.il (Cloudflare tunnel → localhost:8080)
- **Compose**: `/home/ubuntu/whatsapp-crm/docker-compose.yml`
- **Images**: `yehonatancohen/whatsapp-crm-backend:latest` (DockerHub)
- **Build**: clone repo → `docker build` on server → `docker push` → containers pick up via Watchtower
- **WA sessions**: persisted in Docker volume `whatsapp-crm_wwebjs_auth`
- **Frontend**: https://whatsapp-crm-frontend-plum.vercel.app (Vercel)

## Testing a Campaign (Manual)
1. Log in to the frontend
2. Go to Accounts — scan QR codes to authenticate WhatsApp accounts
3. Ensure at least one account reaches `AUTHENTICATED` status
4. Create a contact list with at least one contact (phone number)
5. Create a DIRECT_MESSAGE campaign, attach the contact list
6. Start the campaign — check `parties247-worker` logs:
   `docker logs -f parties247-worker`
7. Check `parties247-api` logs for link preview details:
   `docker logs -f parties247-api`

## Known Fixed Bugs
- **OG thumbnail missing in fallback path** (fixed 2026-06-19): `sendWithPreview` fallback was omitting `jpegThumbnail` — added it to the WWebJS.sendMessage call.
- **Private-chat campaign 0 sent** (fixed 2026-06-19): `simulateFastSend` called `client.getChatById()` which returns null for contacts with no existing chat; added null-guard before `sendStateTyping()`.
