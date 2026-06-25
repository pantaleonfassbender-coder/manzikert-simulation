import { Handler } from '@netlify/functions';
import { connectLambda, getStore } from '@netlify/blobs';
import { Faction } from '../../src/engine/types';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';

// Helper to delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export const handler: Handler = async (event) => {
  try {
    connectLambda(event);

    const { batchId, startIndex, count }: { batchId: string, startIndex: number, count: number } = JSON.parse(event.body || '{}');

    if (!batchId) {
      return { statusCode: 400, body: 'Missing batchId' };
    }

    const gamesStore = getStore({
      name: 'mantzikert-games',
      consistency: 'eventual',
    });
    const results = [];

    for (let i = 0; i < count; i++) {
      const gameIndex = startIndex + i;
      const gameId = `game-${gameIndex}`;
      
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
          callLLM(roles.emperor, emperorPrompt),
          callLLM(roles.foes, foesPrompt),
          callLLM(roles.seljuks, seljuksPrompt)
        ]);

        state = resolveRound(state, {
          emperor: emperorAction,
          foes: foesAction,
          seljuks: seljuksAction
        });

        // Small delay to respect rate limits
        await delay(500);
      }

      results.push({
        gameId,
        roles,
        finalState: state
      });
      
      // Save intermediate to blobs so UI can see progress
      await gamesStore.setJSON(gameId, { gameId, roles, finalState: state });
    }

    // Save batch summary
    await gamesStore.setJSON(`batch-${batchId}-${startIndex}`, { startIndex, count, completed: true });

    return { statusCode: 200, body: 'Batch completed' };
  } catch (error: any) {
    console.error('Background batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
