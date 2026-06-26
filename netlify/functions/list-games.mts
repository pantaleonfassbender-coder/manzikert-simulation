import type { Context } from '@netlify/functions';
import { gamesStore, getControl } from '../../src/engine/batchStore';

// Lists every completed game plus the current run control record so the
// dashboard can export results to Excel at any time. Netlify Functions v2
// (default export, `.mts`) so the Blobs context is available with no config.
export default async (_req: Request, _context: Context): Promise<Response> => {
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

    return Response.json({ games, control });
  } catch (error: any) {
    console.error('List games error:', error);
    return new Response(error.message, { status: 500 });
  }
};
