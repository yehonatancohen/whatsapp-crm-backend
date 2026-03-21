import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { config } from './config';
import { prisma } from './shared/db';
import { logger } from './shared/logger';
import { errorHandler } from './shared/errors';
import { initSocket } from './shared/socket';
import { authLimiter, apiLimiter } from './shared/middleware/rateLimiter';
import { authenticate } from './shared/middleware/auth';
import { requireVerified } from './shared/middleware/requireVerified';
import { requireActiveSubscription } from './shared/middleware/requireSubscription';
import { requestLogger } from './shared/middleware/requestLogger';
import { validateEnv } from './shared/utils/validateEnv';

// Routes
import authRouter from './auth/routes';
import accountsRouter from './accounts/routes';
import contactsRouter from './contacts/routes';
import warmupRouter from './warmup/routes';
import usersRouter from './users/routes';
import activityRouter from './activity/routes';
import campaignsRouter from './campaigns/routes';
import chatRouter from './chat/routes';
import promotionsRouter from './promotions/routes';
import groupCollectionsRouter from './group-collections/routes';
import subscriptionsRouter from './subscriptions/routes';
import linkPreviewRouter from './shared/routes/linkPreview';
// import stripeWebhookRouter from './subscriptions/webhookRoute';

// Services
import { ClientManager } from './accounts/services/ClientManager';
import { createCycleWorker } from './warmup/warmupWorker';
import { createCampaignProcessorWorker, createCampaignSchedulerWorker } from './campaigns/services/campaignWorker';
import { campaignSchedulerQueue } from './campaigns/campaignQueue';
import { createPromotionProcessorWorker } from './promotions/services/promotionWorker';
import { createPromotionSchedulerWorker } from './promotions/services/promotionScheduler';
import { promotionSchedulerQueue } from './promotions/promotionQueue';

// Validate environment variables
validateEnv();

const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO
initSocket(httpServer);

// Middleware
app.set('trust proxy', 1);

// CORS must be before helmet and other middleware for preflight to work reliably
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, or same-origin)
    if (!origin) {
      return callback(null, true);
    }

    const allowedOrigins = config.corsOrigin;
    const isAllowed = allowedOrigins.includes(origin) || 
                     allowedOrigins.includes('*') ||
                     origin.endsWith('.parties247.co.il') ||
                     origin === 'https://parties247.co.il';

    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn({ origin, allowedOrigins }, 'CORS blocked');
      callback(null, false); // Don't throw error, just don't set CORS headers
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
}));

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false, // Disable CSP for now if it interferes
}));

app.use(requestLogger);

// Stripe webhook needs raw body BEFORE json parser
// app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }), stripeWebhookRouter);

app.use(express.json());

// Rate limiting
app.use('/api/auth', authLimiter);
app.use('/api/', apiLimiter);

// Routes — auth, users (admin), activity, subscriptions don't require verified email
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/activity', activityRouter);
app.use('/api/subscriptions', subscriptionsRouter);

// Resource routes require verified email + active subscription
app.use('/api/accounts', authenticate, requireVerified, requireActiveSubscription, accountsRouter);
app.use('/api/contacts', authenticate, requireVerified, requireActiveSubscription, contactsRouter);
app.use('/api/warmup', authenticate, requireVerified, requireActiveSubscription, warmupRouter);
app.use('/api/campaigns', authenticate, requireVerified, requireActiveSubscription, campaignsRouter);
app.use('/api/chat', authenticate, requireVerified, requireActiveSubscription, chatRouter);
app.use('/api/promotions', authenticate, requireVerified, requireActiveSubscription, promotionsRouter);
app.use('/api/group-collections', authenticate, requireVerified, requireActiveSubscription, groupCollectionsRouter);
app.use('/api/utils', authenticate, linkPreviewRouter);

// Health check
app.get('/api/health', async (_req, res) => {
  const checks: Record<string, 'ok' | 'error'> = { api: 'ok', db: 'ok', redis: 'ok' };
  let status = 200;

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.db = 'error';
    status = 503;
  }

  try {
    const { redis: redisClient } = await import('./shared/redis');
    await redisClient.ping();
  } catch {
    checks.redis = 'error';
    status = 503;
  }

  res.status(status).json({ status: status === 200 ? 'healthy' : 'degraded', checks });
});

// Error handler (must be last)
app.use(errorHandler);

// Global error handlers
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
});

// Start server
async function start() {
  // Connect to database
  await prisma.$connect();
  logger.info('Connected to PostgreSQL');

  // Restore WhatsApp instances from DB
  const manager = ClientManager.getInstance();
  await manager.restoreFromDB();
  logger.info('Restored WhatsApp instances from database');

  // Start warmup cycle worker (consumes jobs from the worker container's scheduler)
  const cycleWorker = createCycleWorker();
  logger.info('Warmup cycle worker registered');

  // Start campaign workers (processor needs WhatsApp instances, so it runs here)
  const campaignProcessor = createCampaignProcessorWorker();
  const campaignScheduler = createCampaignSchedulerWorker();
  await campaignSchedulerQueue.upsertJobScheduler(
    'campaign-scheduler-repeat',
    { every: 60_000 },
    { name: 'campaign-tick' },
  );
  logger.info('Campaign workers registered');

  // Start promotion workers
  const promotionProcessor = createPromotionProcessorWorker();
  const promotionScheduler = createPromotionSchedulerWorker();
  await promotionSchedulerQueue.upsertJobScheduler(
    'promotion-scheduler-repeat',
    { every: 60_000 },
    { name: 'promotion-tick' },
  );
  logger.info('Promotion workers registered');

  httpServer.listen(config.port, () => {
    logger.info(`Backend running on http://localhost:${config.port}`);
  });

  // Graceful shutdown — destroy WhatsApp sessions so auth data is saved properly
  const shutdown = async () => {
    logger.info('API shutting down...');
    await cycleWorker.close();
    await campaignProcessor.close();
    await campaignScheduler.close();
    await promotionProcessor.close();
    await promotionScheduler.close();

    // Destroy all WhatsApp instances so sessions persist across restarts
    const allInstances = manager.getAllInstances();
    logger.info({ count: allInstances.length }, 'Destroying WhatsApp instances');
    await Promise.allSettled(allInstances.map((inst) => inst.destroy()));

    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
