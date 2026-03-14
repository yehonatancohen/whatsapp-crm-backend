import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../shared/db';
import { ConflictError, UnauthorizedError, ValidationError } from '../../shared/errors';
import { generateAccessToken, generateRefreshToken } from './tokenService';
import { isDisposableEmail } from '../../shared/utils/disposableEmails';
import { sendVerificationEmail } from '../../shared/services/emailService';
import { createCustomer } from '../../subscriptions/services/stripeService';
import { logger } from '../../shared/logger';

interface AuthResult {
  user: { id: string; email: string; name: string; role: string; emailVerified: boolean };
  tokens: { accessToken: string; refreshToken: string };
}

export async function register(
  email: string,
  password: string,
  name: string,
): Promise<AuthResult> {
  // Block disposable emails
  if (isDisposableEmail(email)) {
    throw new ValidationError('Please use a real email address. Temporary/disposable emails are not allowed.');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const verificationToken = crypto.randomBytes(32).toString('hex');
  const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      emailVerified: false,
      verificationToken,
      verificationExpiry,
    },
  });

  const accessToken = generateAccessToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    emailVerified: false,
  });
  const refreshToken = await generateRefreshToken(user.id);

  await prisma.activityLog.create({
    data: {
      type: 'USER_REGISTERED',
      message: `User ${user.name} registered`,
      userId: user.id,
    },
  });

  // Send verification email (fire-and-forget, don't block registration)
  sendVerificationEmail(email, name, verificationToken).catch((err) => {
    logger.error({ err, email }, 'Failed to send verification email');
  });

  // Create Stripe customer + trial subscription (fire-and-forget)
  createCustomer(user.id, email, name).catch((err) => {
    logger.error({ err, userId: user.id }, 'Failed to create Stripe customer');
  });

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: false },
    tokens: { accessToken, refreshToken },
  };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const accessToken = generateAccessToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    emailVerified: user.emailVerified,
  });
  const refreshToken = await generateRefreshToken(user.id);

  await prisma.activityLog.create({
    data: {
      type: 'USER_LOGIN',
      message: `User ${user.name} logged in`,
      userId: user.id,
    },
  });

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: user.emailVerified },
    tokens: { accessToken, refreshToken },
  };
}
