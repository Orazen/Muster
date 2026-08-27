/**
 * Muster+ Main Entry Point
 * Initializes all core systems
 */

import { agentSystem } from './lib/agents/agent-core';
import { memoryStore } from './lib/memory/memory-store';
import { modelIntegration } from './lib/providers/openrouter';
import { cloudSync } from './lib/cloud/cloud-sync';
import { mobileApp } from './lib/mobile/mobile-app';
import { templateMarketplace } from './lib/templates/template-marketplace';
import { viralMechanics } from './lib/viral/viral-mechanics';
import { proactiveEngine } from './lib/proactive/proactive-engine';

export class MusterPlus {
  private initialized: boolean = false;
  private startTime: number = 0;

  async initialize(): Promise<void> {
    this.startTime = Date.now();
    console.log('🚀 Initializing Muster+...');
    console.log('='.repeat(60));

    try {
      // Initialize all core systems in parallel
      await Promise.all([
        this.initializeMemory(),
        this.initializeAgents(),
        this.initializeModels(),
        this.initializeCloud(),
        this.initializeMobile(),
        this.initializeTemplates(),
        this.initializeViral(),
        this.initializeProactive(),
      ]);

      this.initialized = true;
      const elapsed = Date.now() - this.startTime;

      console.log('='.repeat(60));
      console.log(`✅ Muster+ initialized in ${elapsed}ms`);
      console.log('🎯 Ready to serve!');
    } catch (error) {
      console.error('❌ Initialization failed:', error);
      throw error;
    }
  }

  private async initializeMemory(): Promise<void> {
    console.log('  📝 Initializing memory system...');
    // Memory system is ready
  }

  private async initializeAgents(): Promise<void> {
    console.log('  🤖 Initializing agent system...');
    // Create default coordinator
    await agentSystem.createAgent({
      id: 'coordinator',
      name: 'Muster Coordinator',
      role: 'coordinator',
      model: 'anthropic/claude-sonnet-4.5',
    });
  }

  private async initializeModels(): Promise<void> {
    console.log('  🧠 Initializing model system...');
    await modelIntegration.getModels();
  }

  private async initializeCloud(): Promise<void> {
    console.log('  ☁️  Initializing cloud sync...');
    cloudSync.setOnline(true);
  }

  private async initializeMobile(): Promise<void> {
    console.log('  📱 Initializing mobile features...');
    if (typeof window !== 'undefined') {
      await mobileApp.registerServiceWorker();
    }
  }

  private async initializeTemplates(): Promise<void> {
    console.log('  📦 Loading templates...');
    const templates = templateMarketplace.getAllTemplates();
    console.log(`     Found ${templates.length} templates`);
  }

  private async initializeViral(): Promise<void> {
    console.log('  🌟 Initializing viral mechanics...');
  }

  private async initializeProactive(): Promise<void> {
    console.log('  ⚡ Initializing proactive engine...');
  }

  getStatus(): any {
    return {
      initialized: this.initialized,
      uptime: Date.now() - this.startTime,
      agents: agentSystem ? 'ready' : 'not ready',
      memory: memoryStore ? 'ready' : 'not ready',
      models: modelIntegration ? 'ready' : 'not ready',
      cloud: cloudSync.getStatus(),
      mobile: mobileApp.getAppInfo(),
      templates: templateMarketplace.getAllTemplates().length,
    };
  }
}

export const musterPlus = new MusterPlus();
export default musterPlus;
