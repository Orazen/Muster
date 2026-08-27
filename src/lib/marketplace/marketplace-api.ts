/**
 * Marketplace API for Muster+
 * Template and agent marketplace backend
 */

import { v4 as uuidv4 } from 'uuid';

export interface MarketplaceItem {
  id: string;
  type: 'template' | 'agent' | 'skill' | 'integration';
  name: string;
  description: string;
  author: string;
  version: string;
  downloads: number;
  rating: number;
  price: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Review {
  id: string;
  itemId: string;
  userId: string;
  rating: number;
  comment: string;
  timestamp: number;
}

export class MarketplaceAPI {
  private items: Map<string, MarketplaceItem> = new Map();
  private reviews: Map<string, Review[]> = new Map();
  private purchases: Map<string, Set<string>> = new Map();

  publishItem(item: Omit<MarketplaceItem, 'id' | 'createdAt' | 'updatedAt' | 'downloads' | 'rating'>): MarketplaceItem {
    const newItem: MarketplaceItem = {
      ...item,
      id: uuidv4(),
      downloads: 0,
      rating: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.items.set(newItem.id, newItem);
    return newItem;
  }

  getItem(id: string): MarketplaceItem | null {
    return this.items.get(id) || null;
  }

  getAllItems(type?: string): MarketplaceItem[] {
    const all = Array.from(this.items.values());
    return type ? all.filter(i => i.type === type) : all;
  }

  getTopItems(limit: number = 10): MarketplaceItem[] {
    return Array.from(this.items.values())
      .sort((a, b) => (b.downloads + b.rating * 100) - (a.downloads + a.rating * 100))
      .slice(0, limit);
  }

  async purchase(userId: string, itemId: string): Promise<{ success: boolean; commission: number }> {
    const item = this.items.get(itemId);
    if (!item) return { success: false, commission: 0 };

    if (!this.purchases.has(userId)) {
      this.purchases.set(userId, new Set());
    }
    this.purchases.get(userId)!.add(itemId);
    item.downloads++;
    this.items.set(itemId, item);

    // 15% commission
    const commission = item.price * 0.15;
    return { success: true, commission };
  }

  hasPurchased(userId: string, itemId: string): boolean {
    return this.purchases.get(userId)?.has(itemId) || false;
  }

  addReview(itemId: string, userId: string, rating: number, comment: string): Review {
    const review: Review = {
      id: uuidv4(),
      itemId,
      userId,
      rating,
      comment,
      timestamp: Date.now(),
    };
    if (!this.reviews.has(itemId)) {
      this.reviews.set(itemId, []);
    }
    this.reviews.get(itemId)!.push(review);

    // Update item rating
    const item = this.items.get(itemId);
    if (item) {
      const itemReviews = this.reviews.get(itemId)!;
      item.rating = itemReviews.reduce((sum, r) => sum + r.rating, 0) / itemReviews.length;
      this.items.set(itemId, item);
    }
    return review;
  }

  getReviews(itemId: string): Review[] {
    return this.reviews.get(itemId) || [];
  }

  search(query: string): MarketplaceItem[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllItems().filter(i =>
      i.name.toLowerCase().includes(lowerQuery) ||
      i.description.toLowerCase().includes(lowerQuery) ||
      i.tags.some(t => t.toLowerCase().includes(lowerQuery))
    );
  }
}

export const marketplaceAPI = new MarketplaceAPI();
