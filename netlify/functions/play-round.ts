import { Handler } from '@netlify/functions';
import { GameState, GameConfig, ActionAllocation, Faction } from '../../src/engine/types';
import { resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';

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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { state, config }: { state: GameState, config: GameConfig } = JSON.parse(event.body || '{}');

    if (!state || !config) {
      return { statusCode: 400, body: 'Missing state or config' };
    }

    const previousRound = state.history.length > 0 ? state.history[state.history.length - 1] : null;

    // Generate Prompts
    const emperorPrompt = generatePrompt('emperor', state, previousRound?.allocations.emperor);
    const foesPrompt = generatePrompt('foes', state, previousRound?.allocations.foes);
    const seljuksPrompt = generatePrompt('seljuks', state, previousRound?.allocations.seljuks);

    // Call LLMs concurrently (inference proxied through Netlify AI Gateway)
    const [emperorAction, foesAction, seljuksAction] = await Promise.all([
      getFactionAction(config.roles.emperor, emperorPrompt, 'emperor'),
      getFactionAction(config.roles.foes, foesPrompt, 'foes'),
      getFactionAction(config.roles.seljuks, seljuksPrompt, 'seljuks')
    ]);

    const allocations: Record<Faction, ActionAllocation> = {
      emperor: emperorAction,
      foes: foesAction,
      seljuks: seljuksAction
    };

    // Resolve Round
    const nextState = resolveRound(state, allocations);

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
