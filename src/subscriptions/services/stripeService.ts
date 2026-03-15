import Stripe from 'stripe';
import { config } from '../../config';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  logger.error('Stripe is disabled: getStripe() was called unexpectedly');
  return null as any;
}

export async function createCustomer(userId: string, email: string, name: string) {
  // Stripe disabled
  logger.info({ userId }, 'Stripe disabled: creating dummy subscription');
  const trialEndsAt = new Date(Date.now() + (config.trialDays || 30) * 24 * 60 * 60 * 1000);
  return prisma.subscription.create({
    data: {
      userId,
      stripeCustomerId: `mock_${userId}`,
      status: 'TRIALING',
      planTier: 'STARTER',
      trialEndsAt,
    },
  });
}

export async function createCheckoutSession(userId: string, priceId: string) {
  logger.info({ userId }, 'Stripe disabled: mock checkout session');
  return `${config.frontendUrl}/settings?checkout=mock_success`;
}

export async function createBillingPortalSession(userId: string) {
  logger.info({ userId }, 'Stripe disabled: mock billing portal');
  return `${config.frontendUrl}/settings?mock_portal`;
}

export async function getSubscription(userId: string) {
  return prisma.subscription.findUnique({
    where: { userId },
    select: {
      id: true,
      planTier: true,
      status: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
    },
  });
}

// Map Stripe price IDs to plan tiers
function priceIdToTier(priceId: string): 'STARTER' | 'PRO' | 'ENTERPRISE' {
  if (priceId === config.stripePriceStarter) return 'STARTER';
  if (priceId === config.stripePricePro) return 'PRO';
  if (priceId === config.stripePriceEnterprise) return 'ENTERPRISE';
  return 'STARTER';
}

// Map Stripe subscription status to our enum
function mapStripeStatus(status: string): 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'UNPAID' {
  switch (status) {
    case 'trialing': return 'TRIALING';
    case 'active': return 'ACTIVE';
    case 'past_due': return 'PAST_DUE';
    case 'canceled':
    case 'incomplete_expired': return 'CANCELED';
    case 'unpaid': return 'UNPAID';
    default: return 'ACTIVE';
  }
}

export async function syncSubscriptionFromStripe(stripeSubscription: Stripe.Subscription) {
  // Stripe disabled
  return;
}
