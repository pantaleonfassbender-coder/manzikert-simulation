import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Faction, ActionAllocation, ModelProvider } from '../../src/engine/types';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';

// Helper to delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// Neutral allocation used when an LLM call cannot be recovered. Keeping a
// game moving with a balanced default is far better than aborting it.
const NEUTRAL: ActionAllocation = {
  military: 34,
  diplomacy: 33,
  internal: 33,
  messages: {},
  selfAssessment: 'No response (fallback).',
};

// Call an LLM with a few retries. Transient gateway errors (timeouts, 429s
// from concurrent batches, or malformed JSON) are common when many background
// functions run at once; without this a single failure used to abort the
// entire batch, which is why runs "faded out" mid-way.
async function callWithRetry(provider: ModelProvider, prompt: string): Promise<ActionAllocation> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callLLM(provider, prompt);
    } catch (err) {
      if (attempt === 2) {
        console.error(`LLM ${provider} failed after retries, using fallback:`, err);
        return NEUTRAL;
      }
      await delay(400 * (attempt + 1));
    }
  }
  return NEUTRAL;
}

export const handler: Handler = async (event) => {
  try {
    const { batchId, startIndex, count }: { batchId: string, startIndex: number, count: number } = JSON.parse(event.body || '{}');

    if (!batchId) {
      return { statusCode: 400, body: 'Missing batchId' };
    }

    const gamesStore = getStore('mantzikert-games');

    for (let i = 0; i < count; i++) {
      const gameIndex = startIndex + i;
      const gameId = `game-${gameIndex}`;

      // Isolate each game: a failure in one must not abandon the rest of the
      // batch (the previous behaviour, which caused runs to fade out).
      try {
        // Determine roles based on index (1-100, 101-200, 201-300)
        // Since it's 0-indexed:
        // 0-99: openai, gemini, claude
        // 100-199: gemini, claude, openai
        // 200-299: claude, openai, gemini
        let roles: Record<Faction, any> = { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
        if (gameIndex >= 100 && gameIndex < 200) {
          roles = { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
        } else if (gameIndex >= 200) {
          roles = { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
        }

        let state = createInitialState(gameId);

        for (let round = 1; round <= 12; round++) {
          const previousRound = state.history.length > 0 ? state.history[state.history.length - 1] : null;

          const emperorPrompt = generatePrompt('emperor', state, previousRound?.allocations.emperor);
          const foesPrompt = generatePrompt('foes', state, previousRound?.allocations.foes);
          const seljuksPrompt = generatePrompt('seljuks', state, previousRound?.allocations.seljuks);

          const [emperorAction, foesAction, seljuksAction] = await Promise.all([
            callWithRetry(roles.emperor, emperorPrompt),
            callWithRetry(roles.foes, foesPrompt),
            callWithRetry(roles.seljuks, seljuksPrompt)
          ]);

          state = resolveRound(state, {
            emperor: emperorAction,
            foes: foesAction,
            seljuks: seljuksAction
          });
        }

        // Save completed game to blobs so the tracker can count progress
        await gamesStore.setJSON(gameId, { gameId, roles, finalState: state });
      } catch (gameError: any) {
        console.error(`Game ${gameId} failed, continuing with batch:`, gameError);
      }
    }

    // Save batch summary
    await gamesStore.setJSON(`batch-${batchId}-${startIndex}`, { startIndex, count, completed: true });

    return { statusCode: 200, body: 'Batch completed' };
  } catch (error: any) {
    console.error('Background batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
