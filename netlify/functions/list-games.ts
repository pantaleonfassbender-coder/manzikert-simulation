import { Handler } from '@netlify/functions';
import { connectLambda, getStore } from '@netlify/blobs';

export const handler: Handler = async (event) => {
  try {
    connectLambda(event);

    const gamesStore = getStore({
      name: 'mantzikert-games',
      consistency: 'eventual',
    });
    const { blobs } = await gamesStore.list({ consistency: 'eventual' });
    
    // Fetch all game data
    const games = await Promise.all(
      blobs
        .filter(b => b.key.startsWith('game-'))
        .map(async (b) => await gamesStore.get(b.key, { type: 'json', consistency: 'eventual' }))
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
