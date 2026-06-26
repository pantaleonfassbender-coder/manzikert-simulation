import type { Context } from '@netlify/functions';
import { GameState, GameConfig } from '../../src/engine/types';
import { playOneRound } from '../../src/engine/runner';

// Resolves a single round for the spectator/demo game. Netlify Functions v2
// (default export, `.mts`) to keep the whole function surface on the modern
// runtime. This one does not use Blobs, but staying on v2 keeps it consistent
// with the batch functions that do.
export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { state, config } = (await req.json()) as { state: GameState; config: GameConfig };

    if (!state || !config) {
      return new Response('Missing state or config', { status: 400 });
    }

    // Faction calls run concurrently and fall back gracefully if a provider is
    // unreachable, so a round always resolves.
    const nextState = await playOneRound(state, config.roles);

    return Response.json({ nextState });
  } catch (error: any) {
    console.error('Error in play-round:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
