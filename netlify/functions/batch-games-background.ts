import { Handler } from '@netlify/functions';
import { runFullGame } from '../../src/engine/runner';
import {
  gamesStore,
  getControl,
  resolveBaseUrl,
  setControl,
  triggerOrchestrator,
} from '../../src/engine/batchStore';

// Self-chained background orchestrator. Each invocation processes games one at
// a time (so only a handful of model calls are ever in flight) until either the
// sample is exhausted, the run is paused, or it approaches the background
// runtime ceiling — at which point it hands off to a fresh invocation. This
// chaining is what lets a 300-game run complete without firing dozens of
// concurrent jobs and overwhelming the AI Gateway.
const TIME_BUDGET_MS = 8 * 60 * 1000; // stay well under the 15 min background limit

export const handler: Handler = async (event) => {
  const startedAt = Date.now();

  try {
    const { runId }: { runId?: number } = event.body ? JSON.parse(event.body) : {};
    const store = gamesStore();

    while (true) {
      const control = await getControl();

      // Stop if paused, finished, or superseded by a newer run.
      if (control.status !== 'running') break;
      if (typeof runId === 'number' && control.runId !== runId) break;
      if (control.nextIndex >= control.total) {
        await setControl({ ...control, status: 'done' });
        break;
      }

      // Claim this index up front so a concurrent chain can't process it too.
      const index = control.nextIndex;
      await setControl({ ...control, nextIndex: index + 1 });

      try {
        const result = await runFullGame(index);
        await store.setJSON(result.gameId, result);
      } catch (error: any) {
        // runFullGame falls back per-faction and should not throw, but never
        // let one bad game halt the whole sample.
        console.error(`Game ${index} failed:`, error);
        const latest = await getControl();
        await setControl({ ...latest, lastError: `Game ${index}: ${error.message}` });
      }

      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    }

    // Hand off to a fresh invocation if there is more work and we are still the
    // active run.
    const control = await getControl();
    if (control.status === 'running' && control.nextIndex < control.total) {
      if (typeof runId !== 'number' || control.runId === runId) {
        const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);
        await triggerOrchestrator(baseUrl, control.runId);
      }
    }

    return { statusCode: 200, body: 'Batch chunk processed' };
  } catch (error: any) {
    console.error('Background batch error:', error);
    try {
      const control = await getControl();
      // Surface the failure and stop in a resumable state rather than appearing
      // to run forever with no chain in flight.
      await setControl({ ...control, status: control.status === 'running' ? 'paused' : control.status, lastError: error.message });
    } catch {
      // ignore secondary failure
    }
    return { statusCode: 500, body: error.message };
  }
};
