import type { ActionAllocation, Faction, GameState, ModelProvider } from './types';
import { createInitialState, resolveRound } from './engine';
import { generatePrompt } from './prompts';
import { callLLM } from './llmClients';

export const TOTAL_GAMES = 300;
export const ROUNDS_PER_GAME = 12;

// Conservative fallback allocations used when a faction's model cannot be
// reached even after retries. Keeping a fallback means a single unreachable
// provider degrades one faction's turn instead of aborting the whole game.
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

// Each provider plays each faction once across the 300-game sample. Games are
// split into three blocks of 100 so the model/faction pairings rotate evenly.
export function rolesForIndex(index: number): Record<Faction, ModelProvider> {
  if (index < 100) {
    return { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
  }
  if (index < 200) {
    return { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
  }
  return { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
}

export async function getFactionAction(
  provider: ModelProvider,
  prompt: string,
  faction: Faction,
): Promise<ActionAllocation> {
  try {
    return await callLLM(provider, prompt);
  } catch (error) {
    console.error(`Using fallback allocation for ${faction} (${provider}):`, error);
    return FALLBACK_ALLOCATIONS[faction];
  }
}

// Plays a single round of the supplied state by querying all three factions
// concurrently (at most three in-flight calls) and resolving the outcome.
export async function playOneRound(state: GameState, roles: Record<Faction, ModelProvider>): Promise<GameState> {
  const previousRound = state.history.length > 0 ? state.history[state.history.length - 1] : null;

  const emperorPrompt = generatePrompt('emperor', state, previousRound?.allocations.emperor);
  const foesPrompt = generatePrompt('foes', state, previousRound?.allocations.foes);
  const seljuksPrompt = generatePrompt('seljuks', state, previousRound?.allocations.seljuks);

  const [emperor, foes, seljuks] = await Promise.all([
    getFactionAction(roles.emperor, emperorPrompt, 'emperor'),
    getFactionAction(roles.foes, foesPrompt, 'foes'),
    getFactionAction(roles.seljuks, seljuksPrompt, 'seljuks'),
  ]);

  return resolveRound(state, { emperor, foes, seljuks });
}

export interface GameResult {
  gameId: string;
  roles: Record<Faction, ModelProvider>;
  finalState: GameState;
}

// Runs a complete 12-round game from scratch. Rounds are sequential so only a
// handful of model calls are ever in flight at once, which is what keeps large
// sampling runs from overwhelming the gateway.
export async function runFullGame(gameIndex: number, gameId?: string): Promise<GameResult> {
  const id = gameId ?? `game-${gameIndex}`;
  const roles = rolesForIndex(gameIndex);
  let state = createInitialState(id);

  while (state.currentRound <= ROUNDS_PER_GAME && !state.winner) {
    state = await playOneRound(state, roles);
  }

  return { gameId: id, roles, finalState: state };
}
