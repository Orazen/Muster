/**
 * Pricing Page - Subscription tiers
 */
import React from 'react';
import { PRICING_PLANS, subscriptionSystem, SubscriptionTier } from '../lib/billing/subscription-system';

export const PricingPage: React.FC = () => {
  const handleSubscribe = async (tier: SubscriptionTier) => {
    await subscriptionSystem.subscribe(tier);
    alert(`Subscribed to ${tier}!`);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h2 className="text-3xl font-bold text-white text-center mb-2">Choose Your Plan</h2>
      <p className="text-center text-gray-400 mb-8">The privacy-first AI assistant that respects your data</p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PRICING_PLANS.map(plan => (
          <div key={plan.tier}
            className={`bg-[#1d293a] rounded-lg p-6 ${plan.tier === 'pro' ? 'ring-2 ring-[#00bbff] scale-105' : ''}`}>
            {plan.tier === 'pro' && (
              <div className="bg-[#00bbff] text-black text-xs font-bold text-center py-1 rounded mb-3">MOST POPULAR</div>
            )}
            <h3 className="text-xl font-bold text-white">{plan.name}</h3>
            <div className="my-4">
              <span className="text-4xl font-bold text-white">${plan.price}</span>
              <span className="text-gray-400">/{plan.interval}</span>
            </div>
            <ul className="space-y-2 mb-6">
              {plan.features.map((feature, i) => (
                <li key={i} className="text-sm text-gray-300 flex items-start">
                  <span className="text-[#00bbff] mr-2">✓</span>{feature}
                </li>
              ))}
            </ul>
            <button onClick={() => handleSubscribe(plan.tier)}
              className={`w-full py-2 rounded font-semibold ${
                plan.tier === 'free' ? 'bg-[#0a0e1a] text-white hover:bg-[#2d3a4a]' : 'bg-[#00bbff] text-black hover:bg-[#009fd9]'
              }`}>
              {plan.tier === 'free' ? 'Get Started' : 'Subscribe'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PricingPage;
