import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Faction, ModelProvider } from '../../src/engine/types';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { getFactionAction } from '../../src/engine/fallback';

// Helper to delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export const handler: Handler = async (event) => {
  try {
    const { batchId, startIndex, count }: { batchId: string, startIndex: number, count: number } = JSON.parse(event.body || '{}');

    if (!batchId) {
      return { statusCode: 400, body: 'Missing batchId' };
    }

    const gamesStore = getStore('mantzikert-games');
    let saved = 0;

    for (let i = 0; i < count; i++) {
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

      // Isolate each game: a failure mid-game still persists whatever progress
      // it made, and never prevents the remaining games in the batch from running.
      try {
        for (let round = 1; round <= 12; round++) {
          const previousRound = state.history.length > 0 ? state.history[state.history.length - 1] : null;

          const emperorPrompt = generatePrompt('emperor', state, previousRound?.allocations.emperor);
          const foesPrompt = generatePrompt('foes', state, previousRound?.allocations.foes);
          const seljuksPrompt = generatePrompt('seljuks', state, previousRound?.allocations.seljuks);

          // Resilient calls: a failed provider response falls back instead of
          // throwing, so the game always advances all 12 rounds.
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
      } catch (gameError: any) {
        console.error(`Game ${gameId} failed mid-run, saving partial progress:`, gameError?.message);
      }

      // Save the game (complete or partial) so the UI/export can see it.
      await gamesStore.setJSON(gameId, { gameId, roles, finalState: state });
      saved += 1;

      // Update batch progress after every game, not just at the end, so a
      // later crash never hides the games already finished.
      await gamesStore.setJSON(`batch-${batchId}-${startIndex}`, {
        startIndex,
        count,
        saved,
        completed: saved === count,
      });
    }

    return { statusCode: 200, body: `Batch completed: ${saved}/${count} games saved` };
  } catch (error: any) {
    console.error('Background batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
