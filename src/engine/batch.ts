import type { Faction, GameConfig, ModelProvider } from './types';

export const SAVED_GAME_COUNT = 300;
export const SAVED_BATCH_SIZE = 30;
export const MODEL_TAU = 0.7;
export const BATCH_STATUS_KEY = 'batch-main-status';
export const BATCH_ID = 'main';

export type BatchRunState = 'idle' | 'running' | 'paused' | 'completed' | 'error';

export interface ModelProgress {
  total: number;
  emperor: number;
  foes: number;
  seljuks: number;
}

export interface BatchStatus {
  batchId: string;
  state: BatchRunState;
  totalGames: number;
  batchSize: number;
  nextIndex: number;
  completedGames: number;
  activeBatchStart: number | null;
  activeBatchCount: number;
  inFlightGames: number;
  modelProgress: Record<ModelProvider, ModelProgress>;
  lastError: string | null;
  updatedAt: string;
}

export const EMPTY_MODEL_PROGRESS: Record<ModelProvider, ModelProgress> = {
  openai: { total: 0, emperor: 0, foes: 0, seljuks: 0 },
  gemini: { total: 0, emperor: 0, foes: 0, seljuks: 0 },
  claude: { total: 0, emperor: 0, foes: 0, seljuks: 0 },
};

export function createBatchStatus(overrides: Partial<BatchStatus> = {}): BatchStatus {
  return {
    batchId: BATCH_ID,
    state: 'idle',
    totalGames: SAVED_GAME_COUNT,
    batchSize: SAVED_BATCH_SIZE,
    nextIndex: 0,
    completedGames: 0,
    activeBatchStart: null,
    activeBatchCount: 0,
    inFlightGames: 0,
    modelProgress: structuredClone(EMPTY_MODEL_PROGRESS),
    lastError: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function getRolesForSavedGame(gameIndex: number): GameConfig['roles'] {
  if (gameIndex >= 100 && gameIndex < 200) {
    return { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
  }

  if (gameIndex >= 200) {
    return { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
  }

  return { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
}

export function addCompletedGame(progress: Record<ModelProvider, ModelProgress>, roles: Record<Faction, ModelProvider>) {
  const next = structuredClone(progress);

  (Object.entries(roles) as Array<[Faction, ModelProvider]>).forEach(([faction, provider]) => {
    next[provider].total += 1;
    next[provider][faction] += 1;
  });

  return next;
}
