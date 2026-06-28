import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import {
  BATCH_STATUS_KEY,
  createBatchStatus,
  SAVED_GAME_COUNT,
  type BatchStatus,
} from '../../src/engine/batch';

type BatchAction = 'start' | 'pause' | 'resume' | 'status';

async function getStatus() {
  const gamesStore = getStore('mantzikert-games');
  return ((await gamesStore.get(BATCH_STATUS_KEY, { type: 'json' }).catch(() => null)) as BatchStatus | null) || createBatchStatus();
}

export const handler: Handler = async (event) => {
  const gamesStore = getStore('mantzikert-games');

  try {
    const action: BatchAction = event.httpMethod === 'GET'
      ? 'status'
      : JSON.parse(event.body || '{}').action;

    if (action === 'status') {
      const status = await getStatus();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(status),
      };
    }

    if (action === 'start') {
      const { blobs } = await gamesStore.list();
      await Promise.all(
        blobs
          .filter((blob) => blob.key.startsWith('game-') || blob.key.startsWith('batch-'))
          .map((blob) => gamesStore.delete(blob.key)),
      );

      const status = createBatchStatus({
        state: 'running',
        updatedAt: new Date().toISOString(),
      });
      await gamesStore.setJSON(BATCH_STATUS_KEY, status);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(status),
      };
    }

    if (action === 'pause') {
      const status = await getStatus();
      const paused = createBatchStatus({
        ...status,
        state: status.completedGames >= SAVED_GAME_COUNT ? 'completed' : 'paused',
        activeBatchStart: null,
        activeBatchCount: 0,
        inFlightGames: 0,
        updatedAt: new Date().toISOString(),
      });
      await gamesStore.setJSON(BATCH_STATUS_KEY, paused);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(paused),
      };
    }

    if (action === 'resume') {
      const status = await getStatus();
      const resumed = createBatchStatus({
        ...status,
        state: status.completedGames >= SAVED_GAME_COUNT ? 'completed' : 'running',
        activeBatchStart: null,
        activeBatchCount: 0,
        inFlightGames: 0,
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
      await gamesStore.setJSON(BATCH_STATUS_KEY, resumed);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resumed),
      };
    }

    return { statusCode: 400, body: 'Unknown action' };
  } catch (error: any) {
    console.error('Batch control error:', error);
    return { statusCode: 500, body: error.message };
  }
};
