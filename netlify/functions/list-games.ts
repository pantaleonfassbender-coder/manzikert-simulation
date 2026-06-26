import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

export const handler: Handler = async (event) => {
  try {
    const gamesStore = getStore('mantzikert-games');
    const { blobs } = await gamesStore.list();
    const gameBlobs = blobs.filter(b => b.key.startsWith('game-'));

    // Lightweight tracker mode: return only the real count of persisted games
    // without downloading every game's JSON.
    const countOnly = event.queryStringParameters?.count === '1';
    if (countOnly) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: gameBlobs.length })
      };
    }

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
