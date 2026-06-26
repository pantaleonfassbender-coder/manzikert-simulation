import type { ModelProvider } from './types';

export const MODEL_NAMES: Record<ModelProvider, string> = {
  openai: 'gpt-5.5',
  gemini: 'gemini-3.1-pro-preview',
  claude: 'claude-opus-4-8',
};

// Single source of truth for sampling temperature (tau) across every provider.
// Fixed at 0.7 so all three models sample with the same randomness, making
// cross-model comparisons fair and game outcomes reproducible in aggregate.
// Change this one value to control the temperature for the whole simulation.
export const SAMPLING_TEMPERATURE = 0.7;
