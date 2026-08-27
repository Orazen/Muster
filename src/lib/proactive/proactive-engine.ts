/**
 * Proactive AI Engine for Muster+
 * Inspired by GAIA - does work for you automatically
 */

import { v4 as uuidv4 } from 'uuid';

export interface ProactiveTask {
  id: string;
  type: 'monitor' | 'reminder' | 'automation' | 'notification';
  description: string;
  trigger: TaskTrigger;
  action: TaskAction;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  createdAt: number;
}

export interface TaskTrigger {
  type: 'time' | 'event' | 'condition';
  value: string;
  metadata?: any;
}

export interface TaskAction {
  type: 'notify' | 'execute' | 'suggest' | 'automate';
  payload: any;
  agentId?: string;
}

export class ProactiveEngine {
  private tasks: Map<string, ProactiveTask> = new Map();
  private eventListeners: Map<string, Function[]> = new Map();
  private running: boolean = false;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log('Proactive engine started');
    this.startMonitoring();
  }

  async stop(): Promise<void> {
    this.running = false;
    console.log('Proactive engine stopped');
  }

  createTask(task: Omit<ProactiveTask, 'id' | 'createdAt'>): ProactiveTask {
    const newTask: ProactiveTask = {
      ...task,
      id: uuidv4(),
      createdAt: Date.now(),
    };
    this.tasks.set(newTask.id, newTask);
    return newTask;
  }

  enableTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.enabled = true;
      this.tasks.set(id, task);
    }
  }

  disableTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.enabled = false;
      this.tasks.set(id, task);
    }
  }

  getTasks(): ProactiveTask[] {
    return Array.from(this.tasks.values());
  }

  on(event: string, callback: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }

  emit(event: string, data: any): void {
    const listeners = this.eventListeners.get(event) || [];
    listeners.forEach(cb => cb(data));
  }

  private startMonitoring(): void {
    setInterval(() => this.checkTasks(), 60000);
  }

  private async checkTasks(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (task.nextRun && task.nextRun > now) continue;
      await this.executeTask(task);
      task.lastRun = now;
      task.nextRun = now + 60000;
      this.tasks.set(task.id, task);
    }
  }

  private async executeTask(task: ProactiveTask): Promise<void> {
    console.log(`Executing task: ${task.description}`);
    this.emit('task:executed', task);
  }
}

export const proactiveEngine = new ProactiveEngine();
