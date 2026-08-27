/**
 * Agent System Tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentSystem, agentSystem } from './agent-core';

describe('AgentSystem', () => {
  it('should create an agent system', () => {
    const system = new AgentSystem('test-user');
    expect(system).toBeDefined();
  });

  it('should have predefined agents', () => {
    const agents = agentSystem.getAll();
    expect(agents.length).toBeGreaterThan(0);
  });

  it('should create new agent', async () => {
    const agent = await agentSystem.createAgent({
      name: 'Test Agent',
      type: 'general',
      capabilities: ['chat'],
    });
    expect(agent.id).toBeDefined();
    expect(agent.name).toBe('Test Agent');
  });
});
