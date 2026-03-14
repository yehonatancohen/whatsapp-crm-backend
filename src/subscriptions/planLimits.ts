export interface PlanLimits {
  maxAccounts: number;
  maxContacts: number;
  maxCampaignsPerMonth: number;
  maxMessagesPerDay: number;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  STARTER: {
    maxAccounts: 2,
    maxContacts: 1_000,
    maxCampaignsPerMonth: 10,
    maxMessagesPerDay: 500,
  },
  PRO: {
    maxAccounts: 5,
    maxContacts: 10_000,
    maxCampaignsPerMonth: 50,
    maxMessagesPerDay: 5_000,
  },
  ENTERPRISE: {
    maxAccounts: 20,
    maxContacts: 100_000,
    maxCampaignsPerMonth: -1, // unlimited
    maxMessagesPerDay: -1,    // unlimited
  },
};

export const PLAN_INFO = [
  {
    tier: 'STARTER' as const,
    name: 'Starter',
    priceMonthly: 29,
    features: [
      '2 WhatsApp accounts',
      '1,000 contacts',
      '10 campaigns/month',
      '500 messages/day',
      'Number warmup',
      'Chat inbox',
    ],
  },
  {
    tier: 'PRO' as const,
    name: 'Pro',
    priceMonthly: 79,
    features: [
      '5 WhatsApp accounts',
      '10,000 contacts',
      '50 campaigns/month',
      '5,000 messages/day',
      'Number warmup',
      'Chat inbox',
      'Priority support',
    ],
  },
  {
    tier: 'ENTERPRISE' as const,
    name: 'Enterprise',
    priceMonthly: 199,
    features: [
      '20 WhatsApp accounts',
      '100,000 contacts',
      'Unlimited campaigns',
      'Unlimited messages',
      'Number warmup',
      'Chat inbox',
      'Priority support',
      'Custom integrations',
    ],
  },
];
