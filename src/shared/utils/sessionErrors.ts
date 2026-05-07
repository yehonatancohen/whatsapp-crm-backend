import { prisma } from '../db';
import { emitToUser } from '../socket';
import { logger } from '../logger';
import { ClientManager } from '../../accounts/services/ClientManager';

const SESSION_ERROR_PATTERNS = [
  'advSignedDeviceIdentity is null',
  'Session closed',
  'frame was detached',
  'Target closed',
  'Execution context was destroyed',
  'Protocol error (Network.disable)',
];

/** Returns true if the error indicates the WhatsApp session has expired/crashed. */
export function isSessionExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return SESSION_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Mark an account as DISCONNECTED in-memory and in the DB, then notify
 * the user via socket. Called when a send fails with a session expiry error
 * so the account is excluded from future sends until the user reconnects it.
 */
export async function handleSessionExpiredError(
  accountId: string,
  userId: string,
  errorMessage: string,
): Promise<void> {
  try {
    const manager = ClientManager.getInstance();
    const instance = manager.getInstanceById(accountId);
    if (instance && instance.status === 'AUTHENTICATED') {
      instance.status = 'DISCONNECTED';
      instance.error = errorMessage;
    }

    await prisma.account.update({
      where: { id: accountId },
      data: { status: 'DISCONNECTED', errorMessage },
    });

    emitToUser(userId, 'account:status', {
      id: accountId,
      status: 'DISCONNECTED',
      error: errorMessage,
    });

    logger.warn({ accountId, errorMessage }, 'Account marked DISCONNECTED due to session expiry');
  } catch (innerErr) {
    logger.error({ accountId, innerErr }, 'Failed to handle session expiry');
  }
}
