/**
 * Notification System for Muster+
 * Multi-channel notifications (push, email, in-app)
 */

export interface Notification {
  id: string;
  userId: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  channel: 'in_app' | 'push' | 'email' | 'sms';
  read: boolean;
  timestamp: number;
  metadata?: any;
}

export class NotificationSystem {
  private notifications: Map<string, Notification> = new Map();
  private userNotifications: Map<string, Set<string>> = new Map();

  send(notification: Omit<Notification, 'id' | 'read' | 'timestamp'>): Notification {
    const id = `notif_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const fullNotification: Notification = {
      ...notification,
      id,
      read: false,
      timestamp: Date.now(),
    };

    this.notifications.set(id, fullNotification);

    if (!this.userNotifications.has(notification.userId)) {
      this.userNotifications.set(notification.userId, new Set());
    }
    this.userNotifications.get(notification.userId)!.add(id);

    return fullNotification;
  }

  getForUser(userId: string, unreadOnly: boolean = false): Notification[] {
    const ids = this.userNotifications.get(userId) || new Set();
    const notifs = Array.from(ids).map(id => this.notifications.get(id)!).filter(Boolean);
    return unreadOnly ? notifs.filter(n => !n.read) : notifs;
  }

  markRead(id: string): void {
    const notif = this.notifications.get(id);
    if (notif) {
      notif.read = true;
      this.notifications.set(id, notif);
    }
  }

  markAllRead(userId: string): void {
    const ids = this.userNotifications.get(userId) || new Set();
    ids.forEach(id => this.markRead(id));
  }

  delete(id: string): void {
    this.notifications.delete(id);
  }

  getUnreadCount(userId: string): number {
    return this.getForUser(userId, true).length;
  }
}

export const notificationSystem = new NotificationSystem();
