import type { ModelProvider } from './types';

export const MODEL_NAMES: Record<ModelProvider, string> = {
  openai: 'gpt-5.4-mini',
  gemini: 'gemini-3-flash-preview',
  claude: 'claude-haiku-4-5',
};
