import { Worker } from 'bullmq';
import { redis } from '../../shared/redis';
import { logger } from '../../shared/logger';
import { ClientManager } from '../../accounts/services/ClientManager';
import { processDueMessages } from './scheduledMessageService';

const connection = redis as any;

export function createScheduledMessageWorker() {
  const worker = new Worker(
    'scheduled-message-scheduler',
    async () => {
      const sendFn = async (accountId: string, chatId: string, body: string) => {
        const manager = ClientManager.getInstance();
        const instance = manager.getInstanceById(accountId);
        if (!instance || instance.status !== 'AUTHENTICATED') {
          throw new Error('Account not authenticated');
        }
        const client = instance.getClient();
        if (!client) throw new Error('WhatsApp client not ready');
        await client.sendMessage(chatId, body);
      };

      const count = await processDueMessages(sendFn);
      if (count > 0) {
        logger.info({ count }, 'Processed scheduled messages');
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Scheduled message scheduler job failed');
  });

  return worker;
}
