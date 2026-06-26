import { createInitialState } from './engine';
import { playOneRound, rolesForIndex, ROUNDS_PER_GAME } from './runner';
import { gamesStore, getControl, setControl } from './batchStore';
import type { BatchControl } from './batchStore';

// Stop comfortably before Netlify's 15-minute background-function ceiling so the
// worker always exits cleanly and persists its place; the dashboard re-triggers
// a fresh worker to carry on from there.
const TIME_BUDGET_MS = 13 * 60 * 1000;

// If the control record's heartbeat is newer than this, assume another worker is
// already running the sample and bow out, so two browser tabs (or an eager
// re-trigger) don't double-process the same game.
const WORKER_ALIVE_MS = 25 * 1000;

// Plays the 300-game sample forward, one round at a time, persisting after every
// single round. This is the heart of the run and it lives in a *background*
// function (15-minute limit) rather than a synchronous one: a single round makes
// three model calls and takes ~10s, which is at or beyond the synchronous
// function limit, so driving the run through normal request/response functions
// caused every advance to time out and the run to stall at zero. A background
// worker has the headroom to make real progress.
//
// The loop honours pause/reset/supersede by re-reading the control record each
// round, and updates a heartbeat so the browser can tell it is alive. It returns
// (rather than looping forever) when the run is no longer active, every game is
// finished, or the time budget is reached — in the last case the dashboard spots
// the stale heartbeat and starts a fresh worker to continue.
export async function runWorkerLoop(startedAt: number): Promise<void> {
  let control = await getControl();
  if (control.status !== 'running') return;

  // Another worker advanced the run very recently: let it keep ownership.
  if (control.heartbeat && Date.now() - control.heartbeat < WORKER_ALIVE_MS) return;

  const runId = control.runId;
  await setControl({ ...control, heartbeat: Date.now() });

  const store = gamesStore();

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    // Re-read so a Pause, Reset, or newer run started elsewhere stops this loop.
    control = await getControl();
    if (control.status !== 'running' || control.runId !== runId) return;

    // Everything played: mark the run done and stop.
    if (control.nextIndex >= control.total && !control.currentGame) {
      await setControl({ ...control, status: 'done', currentGame: null, heartbeat: Date.now() });
      return;
    }

    const index = control.nextIndex;
    const roles = rolesForIndex(index);
    let state = control.currentGame ?? createInitialState(`game-${index}`);

    try {
      // playOneRound runs the three factions concurrently and already falls back
      // to a safe move if a provider stays unreachable, so a round resolves even
      // under transient gateway pressure.
      state = await playOneRound(state, roles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setControl({ ...control, lastError: message, heartbeat: Date.now() });
      continue; // the round was not saved, so the next pass simply replays it
    }

    const finished = state.currentRound > ROUNDS_PER_GAME || !!state.winner;
    const next: BatchControl = { ...control, lastError: null, heartbeat: Date.now() };

    if (finished) {
      // Persist the completed game, then advance to the next index.
      await store.setJSON(`game-${index}`, { gameId: `game-${index}`, roles, finalState: state });
      next.nextIndex = index + 1;
      next.currentGame = null;
      if (next.nextIndex >= next.total) next.status = 'done';
    } else {
      // Save the partially played game so the next round resumes from here.
      next.currentGame = state;
    }

    await setControl(next);
  }
}
