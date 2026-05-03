import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { MessageMedia } from 'whatsapp-web.js';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import { ClientManager } from '../accounts/services/ClientManager';
import { logger } from '../shared/logger';
import { preFetchLinkPreview } from '../warmup/humanDelay';

const router = Router();
router.use(authenticate);

// 1. Get unified conversations
router.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    const accounts = await manager.getAllAccounts(req.user!.userId, false);

    const allChats = [];

    for (const acc of accounts) {
      if (acc.status !== 'AUTHENTICATED') continue;
      const instance = manager.getInstanceById(acc.id);
      if (!instance) continue;
      const client = instance.getClient();
      if (!client) continue;

      try {
        const pupPage = (client as any).pupPage;
        if (!pupPage) continue;

        // In current WA Web (multi-device), private chats are stored as @lid
        // (Linked Identity) in the internal Store. client.getChats() explicitly
        // filters these out, so private chats never appear via that API.
        //
        // Fix: read the Store directly, resolve each @lid to its @c.us phone
        // WID via chat.contact.id._serialized, and return both groups and privates.
        const rawChats: Array<{
          chatId: string; name: string; unreadCount: number; timestamp: number;
          isGroup: boolean; resolvedFromLid: boolean;
          lastMessage: { body: string; timestamp: number; fromMe: boolean } | null;
        }> = await Promise.race([
          pupPage.evaluate(async () => {
            const g = globalThis as any;
            let ChatCollection: any;
            try { ChatCollection = g.window.require('WAWebCollections').Chat; }
            catch {
              const S = g.window?.Store ?? g.Store;
              ChatCollection = S?.Chat;
            }
            if (!ChatCollection) return [];

            // getModelsArray() returns the raw unfiltered model array including @lid.
            const models: any[] = ChatCollection.getModelsArray?.() ?? ChatCollection._models ?? [];

            const out: any[] = [];
            for (const chat of models) {
              const sid: string = chat.id?._serialized ?? '';
              if (!sid || sid.endsWith('@broadcast')) continue;

              let chatId = sid;
              let resolvedFromLid = false;

              if (sid.endsWith('@lid')) {
                // Multi-device private chat — try several paths to get @c.us WID
                const cands = [
                  chat.contact?.wid?._serialized,
                  chat.contact?.id?._serialized,
                  chat.contact?.lid?._serialized,
                  (chat as any).wid?._serialized,
                ];
                const cSid = cands.find((s: any) => typeof s === 'string' && s.endsWith('@c.us')) ?? '';
                if (cSid) {
                  chatId = cSid;
                  resolvedFromLid = true;
                }
              }

              const lm = chat.lastMessage ?? chat.msgs?.last ?? null;
              const name = chat.name || chat.formattedTitle ||
                           chat.contact?.pushname || chat.contact?.name ||
                           chat.contact?.notify || chat.id?.user || chatId;

              out.push({
                chatId,
                name,
                unreadCount: chat.unreadCount ?? 0,
                timestamp:   chat.t ?? chat.timestamp ?? 0,
                isGroup:     !!chat.isGroup || sid.endsWith('@g.us'),
                resolvedFromLid,
                lastMessage: lm ? {
                  body:      typeof lm.body === 'string' ? lm.body : '',
                  timestamp: lm.t ?? lm.timestamp ?? 0,
                  fromMe:    !!lm.id?.fromMe,
                } : null,
              });
            }
            return out;
          }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('conversations evaluate timeout')), 15_000),
          ),
        ]);

        let groupCount = 0;
        let privateCount = 0;
        let lidResolved = 0;
        for (const chat of rawChats) {
          if (chat.isGroup) groupCount++;
          else privateCount++;
          if (chat.resolvedFromLid) lidResolved++;
          allChats.push({ accountId: acc.id, accountLabel: acc.label, ...chat });
        }
        logger.info({ accountId: acc.id, groupCount, privateCount, lidResolved, total: rawChats.length }, 'conversations: loaded');
      } catch (err) {
        logger.warn({ accountId: acc.id, err: (err as Error)?.message }, 'conversations: skipping account');
      }
    }

    allChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(allChats);
  } catch (err) {
    next(err);
  }
});

