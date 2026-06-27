import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Faction, ModelProvider } from '../../src/engine/types';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';
import { isAuthed, unauthorized } from '../../src/server/auth';

const CONTROL_KEY = 'run';

// Helper to delay
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Role assignment is purely a function of the game index, so the 300-game run is
// fully self-contained and reproducible regardless of any live/spectator game.
//   0-99   : openai / gemini / claude
//   100-199: gemini / claude / openai
//   200-299: claude / openai / gemini
function rolesForIndex(gameIndex: number): Record<Faction, ModelProvider> {
  if (gameIndex >= 200) return { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
  if (gameIndex >= 100) return { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
  return { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
}

export const handler: Handler = async (event) => {
  if (!isAuthed(event)) return unauthorized();

  try {
    const { startIndex, count }: { startIndex: number; count: number } = JSON.parse(event.body || '{}');

    if (typeof startIndex !== 'number' || typeof count !== 'number') {
      return { statusCode: 400, body: 'Missing startIndex or count' };
    }

    const gamesStore = getStore('mantzikert-games');
    const controlStore = getStore('mantzikert-control');

    for (let i = 0; i < count; i++) {
      const gameIndex = startIndex + i;
      const gameId = `game-${gameIndex}`;

      // Honour the stop signal between games so the run can be paused and resumed.
      const control = (await controlStore.get(CONTROL_KEY, { type: 'json' })) as
        | { status?: string; stopRequested?: boolean }
        | null;
      if (control?.stopRequested || control?.status === 'paused') {
        return { statusCode: 200, body: 'Stopped by control flag' };
      }

      // Skip games that already finished — this makes resume idempotent.
      const existing = await gamesStore.get(gameId);
      if (existing) continue;

      const roles = rolesForIndex(gameIndex);
      let state = createInitialState(gameId);

      for (let round = 1; round <= 12; round++) {
        const previousRound = state.history.length > 0 ? state.history[state.history.length - 1] : null;

        const emperorPrompt = generatePrompt('emperor', state, previousRound?.allocations.emperor);
        const foesPrompt = generatePrompt('foes', state, previousRound?.allocations.foes);
        const seljuksPrompt = generatePrompt('seljuks', state, previousRound?.allocations.seljuks);

        const [emperorAction, foesAction, seljuksAction] = await Promise.all([
          callLLM(roles.emperor, emperorPrompt),
          callLLM(roles.foes, foesPrompt),
          callLLM(roles.seljuks, seljuksPrompt),
        ]);

        state = resolveRound(state, {
          emperor: emperorAction,
          foes: foesAction,
          seljuks: seljuksAction,
        });

        // Small delay to respect rate limits
        await delay(500);
      }

      await gamesStore.setJSON(gameId, { gameId, roles, finalState: state });
    }

    return { statusCode: 200, body: 'Batch completed' };
  } catch (error: any) {
    console.error('Background batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
