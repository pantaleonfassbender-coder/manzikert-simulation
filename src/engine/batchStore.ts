import { getStore } from '@netlify/blobs';
import { TOTAL_GAMES } from './runner';

export const GAMES_STORE = 'mantzikert-games';
export const CONTROL_KEY = 'control';
export const DEFAULT_BLOCK_SIZE = 10;

export type BatchStatus = 'idle' | 'running' | 'paused' | 'done';

export interface BatchControl {
  status: BatchStatus;
  total: number;
  // Index of the next game to dispatch (0..total). Doubles as progress.
  nextIndex: number;
  // Bumped whenever a fresh run is started/resumed so stale self-chained
  // invocations can detect they have been superseded and stop.
  runId: number;
  blockSize: number;
  updatedAt: number;
  lastError: string | null;
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
  return existing ?? defaultControl();
}

export async function setControl(control: BatchControl): Promise<BatchControl> {
  const store = gamesStore();
  const next = { ...control, updatedAt: Date.now() };
  await store.setJSON(CONTROL_KEY, next);
  return next;
}

// Resolves the deployed base URL so a function can invoke a sibling function
// (e.g. self-chaining the background orchestrator). The inbound request host is
// preferred so self-invocation always targets the exact same deploy; the
// platform env vars are a fallback (e.g. when host is unavailable).
export function resolveBaseUrl(headers: Record<string, string | undefined>): string {
  const host = headers['host'] || headers['x-forwarded-host'];
  if (host) {
    const proto = headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  return process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888';
}

export async function triggerOrchestrator(baseUrl: string, runId: number): Promise<void> {
  try {
    await fetch(`${baseUrl}/.netlify/functions/batch-games-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
  } catch (error) {
    console.error('Failed to trigger background orchestrator:', error);
  }
}