// 2. Get messages for a specific chat on a specific account
router.get('/:accountId/:chatId/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }

    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    let chat = null;
    if (!chatId.endsWith('@lid')) {
      try {
        // getChatById can throw for some chat types; fall back to scanning getChats()
        chat = await client.getChatById(chatId);
      } catch {
        try {
          const chats = await client.getChats();
          chat = chats.find(c => c.id._serialized === chatId) ?? null;
        } catch (err) {
          logger.warn({ err, chatId }, 'Failed to look up chat');
          res.status(502).json({ error: 'לא ניתן לטעון את הצ\'אט. ייתכן שהחשבון אינו מסונכרן.' });
          return;
        }
      }
      if (!chat) {
        res.status(404).json({ error: 'הצ\'אט לא נמצא' });
        return;
      }
    }

    // ─── Multi-layer message fetching strategy ─────────────────────────
    // WhatsApp Web frequently changes its internal Store APIs, so we use
    // a layered approach with multiple fallbacks:
    //   Layer 1: syncHistory() + fetchMessages()   (wweb.js ≥1.28)
    //   Layer 2: fetchMessages() alone              (classic path)
    //   Layer 3: Direct Store read with warmup      (deepest fallback)
    let messages: any[] = [];

    // Helper: try syncHistory (new API in wweb.js ≥1.28) to force-load
    // messages into WhatsApp Web's internal Store before reading them.
    const trySyncHistory = async () => {
      try {
        if (typeof (client as any).syncHistory === 'function') {
          await Promise.race([
            (client as any).syncHistory(chatId),
            new Promise((_, rej) => setTimeout(() => rej(new Error('syncHistory timeout')), 8000)),
          ]);
          logger.debug({ chatId }, 'syncHistory completed');
          return true;
        }
      } catch (e) {
        logger.debug({ chatId, err: (e as Error)?.message }, 'syncHistory failed (non-fatal)');
      }
      return false;
    };

    // Helper: call fetchMessages with a timeout guard
    const tryFetchMessages = async (timeoutMs = 15_000): Promise<any[]> => {
      if (!chat) return [];
      const fetchPromise = chat.fetchMessages({ limit });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('fetchMessages timed out')), timeoutMs),
      );
      return await Promise.race([fetchPromise, timeoutPromise]);
    };

    // Helper: read messages directly from WhatsApp Web's internal Store
    const tryStoreRead = async (): Promise<any[]> => {
      const pupPage = (client as any).pupPage;
      if (!pupPage) return [];

      const rawMessages = await pupPage.evaluate(
        async (cid: string, lim: number) => {
          const g = globalThis as any;
          const S = g.Store;
          if (!S?.Chat) return { msgs: [], debug: 'no Store.Chat' };

          let storeChat = S.Chat.get(cid);
          
          // If it's an @lid chat, messages are often stored under the @c.us chat object.
          // Let's try to resolve it.
          if (cid.endsWith('@lid')) {
            const allContacts = S.Contact?.getModelsArray?.() ?? [];
            const contact = allContacts.find((c: any) => c.lid?._serialized === cid || c.id?._serialized === cid);
            if (contact) {
              const cUsId = [contact.id?._serialized, contact.wid?._serialized].find((s: string) => s?.endsWith('@c.us'));
              if (cUsId) {
                const cUsChat = S.Chat.get(cUsId);
                if (cUsChat) {
                  cid = cUsId;
                  storeChat = cUsChat;
                }
              }
            }
          }

          if (!storeChat) return { msgs: [], debug: 'chat not in Store' };

          // Warm-up: try every known WhatsApp Web internal API to force-load
          // the chat's message list. WA changes these between versions so we
          // try many approaches and keep track of what worked.
          const warmupResults: string[] = [];
          const warmupApproaches: Array<[string, () => any]> = [
            ['openChatBottom', () => S.Cmd?.openChatBottom?.(storeChat)],
            ['ConversationMsgs.loadMoreMsgs', () => S.ConversationMsgs?.loadMoreMsgs?.(storeChat, { count: lim })],
            ['loadEarlierMsgs', () => storeChat.loadEarlierMsgs?.()],
            ['msgs.fetchPage', () => storeChat.msgs?.fetchPage?.({ count: lim })],
            ['ChatLoad.loadAllMsgs', () => S.ChatLoad?.loadAllMsgs?.(storeChat)],
            ['Msg.find', () => S.Msg?.find?.(cid)],
            ['openChatAt', () => S.Cmd?.openChatAt?.(storeChat, storeChat.t || Date.now() / 1000)],
            ['loadMoreMsgsEarlier', () => storeChat.loadMoreMsgsEarlier?.()],
            ['msgs.loadMore', () => storeChat.msgs?.loadMore?.()],
          ];

          for (const [name, approach] of warmupApproaches) {
            try {
              const result = approach();
              if (result && typeof result.then === 'function') {
                await Promise.race([
                  result,
                  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
                ]);
              }
              warmupResults.push(`${name}:ok`);
            } catch (e: any) {
              warmupResults.push(`${name}:${e?.message || 'fail'}`);
            }
          }

          // Give the store time to settle after warm-up
          await new Promise((r) => setTimeout(r, 2000));

          // Try multiple ways to access the message collection
          let models: any[] =
            storeChat.msgs?.getModels?.() ??
            storeChat.msgs?._models ??
            storeChat.msgs?.models ??
            (Array.isArray(storeChat.msgs) ? storeChat.msgs : []);

          // If still empty, try one more time after additional delay
          if (models.length === 0) {
            await new Promise((r) => setTimeout(r, 2000));
            models =
              storeChat.msgs?.getModels?.() ??
              storeChat.msgs?._models ??
              storeChat.msgs?.models ??
              [];
          }

          const result: any[] = [];
          for (const msg of models) {
            if (!msg?.id?._serialized) continue;
            try {
              const qm = msg._data?.quotedMsg ?? null;
              result.push({
                id: { _serialized: msg.id._serialized, fromMe: !!msg.id.fromMe },
                body: msg.body ?? '',
                fromMe: !!msg.id.fromMe,
                timestamp: msg.t ?? 0,
                type: msg.type ?? 'chat',
                hasMedia: !!(msg.hasMedia || msg.clientUrl || msg.mediaData),
                author: msg.author ?? undefined,
                ack: msg.ack ?? 0,
                quotedMsg: qm ? { body: qm.body ?? '', fromMe: !!qm.fromMe, author: qm.author ?? undefined } : undefined,
              });
            } catch { /* skip corrupt messages */ }
          }

          return {
            msgs: result.slice(-Math.abs(lim)),
            debug: `warmup=[${warmupResults.join(',')}] models=${models.length} results=${result.length}`,
          };
        },
        chatId,
        limit,
      );

      if (rawMessages?.debug) {
        logger.info({ chatId, storeDebug: rawMessages.debug }, 'Store read diagnostics');
      }
      return rawMessages?.msgs ?? [];
    };

    // ─── Execute layered strategy ────────────────────────────────────
    try {
      // Layer 1: sync + fetch
      await trySyncHistory();
      if (chat) {
        try {
          messages = await tryFetchMessages();
        } catch (fetchErr) {
          const errMsg = (fetchErr as Error)?.message || 'unknown';
          if (errMsg.includes('timed out')) {
            logger.warn({ chatId }, 'fetchMessages timed out');
          } else {
            logger.warn({ chatId, err: errMsg }, 'fetchMessages threw error');
          }
        }
      }

      // Layer 2: if empty, retry fetchMessages after a short delay
      // (gives WA Web time to populate the store after syncHistory)
      if (chat && (!messages || messages.length === 0) && chat.lastMessage) {
        logger.info({ chatId }, 'fetchMessages returned empty — retrying after delay');
        await new Promise(r => setTimeout(r, 2000));
        try {
          messages = await tryFetchMessages(10_000);
        } catch {
          // fall through to Layer 3
        }
      }

      // Layer 3: Direct Store read (deepest fallback)
      if (!messages || messages.length === 0) {
        logger.info({ chatId }, 'fetchMessages still empty — falling back to direct Store read');
        try {
          messages = await tryStoreRead();
        } catch (storeErr) {
          const storeErrMsg = (storeErr as Error)?.message || 'unknown';
          logger.warn({ err: storeErrMsg, chatId }, 'Store read failed');
        }
      }

      // Layer 4: Last resort — if everything failed but the chat has messages,
      // do a syncHistory + longer wait + final fetchMessages attempt
      if (chat && (!messages || messages.length === 0)) {
        logger.info({ chatId }, 'All approaches empty — final retry with extended delay');
        await trySyncHistory();
        await new Promise(r => setTimeout(r, 3000));
        try {
          messages = await tryFetchMessages(12_000);
        } catch {
          // give up
        }
      }

      logger.info({ chatId, count: messages?.length ?? 0 }, 'Messages fetched');
    } catch (outerErr) {
      const outerErrMsg = (outerErr as Error)?.message || 'unknown';
      if (outerErrMsg.includes('frame was detached') || outerErrMsg.includes('Session closed') || outerErrMsg.includes('Target closed')) {
        res.status(502).json({ error: 'חיבור הוואטסאפ נותק. נסה שוב.' });
        return;
      }
      logger.error({ err: outerErrMsg, chatId }, 'Unexpected error fetching messages');
      messages = [];
    }


    // Resolve contact names for unique authors (group chats) — cap at 10 to avoid timeout
    const authorIds = [...new Set(
      messages.filter((m: any) => m.author && !m.fromMe).map((m: any) => m.author as string)
    )].slice(0, 10);
    const nameMap: Record<string, string | undefined> = {};
    if (authorIds.length > 0) {
      await Promise.allSettled(
        authorIds.map(async (authorId) => {
          try {
            const contact = await client.getContactById(authorId);
            const name = contact.name || contact.pushname;
            if (name) nameMap[authorId] = name;
          } catch { /* ignore */ }
        }),
      );
    }

    res.json(
      messages
        .filter((m: any) => m.id?._serialized)
        .map((m: any) => {
          const qm = m._data?.quotedMsg ?? m.quotedMsg ?? null;
          return {
            id: m.id._serialized,
            body: m.body,
            fromMe: m.fromMe,
            timestamp: m.timestamp,
            type: m.type,
            ack: m.ack,
            author: m.author,
            authorName: m.author ? nameMap[m.author as string] : undefined,
            hasMedia: m.hasMedia || false,
            quotedMsg: qm ? {
              body: qm.body ?? '',
              fromMe: !!qm.fromMe,
              author: qm.author ?? qm.participant ?? undefined,
            } : undefined,
          };
        }),
    );
  } catch (err) {
    next(err);
  }
});

