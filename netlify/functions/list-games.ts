import { Handler } from '@netlify/functions';
import { getGamesStore } from '../lib/games-store';

export const handler: Handler = async () => {
  try {
    const gamesStore = getGamesStore();
    const { blobs } = await gamesStore.list();
    
    // Fetch all game data
    const games = await Promise.all(
      blobs
        .filter(b => b.key.startsWith('game-'))
        .map(async (b) => await gamesStore.get(b.key, { type: 'json' }))
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
