import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

const TOTAL_GAMES = 299;
const BATCH_ID = 'main';

const jsonResponse = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
  try {
    const gamesStore = getStore({ name: 'mantzikert-games', consistency: 'strong' });
    const runKey = `batch-run-${BATCH_ID}`;

    if (event.httpMethod === 'POST') {
      const now = new Date().toISOString();
      await gamesStore.setJSON(runKey, {
        batchId: BATCH_ID,
        totalGames: TOTAL_GAMES,
        status: 'starting',
        startedAt: now,
        updatedAt: now,
      });
    }

    const [{ blobs }, run] = await Promise.all([
      gamesStore.list(),
      gamesStore.get(runKey, { type: 'json' }) as Promise<Record<string, unknown> | null>,
    ]);

    const completedGames = blobs.filter((blob) => /^game-\d+$/.test(blob.key) && blob.key !== 'game-0').length;
    const completedBatches = blobs.filter((blob) => blob.key.startsWith(`batch-${BATCH_ID}-`)).length;
    const status = completedGames >= TOTAL_GAMES ? 'complete' : run?.status || 'not-started';
    const percent = Math.min(100, Math.round((completedGames / TOTAL_GAMES) * 100));

    return jsonResponse(200, {
      batchId: BATCH_ID,
      totalGames: TOTAL_GAMES,
      completedGames,
      completedBatches,
      percent,
      status,
      startedAt: run?.startedAt || null,
      updatedAt: run?.updatedAt || null,
      lastCompletedGameId: run?.lastCompletedGameId || null,
    });
  } catch (error: any) {
    console.error('Batch progress error:', error);
    return jsonResponse(500, { error: error.message });
  }
};