// 2b. Download media for a specific message
router.get('/:accountId/:chatId/messages/:messageId/media', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId, messageId } = req.params;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }

    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    const chat = await client.getChatById(chatId);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }

    // Fetch recent messages to find the target
    const messages = await chat.fetchMessages({ limit: 200 });
    const msg = messages.find(m => m.id._serialized === messageId);
    if (!msg || !msg.hasMedia) {
      res.status(404).json({ error: 'Media message not found' });
      return;
    }

    // Timeout wrapper to avoid puppeteer hanging indefinitely
    const mediaPromise = msg.downloadMedia();
    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error('Media download timed out')), 30_000),
    );

    let media;
    try {
      media = await Promise.race([mediaPromise, timeoutPromise]);
    } catch {
      res.status(504).json({ error: 'Media download timed out. Try again later.' });
      return;
    }

    if (!media) {
      res.status(404).json({ error: 'Media not available' });
      return;
    }

    const buffer = Buffer.from(media.data, 'base64');
    res.set('Content-Type', media.mimetype);
    res.set('Content-Length', String(buffer.length));
    if (media.filename) {
      res.set('Content-Disposition', `inline; filename="${media.filename}"`);
    }
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

const sendSchema = z.object({
  body: z.string().min(1),
  quotedMessageId: z.string().optional(),
});

