import { Handler } from '@netlify/functions';
import { ActionAllocation, Faction, ModelProvider } from '../../src/engine/types';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';
import {
  connectSimulationStore,
  countCompletedGames,
  getGamesStore,
  isBatchCancelled,
  readStatus,
  writeStatus,
} from './simulation-store';

// Helper to delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const FALLBACK_ALLOCATIONS: Record<Faction, ActionAllocation> = {
  emperor: {
    military: 45,
    diplomacy: 15,
    internal: 40,
    messages: {
      foes: 'Stand down and preserve the empire.',
      seljuks: 'The frontier remains defended.',
    },
    selfAssessment: 'The emperor balances frontier defense with urgent internal stabilization.',
  },
  foes: {
    military: 35,
    diplomacy: 20,
    internal: 45,
    messages: {
      seljuks: 'Pressure the frontier while imperial loyalty weakens.',
    },
    selfAssessment: 'The internal opposition prioritizes court destabilization while supporting military sabotage.',
  },
  seljuks: {
    military: 60,
    diplomacy: 20,
    internal: 20,
    messages: {
      foes: 'Internal discord creates the opening for a frontier push.',
    },
    selfAssessment: 'The Seljuks press their military advantage while keeping enough diplomacy to exploit Byzantine divisions.',
  },
};

async function getFactionAction(provider: ModelProvider, prompt: string, faction: Faction): Promise<ActionAllocation> {
  try {
    return await callLLM(provider, prompt);
  } catch (error) {
    console.error(`Using fallback allocation for ${faction} in background batch:`, error);
    return FALLBACK_ALLOCATIONS[faction];
  }
}

export const handler: Handler = async (event) => {
  connectSimulationStore(event);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { batchId, startIndex, count }: { batchId: string, startIndex: number, count: number } = JSON.parse(event.body || '{}');

    if (!batchId) {
      return { statusCode: 400, body: 'Missing batchId' };
    }

    if (!Number.isInteger(startIndex) || startIndex < 1 || !Number.isInteger(count) || count < 1) {
      return { statusCode: 400, body: 'Invalid startIndex or count' };
    }

    const gamesStore = getGamesStore();

    for (let i = 0; i < count; i++) {
      if (await isBatchCancelled(batchId)) {
        await writeStatus({
          ...await readStatus(batchId),
          status: 'cancelled',
          message: 'Simulation series cancelled.',
        });
        return { statusCode: 200, body: 'Batch cancelled' };
      }

      const gameIndex = startIndex + i;
      const gameId = `game-${gameIndex}`;
      
      // Determine roles based on index (1-100, 101-200, 201-300)
      // Since it's 0-indexed:
      // 0-99: openai, gemini, claude
      // 100-199: gemini, claude, openai
      // 200-299: claude, openai, gemini
      let roles: Record<Faction, ModelProvider> = { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
      if (gameIndex >= 100 && gameIndex < 200) {
        roles = { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
      } else if (gameIndex >= 200) {
        roles = { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
      }

      let state = createInitialState(gameId);

      for (let round = 1; round <= 12; round++) {
        if (await isBatchCancelled(batchId)) {
          await writeStatus({
            ...await readStatus(batchId),
            status: 'cancelled',
            message: `Simulation series cancelled during ${gameId}.`,
          });
          return { statusCode: 200, body: 'Batch cancelled' };
        }

        const previousRound = state.history.length > 0 ? state.history[state.history.length - 1] : null;

        const emperorPrompt = generatePrompt('emperor', state, previousRound?.allocations.emperor);
        const foesPrompt = generatePrompt('foes', state, previousRound?.allocations.foes);
        const seljuksPrompt = generatePrompt('seljuks', state, previousRound?.allocations.seljuks);

        const [emperorAction, foesAction, seljuksAction] = await Promise.all([
          getFactionAction(roles.emperor, emperorPrompt, 'emperor'),
          getFactionAction(roles.foes, foesPrompt, 'foes'),
          getFactionAction(roles.seljuks, seljuksPrompt, 'seljuks')
        ]);

        state = resolveRound(state, {
          emperor: emperorAction,
          foes: foesAction,
          seljuks: seljuksAction
        });

        // Small delay to respect rate limits
        await delay(500);
      }

      // Save intermediate to blobs so UI can see progress
      await gamesStore.setJSON(gameId, { gameId, roles, finalState: state });
      const currentStatus = await readStatus(batchId);
      const completedGames = await countCompletedGames();
      await writeStatus({
        ...currentStatus,
        completedGames,
        status: completedGames >= currentStatus.totalGames ? 'completed' : currentStatus.status,
        message: completedGames >= currentStatus.totalGames ? 'Simulation series completed.' : `Completed ${completedGames} of ${currentStatus.totalGames} games.`,
      });
    }

    // Save batch summary
    await gamesStore.setJSON(`batch-${batchId}-${startIndex}`, { startIndex, count, completed: true });

    return { statusCode: 200, body: 'Batch completed' };
  } catch (error: any) {
    console.error('Background batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
