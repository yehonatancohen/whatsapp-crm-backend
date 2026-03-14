import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { config } from '../config';
import { getStripe, syncSubscriptionFromStripe } from './services/stripeService';
import { prisma } from '../shared/db';
import { logger } from '../shared/logger';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig || !config.stripeWebhookSecret) {
    res.status(400).json({ error: 'Missing signature' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Stripe webhook signature verification failed');
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription) {
          const stripeSub = await getStripe().subscriptions.retrieve(session.subscription as string);
          await syncSubscriptionFromStripe(stripeSub);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await syncSubscriptionFromStripe(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const sub = await prisma.subscription.findUnique({
          where: { stripeCustomerId: subscription.customer as string },
        });
        if (sub) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { status: 'CANCELED' },
          });
          logger.info({ subId: sub.id }, 'Subscription canceled via webhook');
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        const sub = await prisma.subscription.findUnique({
          where: { stripeCustomerId: customerId },
        });
        if (sub) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { status: 'PAST_DUE' },
          });
          logger.warn({ subId: sub.id }, 'Payment failed, subscription marked past_due');
        }
        break;
      }

      default:
        logger.debug({ type: event.type }, 'Unhandled Stripe event');
    }
  } catch (err) {
    logger.error({ err, eventType: event.type }, 'Error processing Stripe webhook');
  }

  res.json({ received: true });
});

export default router;
