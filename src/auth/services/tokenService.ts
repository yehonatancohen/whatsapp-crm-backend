import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../../config';
import { prisma } from '../../shared/db';

interface AccessTokenPayload {
  userId: string;
  email: string;
  role: string;
  emailVerified: boolean;
}

export function generateAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtAccessExpiry as string,
  } as jwt.SignOptions);
}

export async function generateRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(64).toString('hex');

  // Parse expiry (e.g. "7d" → 7 days)
  const match = config.jwtRefreshExpiry.match(/^(\d+)([dhms])$/);
  let ms = 7 * 24 * 60 * 60 * 1000; // default 7 days
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    ms = num * (multipliers[unit] || ms);
  }

  await prisma.refreshToken.create({
    data: {
      token,
      userId,
      expiresAt: new Date(Date.now() + ms),
    },
  });

  return token;
}

export async function rotateRefreshToken(
  oldToken: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const stored = await prisma.refreshToken.findUnique({
    where: { token: oldToken },
    include: { user: true },
  });

  if (!stored || stored.expiresAt < new Date()) {
    // Delete if expired
    if (stored) {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
    }
    return null;
  }

  // Delete old token (single-use rotation)
  await prisma.refreshToken.delete({ where: { id: stored.id } });

  const accessToken = generateAccessToken({
    userId: stored.user.id,
    email: stored.user.email,
    role: stored.user.role,
    emailVerified: stored.user.emailVerified,
  });

  const refreshToken = await generateRefreshToken(stored.userId);

  return { accessToken, refreshToken };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { token } });
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}
