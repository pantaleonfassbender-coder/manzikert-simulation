import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { callLLM } from '../../src/engine/llmClients';
import {
  addCompletedGame,
  BATCH_STATUS_KEY,
  createBatchStatus,
  getRolesForSavedGame,
  SAVED_BATCH_SIZE,
  SAVED_GAME_COUNT,
  type BatchStatus,
} from '../../src/engine/batch';

// Helper to delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

async function getStatus(gamesStore: ReturnType<typeof getStore>) {
  return (await gamesStore.get(BATCH_STATUS_KEY, { type: 'json' }).catch(() => null)) as BatchStatus | null;
}

export const handler: Handler = async (event) => {
  try {
    const { startIndex, count }: { startIndex?: number, count?: number } = JSON.parse(event.body || '{}');
    const gamesStore = getStore('mantzikert-games');
    const existingStatus = await getStatus(gamesStore);
    const currentStatus = existingStatus || createBatchStatus({ state: 'running' });
    const effectiveStart = typeof startIndex === 'number' ? startIndex : currentStatus.nextIndex;
    const effectiveCount = Math.min(count || SAVED_BATCH_SIZE, SAVED_BATCH_SIZE, SAVED_GAME_COUNT - effectiveStart);

    if (effectiveStart >= SAVED_GAME_COUNT || effectiveCount <= 0) {
      const completed = createBatchStatus({
        ...currentStatus,
        state: 'completed',
        nextIndex: SAVED_GAME_COUNT,
        completedGames: SAVED_GAME_COUNT,
        activeBatchStart: null,
        activeBatchCount: 0,
        inFlightGames: 0,
        updatedAt: new Date().toISOString(),
      });
      await gamesStore.setJSON(BATCH_STATUS_KEY, completed);
      return { statusCode: 200, body: JSON.stringify(completed) };
    }

    await gamesStore.setJSON(BATCH_STATUS_KEY, {
      ...currentStatus,
      state: 'running',
      activeBatchStart: effectiveStart,
      activeBatchCount: effectiveCount,
      inFlightGames: 0,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });

    for (let i = 0; i < effectiveCount; i++) {
      const latestStatus = await getStatus(gamesStore);
      if (latestStatus?.state === 'paused') {
        return { statusCode: 200, body: JSON.stringify(latestStatus) };
      }

      const gameIndex = effectiveStart + i;
      const gameId = `game-${gameIndex}`;
      const roles = getRolesForSavedGame(gameIndex);

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
      
      await gamesStore.setJSON(gameId, { gameId, roles, finalState: state });

      const statusAfterSave = await getStatus(gamesStore);
      const baseStatus = statusAfterSave || currentStatus;
      const completedGames = Math.max(baseStatus.completedGames, gameIndex + 1);
      await gamesStore.setJSON(BATCH_STATUS_KEY, {
        ...baseStatus,
        completedGames,
        nextIndex: Math.min(gameIndex + 1, SAVED_GAME_COUNT),
        inFlightGames: 0,
        modelProgress: addCompletedGame(baseStatus.modelProgress, roles),
        state: completedGames >= SAVED_GAME_COUNT ? 'completed' : baseStatus.state,
        activeBatchStart: completedGames >= SAVED_GAME_COUNT || baseStatus.state === 'paused' ? null : effectiveStart,
        activeBatchCount: completedGames >= SAVED_GAME_COUNT || baseStatus.state === 'paused' ? 0 : effectiveCount,
        updatedAt: new Date().toISOString(),
      });
    }

    const finalStatus = (await getStatus(gamesStore)) || createBatchStatus();
    const nextState = finalStatus.completedGames >= SAVED_GAME_COUNT ? 'completed' : finalStatus.state;
    const nextStatus = {
      ...finalStatus,
      state: nextState,
      activeBatchStart: null,
      activeBatchCount: 0,
      inFlightGames: 0,
      updatedAt: new Date().toISOString(),
    };
    await gamesStore.setJSON(BATCH_STATUS_KEY, nextStatus);

    return { statusCode: 200, body: JSON.stringify(nextStatus) };
  } catch (error: any) {
    console.error('Background batch error:', error);
    const gamesStore = getStore('mantzikert-games');
    const status = (await getStatus(gamesStore)) || createBatchStatus();
    await gamesStore.setJSON(BATCH_STATUS_KEY, {
      ...status,
      state: 'error',
      activeBatchStart: null,
      activeBatchCount: 0,
      inFlightGames: 0,
      lastError: error.message,
      updatedAt: new Date().toISOString(),
    });
    return { statusCode: 500, body: error.message };
  }
};
