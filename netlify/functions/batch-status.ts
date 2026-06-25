import { Handler } from '@netlify/functions';
import {
  DEFAULT_BATCH_ID,
  countCompletedGames,
  emptyStatus,
  readStatus,
  resetSeries,
  writeStatus,
} from './simulation-store';

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
