/**
 * Subscription System for Muster+
 * Tiered pricing: Free, Pro, Team, Enterprise
 */

export type SubscriptionTier = 'free' | 'pro' | 'team' | 'enterprise';

export interface Subscription {
  tier: SubscriptionTier;
  status: 'active' | 'inactive' | 'past_due' | 'cancelled';
  startDate: number;
  endDate?: number;
  autoRenew: boolean;
  paymentMethod?: string;
  features: string[];
}

export interface PricingPlan {
  tier: SubscriptionTier;
  name: string;
  price: number;
  interval: 'month' | 'year';
  features: string[];
  limits: Record<string, number>;
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    tier: 'free',
    name: 'Free',
    price: 0,
    interval: 'month',
    features: ['3 agents', 'Basic models', '100 messages/day', 'Local-first only'],
    limits: { agents: 3, messagesPerDay: 100, models: 2 },
  },
  {
    tier: 'pro',
    name: 'Pro',
    price: 9,
    interval: 'month',
    features: ['Unlimited agents', 'All models', 'Unlimited messages', 'Cloud sync', 'Mobile apps'],
    limits: { agents: -1, messagesPerDay: -1, models: -1 },
  },
  {
    tier: 'team',
    name: 'Team',
    price: 29,
    interval: 'month',
    features: ['Everything in Pro', 'Admin dashboard', 'SSO', 'API access', 'Team sharing'],
    limits: { agents: -1, messagesPerDay: -1, models: -1, users: 5 },
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    price: 99,
    interval: 'month',
    features: ['Everything in Team', 'Custom models', 'White-label', 'Dedicated support', 'SLA'],
    limits: { agents: -1, messagesPerDay: -1, models: -1, users: -1 },
  },
];

export class SubscriptionSystem {
  private currentSubscription: Subscription | null = null;
  private userId: string = '';

  setUser(userId: string): void {
    this.userId = userId;
  }

  getCurrentSubscription(): Subscription | null {
    return this.currentSubscription;
  }

  getPlan(tier: SubscriptionTier): PricingPlan | null {
    return PRICING_PLANS.find(p => p.tier === tier) || null;
  }

  getAllPlans(): PricingPlan[] {
    return PRICING_PLANS;
  }

  async subscribe(tier: SubscriptionTier, paymentMethod?: string): Promise<Subscription> {
    const plan = this.getPlan(tier);
    if (!plan) throw new Error(`Invalid tier: ${tier}`);

    this.currentSubscription = {
      tier,
      status: 'active',
      startDate: Date.now(),
      autoRenew: true,
      paymentMethod,
      features: plan.features,
    };
    return this.currentSubscription;
  }

  async cancel(): Promise<void> {
    if (this.currentSubscription) {
      this.currentSubscription.status = 'cancelled';
      this.currentSubscription.autoRenew = false;
    }
  }

  canUse(feature: string): boolean {
    if (!this.currentSubscription) return false;
    return this.currentSubscription.features.some(f => 
      f.toLowerCase().includes(feature.toLowerCase())
    );
  }

  getLimit(key: string): number {
    const plan = this.currentSubscription ? this.getPlan(this.currentSubscription.tier) : this.getPlan('free');
    if (!plan) return 0;
    return plan.limits[key] || 0;
  }
}

export const subscriptionSystem = new SubscriptionSystem();
