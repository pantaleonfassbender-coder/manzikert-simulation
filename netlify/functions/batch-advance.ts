import { Handler } from '@netlify/functions';
import { createInitialState } from '../../src/engine/engine';
import { playOneRound, rolesForIndex, ROUNDS_PER_GAME } from '../../src/engine/runner';
import { gamesStore, getControl, setControl } from '../../src/engine/batchStore';

// Advances the 300-game sampling run by a single round of the current game.
//
// The run is driven by the (already authenticated) browser, which calls this
// endpoint repeatedly while the run is "running". Doing one round per call keeps
// each invocation well under the synchronous function time limit, and persisting
// progress to Blobs after every round means a run can be paused, resumed, or
// recovered after a reload without losing its place. This avoids any
// server-to-server self-invocation, which the site's password protection would
// otherwise intercept.
export const handler: Handler = async (event) => {
  try {
    const { runId }: { runId?: number } = event.body ? JSON.parse(event.body) : {};

    const control = await getControl();

    // Only the active run drives forward. A mismatched runId means this driver
    // has been superseded (e.g. by a Reset or a newer Start).
    if (control.status !== 'running') {
      return json({ control });
    }
    if (typeof runId === 'number' && control.runId !== runId) {
      return json({ control, superseded: true });
    }

    // Nothing left to do.
    if (control.nextIndex >= control.total && !control.currentGame) {
      const done = await setControl({ ...control, status: 'done', currentGame: null });
      return json({ control: done });
    }

    const index = control.nextIndex;
    const roles = rolesForIndex(index);

    // Start a new game if none is in progress.
    let state = control.currentGame ?? createInitialState(`game-${index}`);

    // Play exactly one round.
    state = await playOneRound(state, roles);

    const finished = state.currentRound > ROUNDS_PER_GAME || !!state.winner;

    let next = { ...control, lastError: null as string | null };
    if (finished) {
      // Persist the completed game and advance to the next index.
      const store = gamesStore();
      await store.setJSON(`game-${index}`, { gameId: `game-${index}`, roles, finalState: state });
      next.nextIndex = index + 1;
      next.currentGame = null;
      if (next.nextIndex >= next.total) {
        next.status = 'done';
      }
    } else {
      // Save the partially played game so the next call resumes from here.
      next.currentGame = state;
    }

    const saved = await setControl(next);
    return json({ control: saved });
  } catch (error: any) {
    console.error('batch-advance error:', error);
    // Surface the error but stay in a resumable state; the browser driver will
    // back off and retry, replaying the round from the last saved game state.
    try {
      const control = await getControl();
      await setControl({ ...control, lastError: error.message });
    } catch {
      // ignore secondary failure
    }
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

function json(body: unknown) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
