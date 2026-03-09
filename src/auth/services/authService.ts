import bcrypt from 'bcryptjs';
import { prisma } from '../../shared/db';
import { ConflictError, UnauthorizedError } from '../../shared/errors';
import { generateAccessToken, generateRefreshToken } from './tokenService';

interface AuthResult {
  user: { id: string; email: string; name: string; role: string };
  tokens: { accessToken: string; refreshToken: string };
}

export async function register(
  email: string,
  password: string,
  name: string,
): Promise<AuthResult> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: { email, passwordHash, name },
  });

  const accessToken = generateAccessToken({
    userId: user.id,
    email: user.email,
    role: user.role,
  });
  const refreshToken = await generateRefreshToken(user.id);

  await prisma.activityLog.create({
    data: {
      type: 'USER_REGISTERED',
      message: `User ${user.name} registered`,
      userId: user.id,
    },
  });

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
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
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    tokens: { accessToken, refreshToken },
  };
}
