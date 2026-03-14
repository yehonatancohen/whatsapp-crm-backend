import Stripe from 'stripe';
import { config } from '../../config';
import { prisma } from '../../shared/db';
import { logger } from '../../shared/logger';

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripe) {
    stripe = new Stripe(config.stripeSecretKey);
  }
  return stripe;
}

export async function createCustomer(userId: string, email: string, name: string) {
  if (!config.stripeSecretKey) {
    logger.warn('STRIPE_SECRET_KEY not set, creating subscription record without Stripe');
    const trialEndsAt = new Date(Date.now() + config.trialDays * 24 * 60 * 60 * 1000);
    return prisma.subscription.create({
      data: {
        userId,
        stripeCustomerId: `dev_${userId}`,
        status: 'TRIALING',
        planTier: 'STARTER',
        trialEndsAt,
      },
    });
  }

  const customer = await getStripe().customers.create({
    email,
    name,
    metadata: { userId },
  });

  const trialEndsAt = new Date(Date.now() + config.trialDays * 24 * 60 * 60 * 1000);

  return prisma.subscription.create({
    data: {
      userId,
      stripeCustomerId: customer.id,
      status: 'TRIALING',
      planTier: 'STARTER',
      trialEndsAt,
    },
  });
}

export async function createCheckoutSession(userId: string, priceId: string) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) throw new Error('No subscription record found');

  const session = await getStripe().checkout.sessions.create({
    customer: sub.stripeCustomerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.frontendUrl}/settings?checkout=success`,
    cancel_url: `${config.frontendUrl}/settings?checkout=canceled`,
    metadata: { userId },
  });

  return session.url;
}

export async function createBillingPortalSession(userId: string) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) throw new Error('No subscription record found');

  const session = await getStripe().billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${config.frontendUrl}/settings`,
  });

  return session.url;
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
  const sub = await prisma.subscription.findUnique({
    where: { stripeCustomerId: stripeSubscription.customer as string },
  });

  if (!sub) {
    logger.warn({ customerId: stripeSubscription.customer }, 'No local subscription for Stripe customer');
    return;
  }

  const priceId = stripeSubscription.items.data[0]?.price?.id;
  const planTier = priceId ? priceIdToTier(priceId) : sub.planTier;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      stripeSubscriptionId: stripeSubscription.id,
      status: mapStripeStatus(stripeSubscription.status),
      planTier,
      currentPeriodEnd: stripeSubscription.cancel_at
        ? new Date(stripeSubscription.cancel_at * 1000)
        : new Date(stripeSubscription.billing_cycle_anchor * 1000),
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      trialEndsAt: stripeSubscription.trial_end
        ? new Date(stripeSubscription.trial_end * 1000)
        : sub.trialEndsAt,
    },
  });

  logger.info({ subId: sub.id, status: stripeSubscription.status, planTier }, 'Subscription synced from Stripe');
}
