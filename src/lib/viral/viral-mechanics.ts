/**
 * Viral Mechanics for Muster+
 * Referral program, social sharing, community features
 */

import { v4 as uuidv4 } from 'uuid';

export interface ReferralCode {
  code: string;
  userId: string;
  uses: number;
  maxUses: number;
  reward: ReferralReward;
  expiresAt: number;
  createdAt: number;
}

export interface ReferralReward {
  type: 'pro_days' | 'discount' | 'credits';
  amount: number;
  description: string;
}

export interface ShareableContent {
  id: string;
  type: 'agent' | 'template' | 'conversation' | 'result';
  title: string;
  description: string;
  url: string;
  thumbnail?: string;
  metadata?: any;
  createdAt: number;
  views: number;
  shares: number;
}

export class ViralMechanics {
  private referrals: Map<string, ReferralCode> = new Map();
  private shares: Map<string, ShareableContent> = new Map();
  private userPoints: Map<string, number> = new Map();

  generateReferralCode(userId: string, maxUses: number = 10): ReferralCode {
    const code = `MUSTER${uuidv4().substring(0, 6).toUpperCase()}`;
    const referral: ReferralCode = {
      code,
      userId,
      uses: 0,
      maxUses,
      reward: {
        type: 'pro_days',
        amount: 7,
        description: '7 free Pro days for both you and your friend',
      },
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
    };
    this.referrals.set(code, referral);
    return referral;
  }

  applyReferralCode(code: string, newUserId: string): { success: boolean; reward?: ReferralReward } {
    const referral = this.referrals.get(code);
    if (!referral) return { success: false };
    if (referral.uses >= referral.maxUses) return { success: false };
    if (Date.now() > referral.expiresAt) return { success: false };

    referral.uses++;
    this.referrals.set(code, referral);
    this.addPoints(referral.userId, 100);
    this.addPoints(newUserId, 100);
    return { success: true, reward: referral.reward };
  }

  getReferralStats(userId: string): { points: number; totalReferrals: number } {
    const code = Array.from(this.referrals.values()).find(r => r.userId === userId);
    return {
      points: this.userPoints.get(userId) || 0,
      totalReferrals: code ? code.uses : 0,
    };
  }

  shareContent(content: Omit<ShareableContent, 'id' | 'createdAt' | 'views' | 'shares'>): ShareableContent {
    const share: ShareableContent = {
      id: uuidv4(),
      ...content,
      createdAt: Date.now(),
      views: 0,
      shares: 0,
    };
    this.shares.set(share.id, share);
    return share;
  }

  trackView(shareId: string): void {
    const share = this.shares.get(shareId);
    if (share) {
      share.views++;
      this.shares.set(shareId, share);
    }
  }

  trackShare(shareId: string): void {
    const share = this.shares.get(shareId);
    if (share) {
      share.shares++;
      this.shares.set(shareId, share);
    }
  }

  getTrendingShares(limit: number = 10): ShareableContent[] {
    return Array.from(this.shares.values())
      .sort((a, b) => (b.views + b.shares * 5) - (a.views + a.shares * 5))
      .slice(0, limit);
  }

  getLeaderboard(limit: number = 10): Array<{ userId: string; points: number }> {
    return Array.from(this.userPoints.entries())
      .map(([userId, points]) => ({ userId, points }))
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
  }

  private addPoints(userId: string, points: number): void {
    const current = this.userPoints.get(userId) || 0;
    this.userPoints.set(userId, current + points);
  }
}

export const viralMechanics = new ViralMechanics();
