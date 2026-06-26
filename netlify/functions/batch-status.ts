import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

const TOTAL_GAMES = 299;

// Real progress tracker for the background batch run. Counts how many games
// have actually been persisted to blob storage so the UI can show genuine
// progress instead of a mocked animation.
export const handler: Handler = async () => {
  try {
    const gamesStore = getStore('mantzikert-games');
    const { blobs } = await gamesStore.list({ prefix: 'game-' });

    // Each completed background game is stored under `game-<n>` (n = 1..299).
    // The spectator placeholder (`game-0` / `game-spectator`) is not part of
    // the batch, so it is excluded from the count.
    const completed = blobs.filter(
      (b) => b.key !== 'game-spectator' && b.key !== 'game-0'
    ).length;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        completed,
        total: TOTAL_GAMES,
        done: completed >= TOTAL_GAMES,
      }),
    };
  } catch (error: any) {
    console.error('Batch status error:', error);
    return { statusCode: 500, body: error.message };
  }
};
