import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { ActionAllocation, Faction, GameConfig, ModelProvider } from '../../src/engine/types';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';

// Helper to delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// Shared blob key that holds the run state. The dashboard flips this to
// 'stopped' to halt an in-flight run; the background worker checks it before
// starting each game and exits cleanly when asked to stop.
const CONTROL_KEY = 'run-control';

// Role rotation across the 300-game run, in three blocks of 100 so each model
// plays every faction an equal number of times:
//   games   1-100: emperor=openai, foes=gemini, seljuks=claude
//   games 101-200: emperor=gemini, foes=claude, seljuks=openai
//   games 201-300: emperor=claude, foes=openai, seljuks=gemini
function rolesForIndex(gameIndex: number): Record<Faction, ModelProvider> {
  const block = Math.floor((gameIndex - 1) / 100);
  if (block === 1) return { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
  if (block >= 2) return { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
  return { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
}

// Deterministic fallback so a single transient LLM/gateway failure does not
// abort an entire 10-game batch (which would persist nothing). Mirrors the
// resilience the interactive play-round function already has.
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

async function getFactionAction(provider: GameConfig['roles'][Faction], prompt: string, faction: Faction): Promise<ActionAllocation> {
  try {
    return await callLLM(provider, prompt);
  } catch (error) {
    console.error(`Using fallback allocation for ${faction}:`, error);
    return FALLBACK_ALLOCATIONS[faction];
  }
}

export const handler: Handler = async (event) => {
  try {
    const { indices }: { indices: number[] } = JSON.parse(event.body || '{}');

    if (!Array.isArray(indices) || indices.length === 0) {
      return { statusCode: 400, body: 'Missing indices' };
    }

    const gamesStore = getStore('mantzikert-games');

    for (const gameIndex of indices) {
      const gameId = `game-${gameIndex}`;

      // Honor a stop request issued from the dashboard mid-run. We re-read the
      // flag before each game so stopping is responsive without abandoning a
      // game that is already in progress.
      const control = await gamesStore.get(CONTROL_KEY, { type: 'json' }) as { status?: string } | null;
      if (control?.status === 'stopped') {
        return { statusCode: 200, body: 'Run stopped' };
      }

      // Resume safety: never recompute a game that is already persisted, so a
      // resumed run only fills in the games that are actually missing.
      const existing = await gamesStore.get(gameId);
      if (existing) continue;

      const roles = rolesForIndex(gameIndex);

      try {
        let state = createInitialState(gameId);

        for (let round = 1; round <= 12; round++) {
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

        // Save completed game to blobs so the UI tracker and export see it
        await gamesStore.setJSON(gameId, { gameId, roles, finalState: state });
      } catch (gameError: any) {
        // Isolate per-game failures so one bad game does not abort the batch.
        console.error(`Game ${gameId} failed and was skipped:`, gameError?.message || gameError);
      }
    }

    return { statusCode: 200, body: 'Batch completed' };
  } catch (error: any) {
    console.error('Background batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
