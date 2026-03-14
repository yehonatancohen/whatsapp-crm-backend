import { z } from 'zod';
import { logger } from '../logger';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
});

const productionSchema = envSchema.extend({
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY is required in production'),
  STRIPE_SECRET_KEY: z.string().min(1, 'STRIPE_SECRET_KEY is required in production'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'STRIPE_WEBHOOK_SECRET is required in production'),
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL'),
});

export function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const schema = isProduction ? productionSchema : envSchema;

  const result = schema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    const message = `Environment validation failed:\n${errors.join('\n')}`;

    if (isProduction) {
      logger.fatal(message);
      process.exit(1);
    } else {
      logger.warn(message);
    }
  }
}
