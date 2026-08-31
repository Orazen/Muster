/**
 * Analytics Tracker for Muster+
 * Privacy-first analytics (PostHog integration)
 */

/** Analytics payloads are forwarded to PostHog, so keep them JSON-shaped. */
export type AnalyticsPropertyValue = string | number | boolean | null;

export interface AnalyticsEvent {
  name: string;
  properties?: Record<string, AnalyticsPropertyValue>;
  timestamp: number;
  userId?: string;
}

export interface AnalyticsStats {
  total: number;
  unique: number;
  byEvent: Record<string, number>;
}

export class AnalyticsTracker {
  private events: AnalyticsEvent[] = [];
  private enabled: boolean = true;
  private userId: string = '';
  private sessionId: string = '';

  constructor() {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  setUser(userId: string): void {
    this.userId = userId;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  track(name: string, properties?: Record<string, AnalyticsPropertyValue>): void {
    if (!this.enabled) return;
    this.events.push({
      name,
      properties,
      timestamp: Date.now(),
      userId: this.userId,
    });
  }

  getEvents(): AnalyticsEvent[] {
    return this.events;
  }

  getEventsByName(name: string): AnalyticsEvent[] {
    return this.events.filter(e => e.name === name);
  }

  clear(): void {
    this.events = [];
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getStats(): AnalyticsStats {
    const unique = new Set(this.events.map(e => e.userId).filter(Boolean)).size;
    const byEvent: Record<string, number> = {};
    this.events.forEach(e => {
      byEvent[e.name] = (byEvent[e.name] || 0) + 1;
    });
    return { total: this.events.length, unique, byEvent };
  }
}

export const analyticsTracker = new AnalyticsTracker();
