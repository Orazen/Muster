/**
 * Cloud Sync System for Muster+
 * Encrypted backup with cross-device sync
 * Zero-knowledge architecture
 */

import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';

export interface CloudConfig {
  endpoint: string;
  userId: string;
  encryptionKey: string;
  enableSync: boolean;
  syncInterval: number;
}

export interface SyncItem {
  id: string;
  type: 'memory' | 'agent' | 'template' | 'conversation';
  data: any;
  encrypted: boolean;
  timestamp: number;
  version: number;
}

export class CloudSync {
  private config: CloudConfig;
  private syncQueue: SyncItem[] = [];
  private isOnline: boolean = false;
  private syncInProgress: boolean = false;

  constructor(config: Partial<CloudConfig> = {}) {
    this.config = {
      endpoint: config.endpoint || 'https://sync.muster-plus.heyworld.ai',
      userId: config.userId || uuidv4(),
      encryptionKey: config.encryptionKey || CryptoJS.lib.WordArray.random(32).toString(),
      enableSync: config.enableSync ?? true,
      syncInterval: config.syncInterval || 30000,
    };
  }

  private encrypt(data: any): string {
    return CryptoJS.AES.encrypt(JSON.stringify(data), this.config.encryptionKey).toString();
  }

  private decrypt(encryptedData: string): any {
    const bytes = CryptoJS.AES.decrypt(encryptedData, this.config.encryptionKey);
    return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
  }

  async queueSync(item: Omit<SyncItem, 'id' | 'timestamp' | 'version' | 'encrypted'>): Promise<void> {
    if (!this.config.enableSync) return;
    const syncItem: SyncItem = {
      id: uuidv4(),
      ...item,
      encrypted: true,
      timestamp: Date.now(),
      version: 1,
    };
    this.syncQueue.push(syncItem);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`muster_sync_${syncItem.id}`, JSON.stringify(syncItem));
    }
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.syncInProgress || !this.isOnline) return;
    setTimeout(() => this.performSync(), 100);
  }

  private async performSync(): Promise<void> {
    if (this.syncInProgress || this.syncQueue.length === 0) return;
    this.syncInProgress = true;
    try {
      const items = [...this.syncQueue];
      this.syncQueue = [];
      const encryptedItems = items.map(item => ({ ...item, data: this.encrypt(item.data) }));
      await fetch(`${this.config.endpoint}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': this.config.userId },
        body: JSON.stringify({ items: encryptedItems }),
      });
    } catch (error) {
      console.error('Sync failed:', error);
    } finally {
      this.syncInProgress = false;
    }
  }

  async restore(): Promise<any[]> {
    try {
      const response = await fetch(`${this.config.endpoint}/api/restore`, {
        headers: { 'X-User-Id': this.config.userId },
      });
      if (!response.ok) throw new Error('Restore failed');
      const data = await response.json();
      return data.items.map((item: any) => ({ ...item, data: this.decrypt(item.data) }));
    } catch (error) {
      return [];
    }
  }

  setOnline(online: boolean): void {
    this.isOnline = online;
    if (online) this.scheduleSync();
  }

  getStatus(): { queued: number; online: boolean; syncing: boolean } {
    return { queued: this.syncQueue.length, online: this.isOnline, syncing: this.syncInProgress };
  }

  generatePairingCode(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`.toUpperCase();
  }

  async pairDevice(code: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.endpoint}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': this.config.userId },
        body: JSON.stringify({ code }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const cloudSync = new CloudSync();
