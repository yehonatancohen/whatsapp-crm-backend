export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
    : ['http://localhost:5173', 'https://api.parties247.co.il', 'https://api.parties247.co.il/', 'https://whatsapp-crm-frontend-plum.vercel.app'],
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/parties247',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-jwt-refresh-secret-change-in-production',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',

  // Email (Resend)
  resendApiKey: process.env.RESEND_API_KEY || '',
  appName: process.env.APP_NAME || 'parties247',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  // Stripe
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePriceStarter: process.env.STRIPE_PRICE_STARTER || '',
  stripePricePro: process.env.STRIPE_PRICE_PRO || '',
  stripePriceEnterprise: process.env.STRIPE_PRICE_ENTERPRISE || '',
  trialDays: parseInt(process.env.TRIAL_DAYS || '7', 10),
};
