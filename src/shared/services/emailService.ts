import { Resend } from 'resend';
import { config } from '../../config';
import { logger } from '../logger';

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    resend = new Resend(config.resendApiKey);
  }
  return resend;
}

export async function sendVerificationEmail(email: string, name: string, token: string): Promise<void> {
  if (!config.resendApiKey) {
    logger.warn('RESEND_API_KEY not set, skipping verification email');
    return;
  }

  const verifyUrl = `${config.frontendUrl}/verify-email?token=${token}`;

  await getResend().emails.send({
    from: `${config.appName} <noreply@sheder.parties247.co.il>`,
    to: email,
    subject: `Verify your email — ${config.appName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #10b981;">Welcome to ${config.appName}</h2>
        <p>Hi ${name},</p>
        <p>Please verify your email address by clicking the button below:</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${verifyUrl}" style="background: #10b981; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Verify Email</a>
        </p>
        <p style="color: #666; font-size: 14px;">Or copy this link: <a href="${verifyUrl}">${verifyUrl}</a></p>
        <p style="color: #999; font-size: 12px;">This link expires in 24 hours.</p>
      </div>
    `,
  });

  logger.info({ email }, 'Verification email sent');
}

export async function sendPasswordResetEmail(email: string, name: string, token: string): Promise<void> {
  if (!config.resendApiKey) {
    logger.warn('RESEND_API_KEY not set, skipping reset email');
    return;
  }

  const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;

  await getResend().emails.send({
    from: `${config.appName} <noreply@sheder.parties247.co.il>`,
    to: email,
    subject: `Reset your password — ${config.appName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #10b981;">${config.appName}</h2>
        <p>Hi ${name},</p>
        <p>Click the button below to reset your password:</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}" style="background: #10b981; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Reset Password</a>
        </p>
        <p style="color: #666; font-size: 14px;">Or copy this link: <a href="${resetUrl}">${resetUrl}</a></p>
        <p style="color: #999; font-size: 12px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });

  logger.info({ email }, 'Password reset email sent');
}
