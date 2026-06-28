import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

export const handler: Handler = async () => {
  try {
    const gamesStore = getStore('mantzikert-games');
    const { blobs } = await gamesStore.list();
    
    // Fetch all game data
    const games = await Promise.all(
      blobs
        .filter(b => /^game-\d+$/.test(b.key))
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
