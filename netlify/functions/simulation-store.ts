import { getStore } from '@netlify/blobs';

export const GAMES_STORE = 'mantzikert-games';
export const DEFAULT_BATCH_ID = 'main';
export const TOTAL_BACKGROUND_GAMES = 299;

export type BatchStatus = {
  batchId: string;
  totalGames: number;
  completedGames: number;
  status: 'idle' | 'running' | 'cancelled' | 'completed';
  startedAt: string | null;
  updatedAt: string | null;
  message?: string;
};

export const statusKey = (batchId: string) => `series-${batchId}-status`;
export const cancelKey = (batchId: string) => `series-${batchId}-cancelled`;

export function getGamesStore() {
  return getStore({ name: GAMES_STORE, consistency: 'strong' });
}

export function emptyStatus(batchId = DEFAULT_BATCH_ID): BatchStatus {
  return {
    batchId,
    totalGames: TOTAL_BACKGROUND_GAMES,
    completedGames: 0,
    status: 'idle',
    startedAt: null,
    updatedAt: null,
  };
}

export async function readStatus(batchId = DEFAULT_BATCH_ID): Promise<BatchStatus> {
  const store = getGamesStore();
  const status = await store.get(statusKey(batchId), { type: 'json' }) as BatchStatus | null;
  return status ?? emptyStatus(batchId);
}

export async function writeStatus(status: BatchStatus): Promise<void> {
  const store = getGamesStore();
  await store.setJSON(statusKey(status.batchId), {
    ...status,
    updatedAt: new Date().toISOString(),
  });
}

export async function isBatchCancelled(batchId = DEFAULT_BATCH_ID): Promise<boolean> {
  const store = getGamesStore();
  return Boolean(await store.get(cancelKey(batchId), { type: 'json' }));
}

export async function countCompletedGames(): Promise<number> {
  const store = getGamesStore();
  const { blobs } = await store.list({ prefix: 'game-' });
  return blobs.length;
}
