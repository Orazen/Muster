/**
 * Memory Store - 8 Memory Types for Muster+
 * Based on Vellum's memory architecture
 */

export type MemoryType =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'emotional'
  | 'prospective'
  | 'behavioral'
  | 'narrative'
  | 'shared'
  | 'temporal';

export interface MemoryItem {
  key: string;
  value: any;
  type: MemoryType;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
}

export class MemoryManager {
  private agentId: string;
  private storage: Map<string, MemoryItem> = new Map();

  constructor(agentId: string) {
    this.agentId = agentId;
    this.load();
  }

  private load() {
    const key = `memory_${this.agentId}`;
    const data = localStorage.getItem(key);
    if (data) {
      try {
        const items = JSON.parse(data);
        items.forEach((item: MemoryItem) => {
          this.storage.set(item.key, item);
        });
      } catch (e) {
        console.error('Failed to load memory:', e);
      }
    }
  }

  private save() {
    const key = `memory_${this.agentId}`;
    const items = Array.from(this.storage.values());
    localStorage.setItem(key, JSON.stringify(items));
  }

  async add(type: MemoryType, key: string, value: any, metadata?: Record<string, any>): Promise<boolean> {
    const item: MemoryItem = {
      key,
      value,
      type,
      timestamp: Date.now(),
      metadata,
    };
    this.storage.set(key, item);
    this.save();
    return true;
  }

  async get(key: string): Promise<MemoryItem | null> {
    return this.storage.get(key) || null;
  }

  async set(key: string, value: any): Promise<boolean> {
    const item = this.storage.get(key);
    if (item) {
      item.value = value;
      item.timestamp = Date.now();
      this.storage.set(key, item);
      this.save();
      return true;
    }
    return false;
  }

  async delete(key: string): Promise<boolean> {
    const deleted = this.storage.delete(key);
    if (deleted) this.save();
    return deleted;
  }

  async list(): Promise<Record<MemoryType, MemoryItem[]>> {
    const result: Record<MemoryType, MemoryItem[]> = {
      episodic: [],
      semantic: [],
      procedural: [],
      emotional: [],
      prospective: [],
      behavioral: [],
      narrative: [],
      shared: [],
      temporal: [],
    };
    this.storage.forEach((item) => {
      result[item.type].push(item);
    });
    return result;
  }

  async clear(): Promise<boolean> {
    this.storage.clear();
    this.save();
    return true;
  }

  async getStats(): Promise<MemoryStats> {
    const stats: MemoryStats = {
      total: this.storage.size,
      byType: {
        episodic: 0,
        semantic: 0,
        procedural: 0,
        emotional: 0,
        prospective: 0,
        behavioral: 0,
        narrative: 0,
        shared: 0,
        temporal: 0,
      },
    };
    this.storage.forEach((item) => {
      stats.byType[item.type]++;
    });
    return stats;
  }
}

export const memoryStore = {
  managers: new Map<string, MemoryManager>(),

  getManager(agentId: string): MemoryManager {
    if (!this.managers.has(agentId)) {
      this.managers.set(agentId, new MemoryManager(agentId));
    }
    return this.managers.get(agentId)!;
  },
};
