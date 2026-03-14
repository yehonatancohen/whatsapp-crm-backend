import { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../errors';

export function requireVerified(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.emailVerified) {
    throw new ForbiddenError('Please verify your email before accessing this feature');
  }
  next();
}
