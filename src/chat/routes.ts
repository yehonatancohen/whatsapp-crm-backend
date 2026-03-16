import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../shared/middleware/auth';
import { validate } from '../shared/middleware/validate';
import { ClientManager } from '../accounts/services/ClientManager';
import { NotFoundError, ValidationError } from '../shared/errors';

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

    const media = await msg.downloadMedia();
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

export default router;
