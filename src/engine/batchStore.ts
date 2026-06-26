import { getStore } from '@netlify/blobs';
import { TOTAL_GAMES } from './runner';
import type { GameState } from './types';

export const GAMES_STORE = 'mantzikert-games';
export const CONTROL_KEY = 'control';
export const DEFAULT_BLOCK_SIZE = 10;

export type BatchStatus = 'idle' | 'running' | 'paused' | 'done';

export interface BatchControl {
  status: BatchStatus;
  total: number;
  // Index of the game currently being played (0..total). Doubles as the count
  // of fully completed games, since it is only incremented once a game finishes.
  nextIndex: number;
  // Bumped whenever a fresh run is started/resumed so a stale browser driver
  // loop can detect it has been superseded and stop.
  runId: number;
  blockSize: number;
  updatedAt: number;
  lastError: string | null;
  // The in-progress game's state, persisted between round advances so a run can
  // be paused, resumed, or recovered after a reload without losing its place.
  // Null while between games.
  currentGame: GameState | null;
}

export function defaultControl(): BatchControl {
  return {
    status: 'idle',
    total: TOTAL_GAMES,
    nextIndex: 0,
    runId: 0,
    blockSize: DEFAULT_BLOCK_SIZE,
    updatedAt: Date.now(),
    lastError: null,
    currentGame: null,
  };
}

export function gamesStore() {
  // In production (and properly linked dev) Netlify injects an ambient blobs
  // context, so the zero-arg form just works. When that context is absent but
  // the standard site id + auth token are available, configure the store
  // explicitly so the same code path works locally and in scripts.
  if (!process.env.NETLIFY_BLOBS_CONTEXT) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) {
      return getStore({ name: GAMES_STORE, siteID, token });
    }
  }
  return getStore(GAMES_STORE);
}

export async function getControl(): Promise<BatchControl> {
  const store = gamesStore();
  const existing = (await store.get(CONTROL_KEY, { type: 'json' })) as BatchControl | null;
  // Merge over defaults so records written by older versions (without the
  // currentGame field) still load with every property present.
  return existing ? { ...defaultControl(), ...existing } : defaultControl();
}

export async function setControl(control: BatchControl): Promise<BatchControl> {
  const store = gamesStore();
  const next = { ...control, updatedAt: Date.now() };
  await store.setJSON(CONTROL_KEY, next);
  return next;
}
