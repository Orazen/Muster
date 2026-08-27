/**
 * Universal Model Integration for Muster+
 * Uses OpenRouter as gateway to 200+ AI models
 */

export interface ModelInfo {
  id: string;
  label: string;
  vision: boolean;
  provider: string;
  price?: ModelPricing;
  contextLength?: number;
}

export interface ModelPricing {
  prompt: number;
  completion: number;
  image?: number;
}

export class ModelIntegration {
  private baseUrl: string = 'https://openrouter.ai/api/v1';
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.OPENROUTER_API_KEY || '';
  }

  async getModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }

      const data = await response.json();
      return data.data.map((model: any) => this.parseModel(model));
    } catch (error) {
      console.error('Failed to get models:', error);
      return this.getFallbackModels();
    }
  }

  private parseModel(model: any): ModelInfo {
    return {
      id: model.id,
      label: model.name || model.id.split('/').pop() || model.id,
      vision: this.detectVisionCapability(model.id),
      provider: this.extractProvider(model.id),
      contextLength: model.context_length,
      price: model.pricing ? {
        prompt: parseFloat(model.pricing.prompt) * 1000000,
        completion: parseFloat(model.pricing.completion) * 1000000,
        image: model.pricing.image ? parseFloat(model.pricing.image) * 1000 : undefined,
      } : undefined,
    };
  }

  private detectVisionCapability(modelId: string): boolean {
    const visionModels = [
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'anthropic/claude-3-5-sonnet',
      'anthropic/claude-3-opus',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.2-90b-vision-instruct',
    ];
    return visionModels.some(v => modelId.includes(v));
  }

  private extractProvider(modelId: string): string {
    return modelId.split('/')[0] || 'unknown';
  }

  private getFallbackModels(): ModelInfo[] {
    return [
      { id: 'openai/gpt-4o', label: 'GPT-4o', vision: true, provider: 'openai' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', vision: true, provider: 'openai' },
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', vision: true, provider: 'anthropic' },
      { id: 'anthropic/claude-3-opus', label: 'Claude 3 Opus', vision: true, provider: 'anthropic' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', vision: true, provider: 'google' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', vision: true, provider: 'google' },
      { id: 'meta-llama/llama-3.1-405b-instruct', label: 'Llama 3.1 405B', vision: false, provider: 'meta-llama' },
      { id: 'mistralai/mistral-large', label: 'Mistral Large', vision: false, provider: 'mistralai' },
    ];
  }

  async chat(messages: any[], model: string = 'openai/gpt-4o', options: any = {}): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://muster-plus.heyworld.ai',
          'X-Title': 'Muster+ AI Assistant',
        },
        body: JSON.stringify({
          model,
          messages,
          ...options,
        }),
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Chat request failed:', error);
      throw error;
    }
  }
}

export const modelIntegration = new ModelIntegration();
