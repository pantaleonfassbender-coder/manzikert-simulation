import { Handler } from '@netlify/functions';
import { gamesStore, getControl } from '../../src/engine/batchStore';

export const handler: Handler = async () => {
  try {
    const store = gamesStore();
    const { blobs } = await store.list();

    // Only game records (skip the control key and any batch metadata).
    const games = (
      await Promise.all(
        blobs
          .filter((b) => b.key.startsWith('game-'))
          .map((b) => store.get(b.key, { type: 'json' })),
      )
    ).filter(Boolean);

    const control = await getControl();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ games, control }),
    };
  } catch (error: any) {
    console.error('List games error:', error);
    return { statusCode: 500, body: error.message };
  }
};