// 3. Send message
router.post('/:accountId/:chatId/send', validate(sendSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;
    const { body, quotedMessageId } = req.body;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }

    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    let sendOptions: Record<string, unknown> = { linkPreview: true };
    if (quotedMessageId) {
      // whatsapp-web.js sendMessage accepts quotedMessageId as a string ID;
      // it resolves the message via getMessageById internally.
      sendOptions = { ...sendOptions, quotedMessageId };
    }

    // Pre-fetch link preview so WA servers have OG metadata cached before send
    await preFetchLinkPreview(client, body);

    const msg = await client.sendMessage(chatId, body, sendOptions);

    res.json({
      id: msg.id._serialized,
      body: msg.body,
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      type: msg.type,
      ack: msg.ack
    });
  } catch (err) {
    logger.error({
      route: 'send',
      accountId: req.params.accountId,
      chatId: req.params.chatId,
      bodyLen: req.body?.body?.length,
      quotedMessageId: req.body?.quotedMessageId,
      err: (err as Error)?.message,
      stack: (err as Error)?.stack,
    }, 'send: text message failed');
    next(err);
  }
});

// 3b. Mark chat as seen
router.post('/:accountId/:chatId/seen', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }

    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    const chat = await client.getChatById(chatId);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }

    await chat.sendSeen();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// 3c. Delete a message (for everyone)
router.delete('/:accountId/:chatId/messages/:messageId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId, messageId } = req.params;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }

    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    const chat = await client.getChatById(chatId);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }

    const messages = await chat.fetchMessages({ limit: 200 });
    const msg = messages.find(m => m.id._serialized === messageId);
    if (!msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    await msg.delete(true);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// 4. Get group info (participants, settings)
router.get('/:accountId/:chatId/group-info', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }

    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    const chat = await client.getChatById(chatId);
    if (!chat || !chat.isGroup) {
      res.status(400).json({ error: 'Not a group chat' });
      return;
    }

    const groupChat = chat as any; // GroupChat type
    const myNumber = client.info?.wid?._serialized;

    // Resolve contact names in parallel
    const rawParticipants = groupChat.participants || [];
    const participants = await Promise.all(
      rawParticipants.map(async (p: any) => {
        const pid = p.id._serialized;
        let name: string | undefined;
        try {
          const contact = await client.getContactById(pid);
          name = contact.name || contact.pushname || undefined;
        } catch { /* ignore */ }
        return {
          id: pid,
          name,
          isAdmin: p.isAdmin || false,
          isSuperAdmin: p.isSuperAdmin || false,
        };
      }),
    );

    const me = participants.find((p) => p.id === myNumber);

    res.json({
      name: chat.name,
      description: groupChat.description || '',
      participantCount: participants.length,
      participants,
      iAmAdmin: me?.isAdmin || me?.isSuperAdmin || false,
      canAnyoneAdd: groupChat.groupMetadata?.memberAddMode === 'all_member_add',
      settings: {
        messagesAdminsOnly: !!groupChat.groupMetadata?.announce,
        infoAdminsOnly: !!groupChat.groupMetadata?.restrict,
        addMembersAdminsOnly: groupChat.groupMetadata?.memberAddMode === 'admin_add',
      },
    });
  } catch (err) {
    next(err);
  }
});

