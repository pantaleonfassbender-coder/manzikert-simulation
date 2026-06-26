import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

export const handler: Handler = async () => {
  try {
    const gamesStore = getStore('mantzikert-games');
    const { blobs } = await gamesStore.list();

    // Fetch all game data ( `get` with type 'json' is the v10 Blobs read API ).
    const games = await Promise.all(
      blobs
        .filter(b => b.key.startsWith('game-'))
        .map(async (b) => await gamesStore.get(b.key, { type: 'json' }))
    );

    // Surface the pause flag alongside the games so the dashboard can show the
    // run status (running / paused) in a single poll.
    let paused = false;
    try {
      const controlStore = getStore({ name: 'mantzikert-games', consistency: 'strong' });
      const control = (await controlStore.get('run-control', { type: 'json' })) as { paused?: boolean } | null;
      paused = !!control?.paused;
    } catch {
      paused = false;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ games, paused })
    };
  } catch (error: any) {
    console.error('List games error:', error);
    return { statusCode: 500, body: error.message };
  }
};
