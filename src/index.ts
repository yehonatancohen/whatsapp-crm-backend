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

// Routes
import authRouter from './auth/routes';
import accountsRouter from './accounts/routes';
import contactsRouter from './contacts/routes';
import warmupRouter from './warmup/routes';
import usersRouter from './users/routes';
import activityRouter from './activity/routes';
import campaignsRouter from './campaigns/routes';

// Services
import { ClientManager } from './accounts/services/ClientManager';
import { createCycleWorker } from './warmup/warmupWorker';

const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO
initSocket(httpServer);

// Middleware
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json());

// Rate limiting
app.use('/api/auth', authLimiter);
app.use('/api/', apiLimiter);

// Routes
app.use('/api/auth', authRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/warmup', warmupRouter);
app.use('/api/users', usersRouter);
app.use('/api/activity', activityRouter);
app.use('/api/campaigns', campaignsRouter);

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

  httpServer.listen(config.port, () => {
    logger.info(`Backend running on http://localhost:${config.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('API shutting down...');
    await cycleWorker.close();
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
