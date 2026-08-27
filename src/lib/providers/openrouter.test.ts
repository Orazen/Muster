/**
 * OpenRouter Integration Tests
 */
import { describe, it, expect } from 'vitest';
import { modelIntegration } from './openrouter';

describe('OpenRouter', () => {
  it('should initialize without error', () => {
    expect(modelIntegration).toBeDefined();
  });

  it('should get models list', async () => {
    const models = await modelIntegration.getModels();
    expect(Array.isArray(models)).toBe(true);
  });

  it('should set API key', () => {
    modelIntegration.setApiKey('test-key');
    expect(localStorage.getItem('openrouter_api_key')).toBe('test-key');
  });
});
