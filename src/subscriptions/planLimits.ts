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
    tier: 'PRO' as const,
    name: 'מקצוען',
    priceMonthly: 299,
    features: [
      '5 חשבונות וואטסאפ',
      '10,000 אנשי קשר',
      '50 קמפיינים בחודש',
      '5,000 הודעות ביום',
      'חימום מספרים',
      'תיבת הודעות',
      'תמיכה מועדפת',
    ],
  },
  {
    tier: 'ENTERPRISE' as const,
    name: 'ארגוני',
    priceMonthly: 0,
    features: [
      '20 חשבונות וואטסאפ',
      '100,000 אנשי קשר',
      'קמפיינים ללא הגבלה',
      'הודעות ללא הגבלה',
      'חימום מספרים',
      'תיבת הודעות',
      'תמיכה מועדפת',
      'אינטגרציות מותאמות אישית',
    ],
  },
];
