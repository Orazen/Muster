/**
 * Core Agent System for Muster+
 * Implements Vellum-inspired memory system with agent-based architecture
 */

import { v4 as uuidv4 } from 'uuid';
import { MemoryManager } from './memory';

export interface Agent {
  id: string;
  name: string;
  role: 'assistant' | 'coordinator' | 'specialist';
  model: string;
  personality: AgentPersonality;
  memory: MemoryManager;
  capabilities: string[];
  activeTasks: string[];
  status: 'idle' | 'busy' | 'thinking' | 'paused';
}

export interface AgentPersonality {
  tone: 'professional' | 'casual' | 'sarcastic' | 'formal';
  expertise: string[];
  communicationStyle: 'direct' | 'verbose' | 'concise' | 'formal';
  preferences: Record<string, any>;
}

export interface Task {
  id: string;
  description: string;
  agentId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'rejected';
  createdAt: number;
  metadata?: Record<string, any>;
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  result: any;
  timestamp: number;
  success: boolean;
}

export class AgentSystem {
  private agents: Map<string, Agent> = new Map();
  private coordinator: Agent | null = null;

  async registerAgent(agent: Agent): Promise<void> {
    this.agents.set(agent.id, agent);
    await agent.memory.set(`agent:${agent.id}`, agent);
    if (agent.role === 'coordinator') {
      this.coordinator = agent;
    }
  }

  getAgent(id: string): Agent | null {
    return this.agents.get(id) || null;
  }

  async createAgent(spec: Partial<Agent>): Promise<Agent> {
    const agentId = spec.id || uuidv4();
    const newAgent: Agent = {
      id: agentId,
      name: spec.name || 'New Agent',
      role: spec.role || 'assistant',
      model: spec.model || 'gpt-4o',
      personality: spec.personality || this.createDefaultPersonality(),
      memory: new MemoryManager(agentId),
      capabilities: spec.capabilities || [],
      activeTasks: [],
      status: 'idle',
    };
    await this.registerAgent(newAgent);
    return newAgent;
  }

  private createDefaultPersonality(): AgentPersonality {
    return {
      tone: 'professional',
      expertise: [],
      communicationStyle: 'direct',
      preferences: {},
    };
  }

  async delegateTask(agentId: string, task: Task): Promise<TaskResult> {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    agent.status = 'busy';
    try {
      const result = await this.executeTask(agent, task);
      return result;
    } finally {
      agent.status = 'idle';
    }
  }

  private async executeTask(agent: Agent, task: Task): Promise<TaskResult> {
    const response = await this.callAgent(agent, task);
    await agent.memory.set(`task:${task.id}`, response);
    return {
      taskId: task.id,
      agentId: agent.id,
      result: response,
      timestamp: Date.now(),
      success: true,
    };
  }

  private async callAgent(agent: Agent, task: Task): Promise<any> {
    return {
      content: `Agent ${agent.name} processed task: ${task.description}`,
      metadata: {
        agentId: agent.id,
        model: agent.model,
        confidence: 0.95,
      },
    };
  }

  async approveTask(taskId: string, approved: boolean, comment?: string): Promise<TaskResult> {
    const coordinator = this.coordinator;
    if (!coordinator) {
      throw new Error('No coordinator agent configured');
    }
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const result: TaskResult = {
      taskId,
      agentId: task.agentId,
      result: {
        content: `Task ${approved ? 'approved' : 'rejected'} by coordinator`,
        comment,
      },
      timestamp: Date.now(),
      success: true,
    };
    await coordinator.memory.set(`approval:${taskId}`, result);
    return result;
  }

  async getTask(taskId: string): Promise<Task | null> {
    for (const agent of this.agents.values()) {
      const task = await agent.memory.get(`task:${taskId}`);
      if (task) {
        return task;
      }
    }
    return null;
  }
}

export const agentSystem = new AgentSystem();