// 5. Add participants to a group
const addParticipantsSchema = z.object({
  phoneNumbers: z.array(z.string().min(1)).min(1).max(5),
});

router.post('/:accountId/:chatId/add-participants', validate(addParticipantsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;
    const { phoneNumbers } = req.body;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }

    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    const chat = await client.getChatById(chatId);
    if (!chat || !chat.isGroup) {
      res.status(400).json({ error: 'Not a group chat' });
      return;
    }

    const groupChat = chat as any;
    const myNumber = client.info?.wid?._serialized;
    const participants = groupChat.participants || [];
    const me = participants.find((p: any) => p.id._serialized === myNumber);
    const iAmAdmin = me?.isAdmin || me?.isSuperAdmin || false;
    const canAnyoneAdd = groupChat.groupMetadata?.memberAddMode === 'all_member_add';

    if (!iAmAdmin && !canAnyoneAdd) {
      res.status(403).json({ error: 'Only admins can add participants to this group' });
      return;
    }

    // Format phone numbers to WhatsApp IDs (e.g., "972501234567" → "972501234567@c.us")
    const participantIds = phoneNumbers.map((num: string) => {
      const cleaned = num.replace(/[\s\-\+\(\)]/g, '');
      return cleaned.includes('@') ? cleaned : `${cleaned}@c.us`;
    });

    // Use slow delays between adds to reduce ban risk (1.5-3 seconds)
    let result;
    try {
      result = await groupChat.addParticipants(participantIds, {
        sleep: [1500, 3000],
        autoSendInviteV4: true,
        comment: '',
      });
    } catch {
      res.status(502).json({ error: 'WhatsApp failed to add participants. The group or numbers may be restricted. Try again later.' });
      return;
    }

    // whatsapp-web.js returns a string error when preconditions fail (e.g. not admin)
    if (typeof result === 'string') {
      logger.warn({ result }, 'addParticipants returned error string');
      res.status(400).json({ error: result });
      return;
    }

    // Parse results per participant
    // whatsapp-web.js returns: { 'number@c.us': { code: number, message: string, isInviteV4Sent: boolean } }
    const results: Record<string, { success: boolean; message: string; inviteSent: boolean }> = {};
    if (typeof result === 'object' && result !== null) {
      for (const [id, info] of Object.entries(result as Record<string, any>)) {
        const code = info?.code;
        results[id] = {
          success: code === 200,
          message: code === 200 ? 'Added'
            : code === 403 ? 'Privacy settings - invite sent instead'
              : code === 404 ? 'Number not on WhatsApp'
                : code === 408 ? 'Recently left the group'
                  : code === 409 ? 'Already in group'
                    : code === 417 ? 'Cannot add to community'
                      : code === 419 ? 'Group is full'
                        : (info?.message || `Error code: ${code}`),
          inviteSent: info?.isInviteV4Sent || false,
        };
      }
    }

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// ─── Group admin helper: verify admin status ──────────────────────────
async function getAdminGroupChat(req: Request, res: Response) {
  const { accountId, chatId } = req.params;
  const manager = ClientManager.getInstance();
  const instance = manager.getInstanceById(accountId);
  if (!instance || instance.status !== 'AUTHENTICATED') {
    res.status(400).json({ error: 'Account not authenticated' });
    return null;
  }
  const client = instance.getClient();
  if (!client) {
    res.status(400).json({ error: 'WhatsApp client not ready' });
    return null;
  }
  const chat = await client.getChatById(chatId);
  if (!chat || !chat.isGroup) {
    res.status(400).json({ error: 'Not a group chat' });
    return null;
  }
  const groupChat = chat as any;
  const myNumber = client.info?.wid?._serialized;
  const me = (groupChat.participants || []).find((p: any) => p.id._serialized === myNumber);
  if (!me?.isAdmin && !me?.isSuperAdmin) {
    res.status(403).json({ error: 'You must be a group admin' });
    return null;
  }
  return groupChat;
}

// 6. Promote participants to admin
router.post('/:accountId/:chatId/promote', validate(z.object({ participantIds: z.array(z.string().min(1)).min(1).max(10) })), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupChat = await getAdminGroupChat(req, res);
    if (!groupChat) return;
    try {
      await groupChat.promoteParticipants(req.body.participantIds);
    } catch {
      res.status(502).json({ error: 'Failed to promote participants' });
      return;
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// 7. Demote participants from admin
router.post('/:accountId/:chatId/demote', validate(z.object({ participantIds: z.array(z.string().min(1)).min(1).max(10) })), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupChat = await getAdminGroupChat(req, res);
    if (!groupChat) return;
    try {
      await groupChat.demoteParticipants(req.body.participantIds);
    } catch {
      res.status(502).json({ error: 'Failed to demote participants' });
      return;
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// 8. Remove participants from group
router.post('/:accountId/:chatId/remove-participants', validate(z.object({ participantIds: z.array(z.string().min(1)).min(1).max(10) })), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupChat = await getAdminGroupChat(req, res);
    if (!groupChat) return;
    try {
      await groupChat.removeParticipants(req.body.participantIds);
    } catch {
      res.status(502).json({ error: 'Failed to remove participants' });
      return;
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// 9. Update group settings (admin only)
const groupSettingsSchema = z.object({
  subject: z.string().min(1).max(100).optional(),
  description: z.string().max(512).optional(),
  messagesAdminsOnly: z.boolean().optional(),
  infoAdminsOnly: z.boolean().optional(),
  addMembersAdminsOnly: z.boolean().optional(),
});

router.patch('/:accountId/:chatId/group-settings', validate(groupSettingsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupChat = await getAdminGroupChat(req, res);
    if (!groupChat) return;

    const { subject, description, messagesAdminsOnly, infoAdminsOnly, addMembersAdminsOnly } = req.body;
    const results: Record<string, boolean> = {};

    try {
      if (subject !== undefined) results.subject = await groupChat.setSubject(subject);
      if (description !== undefined) results.description = await groupChat.setDescription(description);
      if (messagesAdminsOnly !== undefined) results.messagesAdminsOnly = await groupChat.setMessagesAdminsOnly(messagesAdminsOnly);
      if (infoAdminsOnly !== undefined) results.infoAdminsOnly = await groupChat.setInfoAdminsOnly(infoAdminsOnly);
      if (addMembersAdminsOnly !== undefined) results.addMembersAdminsOnly = await groupChat.setAddMembersAdminsOnly(addMembersAdminsOnly);
    } catch {
      res.status(502).json({ error: 'Failed to update some group settings', results });
      return;
    }

    res.json({ success: true, results });
  } catch (err) { next(err); }
});

// 10. Get group invite link (admin only)
router.get('/:accountId/:chatId/invite-link', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }
    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    const chat = await client.getChatById(chatId);
    if (!chat || !chat.isGroup) {
      res.status(400).json({ error: 'Not a group chat' });
      return;
    }

    const groupChat = chat as any;
    try {
      const inviteCode = await groupChat.getInviteCode();
      res.json({ inviteLink: `https://chat.whatsapp.com/${inviteCode}` });
    } catch {
      res.status(502).json({ error: 'Failed to get invite link. You may need to be a group admin.' });
    }
  } catch (err) {
    next(err);
  }
});

// 11. Join a group via invite link
router.post('/:accountId/join-group', validate(z.object({ inviteLink: z.string().min(1) })), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId } = req.params;
    const { inviteLink } = req.body;

    const match = (inviteLink as string).match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    if (!match) {
      res.status(400).json({ error: 'Invalid WhatsApp group invite link' });
      return;
    }
    const inviteCode = match[1];

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }
    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    try {
      const chatId = await (client as any).acceptInvite(inviteCode);
      res.json({ success: true, chatId });
    } catch {
      res.status(502).json({ error: 'Failed to join group. The link may be invalid or expired.' });
    }
  } catch (err) {
    next(err);
  }
});

