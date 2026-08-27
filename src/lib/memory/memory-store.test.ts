/**
 * Memory Store Tests
 */
import { describe, it, expect } from 'vitest';
import { MemoryManager } from './memory-store';

describe('MemoryManager', () => {
  it('should create memory manager', () => {
    const memory = new MemoryManager('test-agent');
    expect(memory).toBeDefined();
  });

  it('should store and retrieve episodic memory', async () => {
    const memory = new MemoryManager('test-agent');
    await memory.add('episodic', 'user_met', { event: 'first meeting' });
    const all = await memory.list();
    expect(all.episodic).toBeDefined();
  });

  it('should get memory stats', async () => {
    const memory = new MemoryManager('test-agent');
    const stats = await memory.getStats();
    expect(stats).toBeDefined();
  });
});
