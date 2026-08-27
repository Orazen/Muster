/**
 * Template Marketplace for Muster+
 * Pre-built agent teams for common use cases
 */

import { v4 as uuidv4 } from 'uuid';

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  agents: TemplateAgent[];
  author: string;
  rating: number;
  downloads: number;
  price: number;
  tags: string[];
  icon: string;
  featured: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateAgent {
  name: string;
  role: string;
  model: string;
  systemPrompt: string;
  capabilities: string[];
}

export class TemplateMarketplace {
  private templates: Map<string, AgentTemplate> = new Map();
  private userTemplates: Set<string> = new Set();

  constructor() {
    this.initializeBuiltInTemplates();
  }

  private initializeBuiltInTemplates(): void {
    const builtIn: AgentTemplate[] = [
      {
        id: 'coding-companion',
        name: 'Coding Companion',
        description: 'Codex + Claude reviewer + GitHub integration for full-stack development',
        category: 'coding',
        agents: [
          { name: 'Coder', role: 'Senior Developer', model: 'openai/gpt-4o', systemPrompt: 'You are an expert software developer. Write clean, efficient, well-documented code.', capabilities: ['code_generation', 'debugging', 'refactoring'] },
          { name: 'Reviewer', role: 'Code Reviewer', model: 'anthropic/claude-sonnet-4.5', systemPrompt: 'You are a meticulous code reviewer. Find bugs, suggest improvements, ensure best practices.', capabilities: ['code_review', 'security_audit', 'performance_analysis'] },
          { name: 'GitHub Helper', role: 'Version Control', model: 'openai/gpt-4o-mini', systemPrompt: 'You help with Git operations, PR management, and CI/CD workflows.', capabilities: ['git_operations', 'pr_management', 'ci_cd'] },
        ],
        author: 'Muster Team', rating: 4.9, downloads: 0, price: 0,
        tags: ['coding', 'development', 'github', 'fullstack'], icon: '💻', featured: true,
        createdAt: Date.now(), updatedAt: Date.now(),
      },
      {
        id: 'writing-assistant',
        name: 'Writing Assistant',
        description: 'Claude + Editor + Researcher for content creation and editing',
        category: 'writing',
        agents: [
          { name: 'Writer', role: 'Content Writer', model: 'anthropic/claude-sonnet-4.5', systemPrompt: 'You are a skilled writer. Create engaging, well-structured content for any purpose.', capabilities: ['content_creation', 'storytelling', 'copywriting'] },
          { name: 'Editor', role: 'Content Editor', model: 'anthropic/claude-3-opus', systemPrompt: 'You are a professional editor. Improve clarity, grammar, style, and impact.', capabilities: ['editing', 'proofreading', 'style_improvement'] },
          { name: 'Researcher', role: 'Research Analyst', model: 'google/gemini-2.5-pro', systemPrompt: 'You research topics thoroughly, verify facts, and provide accurate information.', capabilities: ['research', 'fact_checking', 'data_analysis'] },
        ],
        author: 'Muster Team', rating: 4.8, downloads: 0, price: 0,
        tags: ['writing', 'content', 'editing', 'research'], icon: '✍️', featured: true,
        createdAt: Date.now(), updatedAt: Date.now(),
      },
      {
        id: 'personal-assistant',
        name: 'Personal Assistant',
        description: 'Calendar, email, tasks - your daily productivity partner',
        category: 'productivity',
        agents: [
          { name: 'Scheduler', role: 'Calendar Manager', model: 'openai/gpt-4o-mini', systemPrompt: 'You manage calendars, schedule meetings, and optimize time.', capabilities: ['calendar_management', 'scheduling', 'reminders'] },
          { name: 'Email Assistant', role: 'Email Manager', model: 'anthropic/claude-sonnet-4.5', systemPrompt: 'You draft emails, sort inbox, and manage correspondence.', capabilities: ['email_drafting', 'inbox_management', 'follow_ups'] },
          { name: 'Task Manager', role: 'Productivity Coach', model: 'openai/gpt-4o', systemPrompt: 'You help organize tasks, set priorities, and track progress.', capabilities: ['task_management', 'prioritization', 'progress_tracking'] },
        ],
        author: 'Muster Team', rating: 4.6, downloads: 0, price: 0,
        tags: ['productivity', 'calendar', 'email', 'tasks'], icon: '📅', featured: true,
        createdAt: Date.now(), updatedAt: Date.now(),
      },
    ];
    builtIn.forEach(t => this.templates.set(t.id, t));
  }

  getAllTemplates(): AgentTemplate[] {
    return Array.from(this.templates.values());
  }

  getFeaturedTemplates(): AgentTemplate[] {
    return this.getAllTemplates().filter(t => t.featured);
  }

  getTemplate(id: string): AgentTemplate | null {
    return this.templates.get(id) || null;
  }

  async publishTemplate(template: Partial<AgentTemplate>): Promise<AgentTemplate> {
    const newTemplate: AgentTemplate = {
      ...template,
      id: uuidv4(),
      downloads: 0,
      rating: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as AgentTemplate;
    this.templates.set(newTemplate.id, newTemplate);
    this.userTemplates.add(newTemplate.id);
    return newTemplate;
  }

  async downloadTemplate(id: string): Promise<AgentTemplate | null> {
    const template = this.templates.get(id);
    if (template) {
      template.downloads++;
      this.templates.set(id, template);
      return template;
    }
    return null;
  }

  searchTemplates(query: string): AgentTemplate[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllTemplates().filter(t =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery) ||
      t.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }
}

export const templateMarketplace = new TemplateMarketplace();
