/**
 * Stripe Payment Integration
 */
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20',
});

export const stripeService = {
  async createCheckoutSession(userId: string, planId: string, successUrl: string, cancelUrl: string) {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: userId,
      line_items: [{ price: planId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return { id: session.id, url: session.url, amount: session.amount_total };
  },

  async handleWebhook(payload: string, signature: string) {
    const event = stripe.webhooks.constructEvent(
      payload, signature, process.env.STRIPE_WEBHOOK_SECRET || ''
    );
    return { received: true, type: event.type };
  },

  async getSubscription(id: string) {
    return stripe.subscriptions.retrieve(id);
  },

  async cancelSubscription(id: string) {
    return stripe.subscriptions.cancel(id);
  },
};

export default stripeService;
