import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

export const handler: Handler = async () => {
  try {
    const gamesStore = getStore('mantzikert-games');
    const { blobs } = await gamesStore.list();
    // Only real batch games (game-<number>). This excludes the live spectator
    // game and the run-control flag, so the export is purely the 300-game run.
    const gameBlobs = blobs.filter(b => /^game-\d+$/.test(b.key));

    // Fetch all game data
    const games = await Promise.all(
      gameBlobs.map(async (b) => await gamesStore.getJSON(b.key))
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ games })
    };
  } catch (error: any) {
    console.error('List games error:', error);
    return { statusCode: 500, body: error.message };
  }
};
