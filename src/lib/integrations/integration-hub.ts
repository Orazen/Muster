/**
 * Integration Hub for Muster+
 * Connect with external services: Zapier, Slack, Google, etc.
 */

export interface Integration {
  id: string;
  name: string;
  category: 'productivity' | 'communication' | 'storage' | 'automation' | 'developer';
  icon: string;
  description: string;
  connected: boolean;
  config?: Record<string, any>;
  webhookUrl?: string;
  authType: 'oauth2' | 'api_key' | 'webhook' | 'none';
}

export class IntegrationHub {
  private integrations: Map<string, Integration> = new Map();
  private connectedIntegrations: Set<string> = new Set();

  constructor() {
    this.initializeIntegrations();
  }

  private initializeIntegrations(): void {
    const defaultIntegrations: Integration[] = [
      { id: 'zapier', name: 'Zapier', category: 'automation', icon: '⚡', description: 'Connect to 5,000+ apps', connected: false, authType: 'oauth2' },
      { id: 'slack', name: 'Slack', category: 'communication', icon: '💬', description: 'Send messages and notifications', connected: false, authType: 'oauth2' },
      { id: 'gmail', name: 'Gmail', category: 'communication', icon: '📧', description: 'Manage email', connected: false, authType: 'oauth2' },
      { id: 'google-calendar', name: 'Google Calendar', category: 'productivity', icon: '📅', description: 'Schedule and manage events', connected: false, authType: 'oauth2' },
      { id: 'notion', name: 'Notion', category: 'productivity', icon: '📝', description: 'Notes and databases', connected: false, authType: 'oauth2' },
      { id: 'github', name: 'GitHub', category: 'developer', icon: '🐙', description: 'Code repositories and issues', connected: false, authType: 'oauth2' },
      { id: 'discord', name: 'Discord', category: 'communication', icon: '🎮', description: 'Community chat', connected: false, authType: 'oauth2' },
      { id: 'google-drive', name: 'Google Drive', category: 'storage', icon: '☁️', description: 'File storage', connected: false, authType: 'oauth2' },
      { id: 'dropbox', name: 'Dropbox', category: 'storage', icon: '📦', description: 'File storage', connected: false, authType: 'oauth2' },
      { id: 'trello', name: 'Trello', category: 'productivity', icon: '📋', description: 'Project management', connected: false, authType: 'oauth2' },
      { id: 'asana', name: 'Asana', category: 'productivity', icon: '✅', description: 'Task management', connected: false, authType: 'oauth2' },
      { id: 'webhook', name: 'Custom Webhook', category: 'developer', icon: '🔗', description: 'Custom HTTP webhooks', connected: false, authType: 'webhook' },
    ];
    defaultIntegrations.forEach(i => this.integrations.set(i.id, i));
  }

  getAll(): Integration[] {
    return Array.from(this.integrations.values());
  }

  getByCategory(category: string): Integration[] {
    return this.getAll().filter(i => i.category === category);
  }

  getConnected(): Integration[] {
    return this.getAll().filter(i => i.connected);
  }

  getAvailable(): Integration[] {
    return this.getAll().filter(i => !i.connected);
  }

  get(id: string): Integration | null {
    return this.integrations.get(id) || null;
  }

  async connect(id: string, config?: Record<string, any>): Promise<boolean> {
    const integration = this.integrations.get(id);
    if (!integration) return false;

    integration.connected = true;
    integration.config = config;
    this.integrations.set(id, integration);
    this.connectedIntegrations.add(id);
    return true;
  }

  async disconnect(id: string): Promise<boolean> {
    const integration = this.integrations.get(id);
    if (!integration) return false;

    integration.connected = false;
    integration.config = undefined;
    this.integrations.set(id, integration);
    this.connectedIntegrations.delete(id);
    return true;
  }

  async trigger(id: string, event: string, data: any): Promise<{ success: boolean }> {
    const integration = this.integrations.get(id);
    if (!integration || !integration.connected) {
      return { success: false };
    }
    // In real implementation, would call external API
    console.log(`Trigger ${id}: ${event}`, data);
    return { success: true };
  }
}

export const integrationHub = new IntegrationHub();
