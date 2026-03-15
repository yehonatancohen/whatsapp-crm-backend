import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { validate } from '../shared/middleware/validate';
import { authenticate } from '../shared/middleware/auth';
import { register, login } from './services/authService';
import { rotateRefreshToken, revokeRefreshToken, revokeAllUserTokens } from './services/tokenService';
import { prisma } from '../shared/db';
import { NotFoundError, UnauthorizedError, ValidationError } from '../shared/errors';
import { sendVerificationEmail, sendPasswordResetEmail } from '../shared/services/emailService';
import { logger } from '../shared/logger';

const router = Router();

const registerSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
});

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// POST /api/auth/register
router.post(
  '/register',
  validate(registerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await register(req.body.email, req.body.password, req.body.name);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/login
router.post(
  '/login',
  validate(loginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await login(req.body.email, req.body.password);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/refresh
router.post(
  '/refresh',
  validate(refreshSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await rotateRefreshToken(req.body.refreshToken);
      if (!result) {
        throw new UnauthorizedError('Invalid or expired refresh token');
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/logout
router.post(
  '/logout',
  validate(refreshSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await revokeRefreshToken(req.body.refreshToken);
      res.json({ message: 'Logged out' });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/auth/verify-email?token=xxx
router.get('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.query.token as string;
    if (!token) throw new ValidationError('Verification token is required');

    const user = await prisma.user.findFirst({
      where: { verificationToken: token },
    });

    if (!user) {
      throw new ValidationError('Invalid or expired verification link');
    }

    if (user.verificationExpiry && user.verificationExpiry < new Date()) {
      throw new ValidationError('Verification link has expired. Please request a new one.');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationToken: null,
        verificationExpiry: null,
      },
    });

    await prisma.activityLog.create({
      data: {
        type: 'EMAIL_VERIFIED',
        message: `User ${user.name} verified their email`,
        userId: user.id,
      },
    });

    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) throw new NotFoundError('User');

    if (user.emailVerified) {
      res.json({ message: 'Email is already verified' });
      return;
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { verificationToken, verificationExpiry },
    });

    await sendVerificationEmail(user.email, user.name, verificationToken);
    res.json({ message: 'Verification email sent' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
router.post(
  '/forgot-password',
  validate(z.object({ email: z.string().email('Please enter a valid email address') })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Always return 200 to prevent email enumeration
      const user = await prisma.user.findUnique({ where: { email: req.body.email } });

      if (user) {
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await prisma.user.update({
          where: { id: user.id },
          data: { resetToken, resetTokenExpiry },
        });

        await prisma.activityLog.create({
          data: {
            type: 'PASSWORD_RESET_REQUESTED',
            message: `Password reset requested for ${user.email}`,
            userId: user.id,
          },
        });

        sendPasswordResetEmail(user.email, user.name, resetToken).catch((err) => {
          logger.error({ err, email: user.email }, 'Failed to send password reset email');
        });
      }

      res.json({ message: 'If an account with that email exists, a password reset link has been sent.' });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/reset-password
router.post(
  '/reset-password',
  validate(z.object({
    token: z.string().min(1, 'Reset token is required'),
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, newPassword } = req.body;

      const user = await prisma.user.findFirst({
        where: { resetToken: token },
      });

      if (!user) {
        throw new ValidationError('Invalid or expired reset link');
      }

      if (user.resetTokenExpiry && user.resetTokenExpiry < new Date()) {
        throw new ValidationError('Reset link has expired. Please request a new one.');
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          resetToken: null,
          resetTokenExpiry: null,
        },
      });

      // Revoke all sessions for security
      await revokeAllUserTokens(user.id);

      await prisma.activityLog.create({
        data: {
          type: 'PASSWORD_RESET_COMPLETED',
          message: `Password reset completed for ${user.email}`,
          userId: user.id,
        },
      });

      res.json({ message: 'Password has been reset. Please log in with your new password.' });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/auth/me
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerified: true,
        createdAt: true,
        subscription: {
          select: {
            planTier: true,
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
          },
        },
        _count: {
          select: {
            accounts: true,
            campaigns: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/profile
router.patch(
  '/profile',
  authenticate,
  validate(z.object({ name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less') })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.update({
        where: { id: req.user!.userId },
        data: { name: req.body.name },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          emailVerified: true,
          subscription: {
            select: {
              planTier: true,
              status: true,
            },
          },
        },
      });
      res.json(user);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/auth/password
router.patch(
  '/password',
  authenticate,
  validate(z.object({ currentPassword: z.string().min(1, 'Current password is required'), newPassword: z.string().min(8, 'New password must be at least 8 characters') })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
      if (!user) throw new NotFoundError('User');

      const valid = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
      if (!valid) throw new UnauthorizedError('Current password is incorrect');

      const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
      res.json({ message: 'Password changed' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
