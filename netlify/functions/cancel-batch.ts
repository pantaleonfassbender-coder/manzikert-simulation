import { Handler } from '@netlify/functions';
import {
  DEFAULT_BATCH_ID,
  cancelKey,
  connectSimulationStore,
  getGamesStore,
  readStatus,
  writeStatus,
} from './simulation-store';

export const handler: Handler = async (event) => {
  connectSimulationStore(event);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const store = getGamesStore();
    const batchId = DEFAULT_BATCH_ID;
    await store.setJSON(cancelKey(batchId), { cancelledAt: new Date().toISOString() });

    const status = await readStatus(batchId);
    await writeStatus({
      ...status,
      status: 'cancelled',
      message: 'Simulation series cancellation requested.',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (error: any) {
    console.error('Cancel batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
