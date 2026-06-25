import { Handler } from '@netlify/functions';
import { getGamesStore } from './simulation-store';

export const handler: Handler = async () => {
  try {
    const gamesStore = getGamesStore();
    const { blobs } = await gamesStore.list({ prefix: 'game-' });
    
    // Fetch all game data
    const games = await Promise.all(
      blobs
        .sort((a, b) => Number(a.key.replace('game-', '')) - Number(b.key.replace('game-', '')))
        .map(async (b) => await gamesStore.get(b.key, { type: 'json' }))
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ games })
    };
  } catch (error: any) {
    console.error('List games error:', error);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        games: [],
        warning: 'Simulation storage is not available yet. Try again from the deployed Netlify site.',
      }),
    };
  }
};
