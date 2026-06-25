import { Handler } from '@netlify/functions';
import {
  DEFAULT_BATCH_ID,
  TOTAL_BACKGROUND_GAMES,
  cancelKey,
  countCompletedGames,
  emptyStatus,
  getGamesStore,
  readStatus,
  statusKey,
  writeStatus,
} from './simulation-store';

async function resetSeries(batchId: string) {
  const store = getGamesStore();
  const { blobs } = await store.list();

  await Promise.all(
    blobs
      .filter(({ key }) => key.startsWith('game-') || key.startsWith('batch-') || key === cancelKey(batchId))
      .map(({ key }) => store.delete(key))
  );

  const now = new Date().toISOString();
  await store.setJSON(statusKey(batchId), {
    ...emptyStatus(batchId),
    status: 'running',
    totalGames: TOTAL_BACKGROUND_GAMES,
    startedAt: now,
    updatedAt: now,
    message: 'Simulation series started.',
  });
}

export const handler: Handler = async (event) => {
  const batchId = DEFAULT_BATCH_ID;

  try {
    if (event.httpMethod === 'POST') {
      await resetSeries(batchId);
    } else if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const status = await readStatus(batchId);
    const completedGames = await countCompletedGames();
    const nextStatus = {
      ...status,
      completedGames,
      status: status.status === 'running' && completedGames >= status.totalGames ? 'completed' as const : status.status,
    };

    if (nextStatus.status !== status.status || nextStatus.completedGames !== status.completedGames) {
      await writeStatus(nextStatus);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextStatus),
    };
  } catch (error: any) {
    console.error('Batch status error:', error);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...emptyStatus(batchId),
        status: 'idle',
        message: 'Simulation storage is not available yet. Start the simulation from the deployed Netlify site.',
      }),
    };
  }
};
