import { Handler } from '@netlify/functions';
import { GameState, GameConfig } from '../../src/engine/types';
import { playOneRound } from '../../src/engine/runner';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { state, config }: { state: GameState, config: GameConfig } = JSON.parse(event.body || '{}');

    if (!state || !config) {
      return { statusCode: 400, body: 'Missing state or config' };
    }

    // Resolve exactly one round for the spectator/demo game. Faction calls run
    // concurrently and fall back gracefully if a provider is unreachable.
    const nextState = await playOneRound(state, config.roles);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextState })
    };
  } catch (error: any) {
    console.error('Error in play-round:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