// 12. Send image
const sendImageSchema = z.object({
  data: z.string().min(1),     // base64 encoded image
  mimeType: z.string().min(1),
  caption: z.string().optional(),
});

router.post('/:accountId/:chatId/send-image', validate(sendImageSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;
    const { data, mimeType, caption } = req.body;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }
    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    const media = new MessageMedia(mimeType, data);
    const sendOptions: Record<string, unknown> = {};
    if (caption) sendOptions.caption = caption;

    const msg = await client.sendMessage(chatId, media, sendOptions);

    res.json({
      id: msg.id._serialized,
      body: msg.body || '',
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      type: msg.type,
      ack: msg.ack,
      hasMedia: true,
    });
  } catch (err) {
    logger.error({
      route: 'send-image',
      accountId: req.params.accountId,
      chatId: req.params.chatId,
      mimeType: req.body?.mimeType,
      dataLen: req.body?.data?.length,
      hasCaption: !!req.body?.caption,
      err: (err as Error)?.message,
      stack: (err as Error)?.stack,
    }, 'send: image failed');
    next(err);
  }
});

// 13. Get profile picture URL for a chat
router.get('/:accountId/:chatId/profile-pic', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.json({ url: null });
      return;
    }
    const client = instance.getClient();
    if (!client) {
      res.json({ url: null });
      return;
    }

    let url: string | null = null;
    try {
      const contact = await client.getContactById(chatId);
      const picUrl = await contact.getProfilePicUrl();
      url = picUrl || null;
    } catch { /* no profile pic */ }

    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// 14. Send voice message (PTT)
