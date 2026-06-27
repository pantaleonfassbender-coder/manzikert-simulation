import { Handler } from '@netlify/functions';
import { GameState, GameConfig, Faction, ActionAllocation } from '../../src/engine/types';
import { resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';
import { isAuthed, unauthorized } from '../../src/server/auth';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!isAuthed(event)) return unauthorized();

  try {
    const { state, config }: { state: GameState; config: GameConfig } = JSON.parse(event.body || '{}');

    if (!state || !config) {
      return { statusCode: 400, body: 'Missing state or config' };
    }

    const previousRound = state.history.length > 0 ? state.history[state.history.length - 1] : null;

    // Generate Prompts
    const emperorPrompt = generatePrompt('emperor', state, previousRound?.allocations.emperor);
    const foesPrompt = generatePrompt('foes', state, previousRound?.allocations.foes);
    const seljuksPrompt = generatePrompt('seljuks', state, previousRound?.allocations.seljuks);

    // Call LLMs concurrently (inference proxied through Netlify AI Gateway).
    // If a model call fails we surface the error instead of substituting
    // fabricated allocations, so the dashboard never shows invented data.
    const [emperorAction, foesAction, seljuksAction] = await Promise.all([
      callLLM(config.roles.emperor, emperorPrompt),
      callLLM(config.roles.foes, foesPrompt),
      callLLM(config.roles.seljuks, seljuksPrompt),
    ]);

    const allocations: Record<Faction, ActionAllocation> = {
      emperor: emperorAction,
      foes: foesAction,
      seljuks: seljuksAction,
    };

    const nextState = resolveRound(state, allocations);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextState }),
    };
  } catch (error: any) {
    console.error('Error in play-round:', error);
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.message }) };
  }
};
