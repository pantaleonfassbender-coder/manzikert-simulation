import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

// The control flag and the persisted games share one store. The flag lets the
// dashboard stop an in-flight run, and the list of completed game indices lets
// it resume by re-firing only the games that are still missing. Neither the
// flag nor the live spectator game is ever counted here — this endpoint only
// reports the independent 300-game batch.
const CONTROL_KEY = 'run-control';
const TOTAL_GAMES = 300;

const json = (body: unknown) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
  const store = getStore('mantzikert-games');

  try {
    if (event.httpMethod === 'GET') {
      const { blobs } = await store.list();
      const completedIndices = blobs
        .map(b => b.key)
        .filter(k => /^game-\d+$/.test(k))
        .map(k => parseInt(k.slice('game-'.length), 10))
        .sort((a, b) => a - b);

      const control = await store.get(CONTROL_KEY, { type: 'json' }) as { status?: string } | null;

      return json({
        status: control?.status || 'idle',
        total: TOTAL_GAMES,
        completed: completedIndices.length,
        completedIndices,
      });
    }

    if (event.httpMethod === 'POST') {
      const { action }: { action?: string } = JSON.parse(event.body || '{}');

      if (action === 'stop') {
        await store.setJSON(CONTROL_KEY, { status: 'stopped' });
        return json({ status: 'stopped' });
      }

      if (action === 'start' || action === 'resume') {
        await store.setJSON(CONTROL_KEY, { status: 'running' });
        return json({ status: 'running' });
      }

      return { statusCode: 400, body: 'Unknown action' };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (error: any) {
    console.error('Batch control error:', error);
    return { statusCode: 500, body: error.message };
  }
};