const sendVoiceSchema = z.object({
  data: z.string().min(1),     // base64 encoded audio
  mimeType: z.string().min(1),
});

router.post('/:accountId/:chatId/send-voice', validate(sendVoiceSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;
    const { data, mimeType } = req.body;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }
    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    // Use the filename extension that matches the actual container format.
    // Chrome records as audio/webm;codecs=opus — WA Web handles it natively.
    const filename = mimeType.includes('webm') ? 'voice.webm' : 'voice.ogg';
    const media = new MessageMedia(mimeType, data, filename);
    const msg = await client.sendMessage(chatId, media, { sendAudioAsVoice: true } as any);

    res.json({
      id: msg.id._serialized,
      body: msg.body || '',
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      type: 'ptt',
      ack: msg.ack,
      hasMedia: true,
    });
  } catch (err) {
    logger.error({
      route: 'send-voice',
      accountId: req.params.accountId,
      chatId: req.params.chatId,
      mimeType: req.body?.mimeType,
      dataLen: req.body?.data?.length,
      err: (err as Error)?.message,
      stack: (err as Error)?.stack,
    }, 'send: voice failed');
    next(err);
  }
});

// ─── Diagnostic endpoint: test message fetching approaches ─────────
// Returns detailed diagnostics about which message fetching strategies work
// for a given chat, without modifying state.
router.get('/:accountId/:chatId/messages/debug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;

    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (!instance || instance.status !== 'AUTHENTICATED') {
      res.status(400).json({ error: 'Account not authenticated' });
      return;
    }
    const client = instance.getClient();
    if (!client) {
      res.status(400).json({ error: 'WhatsApp client not ready' });
      return;
    }

    const results: Record<string, any> = {
      chatId,
      limit,
      wwejsVersion: null,
      hasSyncHistory: typeof (client as any).syncHistory === 'function',
      hasPupPage: !!(client as any).pupPage,
    };

    // Check wweb.js version
    try {
      results.wwejsVersion = require('whatsapp-web.js/package.json').version;
    } catch { results.wwejsVersion = 'unknown'; }

    // Try getChatById
    let chat: any = null;
    try {
      chat = await client.getChatById(chatId);
      results.chatFound = true;
      results.chatHasLastMessage = !!chat.lastMessage;
      results.chatLastMessageBody = chat.lastMessage?.body?.slice(0, 50) || null;
    } catch (e) {
      results.chatFound = false;
      results.chatError = (e as Error)?.message;
      res.json(results);
      return;
    }

    // Try syncHistory
    if (results.hasSyncHistory) {
      try {
        const syncResult = await Promise.race([
          (client as any).syncHistory(chatId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        results.syncHistory = { success: true, result: syncResult };
      } catch (e) {
        results.syncHistory = { success: false, error: (e as Error)?.message };
      }
    }

    // Try fetchMessages
    try {
      const msgs = await Promise.race([
        chat.fetchMessages({ limit }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);
      results.fetchMessages = {
        count: msgs?.length ?? 0,
        firstMsg: msgs?.[0] ? { body: msgs[0].body?.slice(0, 50), fromMe: msgs[0].fromMe, timestamp: msgs[0].timestamp } : null,
        lastMsg: msgs?.length > 0 ? { body: msgs[msgs.length - 1].body?.slice(0, 50), fromMe: msgs[msgs.length - 1].fromMe, timestamp: msgs[msgs.length - 1].timestamp } : null,
      };
    } catch (e) {
      results.fetchMessages = { count: 0, error: (e as Error)?.message };
    }

    // Try Store read
    try {
      const pupPage = (client as any).pupPage;
      if (pupPage) {
        const storeResult = await pupPage.evaluate(
          (cid: string) => {
            const S = (globalThis as any).Store;
            const info: any = {
              hasStore: !!S,
              hasChat: !!S?.Chat,
              hasCmd: !!S?.Cmd,
              hasConversationMsgs: !!S?.ConversationMsgs,
              hasChatLoad: !!S?.ChatLoad,
              hasMsg: !!S?.Msg,
            };
            if (S?.Chat) {
              const chat = S.Chat.get(cid);
              info.chatInStore = !!chat;
              if (chat) {
                info.hasMsgs = !!chat.msgs;
                info.hasGetModels = typeof chat.msgs?.getModels === 'function';
                info.hasModelsArray = Array.isArray(chat.msgs?._models);
                info.modelsCount = chat.msgs?.getModels?.()?.length ?? chat.msgs?._models?.length ?? 0;
                info.hasLoadEarlierMsgs = typeof chat.loadEarlierMsgs === 'function';
                info.hasFetchPage = typeof chat.msgs?.fetchPage === 'function';
              }
            }
            return info;
          },
          chatId,
        );
        results.storeInfo = storeResult;
      }
    } catch (e) {
      results.storeInfo = { error: (e as Error)?.message };
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

// ─── Temporary: inspect @lid chat model structure ──────────────────────────
// Usage (from inside the container):
//   curl -s "http://localhost:3001/api/chat/debug/lid-structure?secret=lid123" | jq .
// Remove this endpoint once @lid resolution is working.
router.get('/debug/lid-structure', async (req: Request, res: Response, next: NextFunction) => {
  if (req.query.secret !== 'lid123') { res.status(403).json({ error: 'forbidden' }); return; }
  try {
    const manager = ClientManager.getInstance();
    const results: any[] = [];
    const accounts = manager.getAllInstances();
    for (const instance of accounts) {
      if (instance.status !== 'AUTHENTICATED') continue;
      const client = instance.getClient();
      if (!client) continue;
      const pupPage = (client as any).pupPage;
      if (!pupPage) continue;

      const dump = await pupPage.evaluate(() => {
        const g = globalThis as any;
        let ChatCol: any;
        try { ChatCol = g.window.require('WAWebCollections').Chat; } catch { ChatCol = null; }
        const S = g.window?.Store ?? g.Store;

        const allSources: Record<string, any[]> = {
          'WAWebCollections.getModelsArray': (() => { try { return ChatCol?.getModelsArray?.() ?? []; } catch { return []; } })(),
          'WAWebCollections._models':        (() => { try { return ChatCol?._models ?? []; } catch { return []; } })(),
          'Store.Chat._models':              (() => { try { return S?.Chat?._models ?? []; } catch { return []; } })(),
          'Store.Chat.models':               (() => { try { return S?.Chat?.models ?? []; } catch { return []; } })(),
        };

        const out: any = { sources: {} };
        for (const [src, models] of Object.entries(allSources)) {
          const lids = (models as any[]).filter((m: any) => (m?.id?._serialized ?? '').endsWith('@lid'));
          out.sources[src] = { total: (models as any[]).length, lidCount: lids.length };
        }

        // Pick first @lid from whichever source has some
        const allModels = allSources['WAWebCollections.getModelsArray'].length
          ? allSources['WAWebCollections.getModelsArray']
          : allSources['Store.Chat._models'];

        const sampleLid = (allModels as any[]).find((m: any) => (m?.id?._serialized ?? '').endsWith('@lid'));
        if (sampleLid) {
          const peek = (v: any, depth = 0): any => {
            if (v === null || v === undefined) return v;
            if (typeof v !== 'object') return v;
            if (depth > 1) return `[object keys:${Object.keys(v).slice(0,8).join(',')}]`;
            const r: any = {};
            for (const k of Object.keys(v).slice(0, 20)) {
              try { r[k] = peek((v as any)[k], depth + 1); } catch { r[k] = '[err]'; }
            }
            return r;
          };
          out.sampleLid = {
            'id':              peek(sampleLid.id),
            'contact':         peek(sampleLid.contact),
            'contact.id':      peek(sampleLid.contact?.id),
            'contact.wid':     peek(sampleLid.contact?.wid),
            'contact.lid':     peek(sampleLid.contact?.lid),
            'contact.type':    sampleLid.contact?.type,
            'name':            sampleLid.name,
            'formattedTitle':  sampleLid.formattedTitle,
            'topKeys':         Object.keys(sampleLid).slice(0, 40),
          };
        } else {
          out.sampleLid = null;
        }
        return out;
      });

      results.push({ accountId: instance.id, ...dump });
    }
    res.json(results);
  } catch (err) {
    next(err);
  }
});

export default router;
