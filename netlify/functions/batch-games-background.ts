import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Faction, GameState, ModelProvider } from '../../src/engine/types';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';

// Helper to delay
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

// A failed game run (API failure / malformed JSON that survives the per-call
// retries) is discarded and re-run from scratch, per preregistration Q6.
const MAX_GAME_ATTEMPTS = 5;

// Strict role rotation: every 100 games each model occupies a different
// faction, so each foundation model experiences all three factions exactly
// once across the 0-99 / 100-199 / 200-299 blocks.
function rolesForIndex(gameIndex: number): Record<Faction, ModelProvider> {
  if (gameIndex >= 200) {
    return { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
  }
  if (gameIndex >= 100) {
    return { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
  }
  return { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
}

// Play one complete 12-round game. Throws if any model call ultimately fails,
// so the caller can discard the partial run and re-run.
async function simulateGame(gameId: string, roles: Record<Faction, ModelProvider>): Promise<GameState> {
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

  return state;
}

export const handler: Handler = async (event) => {
  try {
    const { batchId, startIndex, count }: { batchId: string; startIndex: number; count: number } = JSON.parse(
      event.body || '{}',
    );

    if (!batchId) {
      return { statusCode: 400, body: 'Missing batchId' };
    }

    const gamesStore = getStore('mantzikert-games');
    const completed: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < count; i++) {
      const gameIndex = startIndex + i;
      const gameId = `game-${gameIndex}`;
      const roles = rolesForIndex(gameIndex);

      let finalState: GameState | null = null;

      // Discard-and-re-run loop: a malformed/timed-out run is thrown away
      // entirely and replayed from round 1 until it completes cleanly.
      for (let attempt = 1; attempt <= MAX_GAME_ATTEMPTS; attempt++) {
        try {
          finalState = await simulateGame(gameId, roles);
          break;
        } catch (error) {
          console.error(`Game ${gameId} attempt ${attempt}/${MAX_GAME_ATTEMPTS} discarded; re-running:`, error);
          finalState = null;
        }
      }

      if (!finalState) {
        // Do NOT persist fabricated or partial data. The game is simply left
        // unsaved; the dashboard's completeness check will report fewer than
        // 300 games so the batch can be re-triggered to fill the gap.
        console.error(`Game ${gameId} failed after ${MAX_GAME_ATTEMPTS} attempts; leaving unsaved.`);
        failed.push(gameId);
        continue;
      }

      await gamesStore.setJSON(gameId, { gameId, roles, finalState });
      completed.push(gameId);
    }

    // Save batch summary
    await gamesStore.setJSON(`batch-${batchId}-${startIndex}`, {
      startIndex,
      count,
      completed: completed.length,
      failed,
      done: true,
    });

    return { statusCode: 200, body: `Batch completed: ${completed.length} saved, ${failed.length} failed.` };
  } catch (error: any) {
    console.error('Background batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
