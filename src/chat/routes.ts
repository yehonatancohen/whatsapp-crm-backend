import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import { ClientManager } from '../accounts/services/ClientManager';

const router = Router();
router.use(authenticate);

// 1. Get unified conversations
router.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const manager = ClientManager.getInstance();
    // Get all accounts for user to check ownership
    const accounts = await manager.getAllAccounts(req.user!.userId, req.user!.role === 'ADMIN');
    
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

    const chat = await client.getChatById(chatId);
    if (!chat) {
       res.status(404).json({ error: 'Chat not found' });
       return;
    }

    const messages = await chat.fetchMessages({ limit });
    
    res.json(messages.map(m => ({
      id: m.id._serialized,
      body: m.body,
      fromMe: m.fromMe,
      timestamp: m.timestamp,
      type: m.type,
      ack: m.ack,
      author: m.author,
      hasMedia: m.hasMedia || false,
    })));
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
  body: z.string().min(1)
});

// 3. Send message
router.post('/:accountId/:chatId/send', validate(sendSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, chatId } = req.params;
    const { body } = req.body;

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

    const msg = await client.sendMessage(chatId, body);
    
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

    const participants = (groupChat.participants || []).map((p: any) => ({
      id: p.id._serialized,
      isAdmin: p.isAdmin || false,
      isSuperAdmin: p.isSuperAdmin || false,
    }));

    const me = participants.find((p: any) => p.id === myNumber);

    res.json({
      name: chat.name,
      description: groupChat.description || '',
      participantCount: participants.length,
      participants,
      iAmAdmin: me?.isAdmin || me?.isSuperAdmin || false,
      canAnyoneAdd: !groupChat.groupMetadata?.restrict,
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
    const canAnyoneAdd = !groupChat.groupMetadata?.restrict;

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

    // Parse results per participant
    const results: Record<string, { success: boolean; message: string; inviteSent: boolean }> = {};
    if (typeof result === 'object' && result !== null) {
      for (const [id, info] of Object.entries(result as Record<string, any>)) {
        const code = info?.code;
        results[id] = {
          success: code === 200,
          message: code === 200 ? 'Added' : code === 403 ? 'Privacy settings block adding' : code === 409 ? 'Already in group' : (info?.message || 'Failed'),
          inviteSent: info?.isInviteV4Sent || false,
        };
      }
    }

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

export default router;
