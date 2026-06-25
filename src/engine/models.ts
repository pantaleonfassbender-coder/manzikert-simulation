import type { ModelProvider } from './types';

export const MODEL_NAMES: Record<ModelProvider, string> = {
  openai: 'gpt-5.5',
  gemini: 'gemini-3.1-pro-preview',
  claude: 'claude-opus-4-8',
};
