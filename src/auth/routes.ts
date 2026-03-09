import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { validate } from '../shared/middleware/validate';
import { authenticate } from '../shared/middleware/auth';
import { register, login } from './services/authService';
import { rotateRefreshToken, revokeRefreshToken } from './services/tokenService';
import { prisma } from '../shared/db';
import { NotFoundError, UnauthorizedError } from '../shared/errors';

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required').max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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

// PATCH /api/auth/profile
router.patch(
  '/profile',
  authenticate,
  validate(z.object({ name: z.string().min(1).max(100) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.update({
        where: { id: req.user!.userId },
        data: { name: req.body.name },
        select: { id: true, email: true, name: true, role: true },
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
  validate(z.object({ currentPassword: z.string(), newPassword: z.string().min(8) })),
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
