import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { MessageMedia } from 'whatsapp-web.js';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import { ClientManager } from '../accounts/services/ClientManager';
import { logger } from '../shared/logger';

const router = Router();
router.use(authenticate);

// 1. Get unified conversations
router.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    // Get all accounts for user to check ownership
    const accounts = await manager.getAllAccounts(req.user!.userId, false);
    
    // For each authenticated account, fetch chats
    const allChats = [];
    
    for (const acc of accounts) {
      if (acc.status !== 'AUTHENTICATED') continue;
      const instance = manager.getInstanceById(acc.id);
      if (!instance) continue;
      const client = instance.getClient();
      if (!client) continue;

      try {
        const chats = await client.getChats();
        for (const chat of chats) {
          // Skip @lid (Linked Identity) chats — a WhatsApp multi-device feature
          // not supported by whatsapp-web.js; opening them would throw.
          if (chat.id._serialized.endsWith('@lid')) continue;

          allChats.push({
            accountId: acc.id,
            accountLabel: acc.label,
            chatId: chat.id._serialized,
            name: chat.name || chat.id.user,
            unreadCount: chat.unreadCount,
            timestamp: chat.timestamp,
            isGroup: chat.isGroup,
            lastMessage: chat.lastMessage ? {
              body: chat.lastMessage.body,
              timestamp: chat.lastMessage.timestamp,
              fromMe: chat.lastMessage.fromMe,
            } : null
          });
        }
      } catch (err) {
        // skip if one client fails
      }
    }

    // Sort by timestamp desc
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

    // @lid (Linked Identity) chats are a multi-device WhatsApp feature
    // not supported by whatsapp-web.js — it throws on fetchMessages.
    if (chatId.endsWith('@lid')) {
      res.status(501).json({ error: 'צ\'אט מסוג Linked Identity (@lid) אינו נתמך כרגע' });
      return;
    }

    let chat;
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

    let messages;
    try {
      const fetchPromise = chat.fetchMessages({ limit });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('fetchMessages timed out')), 20_000),
      );
      messages = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      const errMsg = (err as Error)?.message || 'unknown';
      logger.warn({ err: errMsg, chatId }, 'fetchMessages failed');
      const isTimeout = errMsg.includes('timed out');
      res.status(isTimeout ? 504 : 502).json({
        error: isTimeout ? 'הטעינה ארכה יותר מדי. נסה שוב.' : `שגיאה בטעינת הודעות: ${errMsg}`,
      });
      return;
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
        .map((m: any) => ({
          id: m.id._serialized,
          body: m.body,
          fromMe: m.fromMe,
          timestamp: m.timestamp,
          type: m.type,
          ack: m.ack,
          author: m.author,
          authorName: m.author ? nameMap[m.author as string] : undefined,
          hasMedia: m.hasMedia || false,
        })),
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
      try {
        const chat = await client.getChatById(chatId);
        const recentMsgs = await chat.fetchMessages({ limit: 200 });
        const quotedMsg = recentMsgs.find(m => m.id._serialized === quotedMessageId);
        if (quotedMsg) {
          sendOptions = { ...sendOptions, quotedMessageId: quotedMsg };
        }
      } catch {
        // ignore — send without quote if lookup fails
      }
    }

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

    const media = new MessageMedia(mimeType, data, 'voice.ogg');
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
    next(err);
  }
});

export default router;
