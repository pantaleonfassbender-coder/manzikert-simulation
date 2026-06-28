import { Handler } from '@netlify/functions';
import { GameState, GameConfig, ActionAllocation, Faction } from '../../src/engine/types';
import { resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';

// NOTE: This endpoint backs the interactive single-game "spectator" view only.
// It intentionally does NOT substitute fallback/placeholder allocations on
// failure — fabricated moves and canned self-assessment text would contaminate
// the LIWC-22 / action-point dataset. If a model call fails (after the internal
// retries in callLLM) the round is reported as failed so it can be replayed.
// The 300-game research dataset is produced exclusively by the background batch
// function, which discards and re-runs any failed game (preregistration Q6).

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

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
    // Any rejection propagates so the round is reported as failed rather than
    // silently filled with fabricated data.
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

    // Resolve Round
    const nextState = resolveRound(state, allocations);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextState }),
    };
  } catch (error: any) {
    console.error('Error in play-round:', error);
    // 502: an upstream model call failed. The client should retry the round.
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message }),
    };
  }
};
