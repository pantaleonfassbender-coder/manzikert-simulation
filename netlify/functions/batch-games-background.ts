import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Faction, ModelProvider } from '../../src/engine/types';
import { createInitialState, resolveRound } from '../../src/engine/engine';
import { generatePrompt } from '../../src/engine/prompts';
import { getFactionAction } from '../../src/engine/fallbacks';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// The background run is fully independent of the in-browser spectator demo.
// It plays game-0 .. game-(TOTAL_GAMES-1) and stores each one in Blobs.
const TOTAL_GAMES = 300;
const DEFAULT_CHUNK = 10;

// Key holding the user-controlled pause flag. When paused, the chain stops
// after the current batch finishes instead of queueing the next one.
const CONTROL_KEY = 'run-control';

async function isPaused(): Promise<boolean> {
  try {
    const store = getStore({ name: 'mantzikert-games', consistency: 'strong' });
    const control = (await store.get(CONTROL_KEY, { type: 'json' })) as { paused?: boolean } | null;
    return !!control?.paused;
  } catch {
    // If the flag can't be read, default to continuing the run.
    return false;
  }
}

// Model roles rotate every 100 games so each provider plays every faction once
// across the run. Roles are derived purely from the absolute game index, so the
// rotation is identical no matter how the run is split into batches.
function rolesForGame(gameIndex: number): Record<Faction, ModelProvider> {
  if (gameIndex < 100) return { emperor: 'openai', foes: 'gemini', seljuks: 'claude' };
  if (gameIndex < 200) return { emperor: 'gemini', foes: 'claude', seljuks: 'openai' };
  return { emperor: 'claude', foes: 'openai', seljuks: 'gemini' };
}

// Resolve the URL this function can use to queue the next consecutive batch.
function selfInvokeUrl(event: Parameters<Handler>[0]): string | null {
  const base =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL ||
    (event.headers?.host ? `https://${event.headers.host}` : '');
  return base ? `${base}/.netlify/functions/batch-games-background` : null;
}

async function playFullGame(gameIndex: number) {
  const gameId = `game-${gameIndex}`;
  const roles = rolesForGame(gameIndex);
  let state = createInitialState(gameId);

  for (let round = 1; round <= 12; round++) {
    const previousRound = state.history.length > 0 ? state.history[state.history.length - 1] : null;

    const emperorPrompt = generatePrompt('emperor', state, previousRound?.allocations.emperor);
    const foesPrompt = generatePrompt('foes', state, previousRound?.allocations.foes);
    const seljuksPrompt = generatePrompt('seljuks', state, previousRound?.allocations.seljuks);

    // Fall back to a safe allocation per faction so one failed call never aborts the game.
    const [emperorAction, foesAction, seljuksAction] = await Promise.all([
      getFactionAction(roles.emperor, emperorPrompt, 'emperor'),
      getFactionAction(roles.foes, foesPrompt, 'foes'),
      getFactionAction(roles.seljuks, seljuksPrompt, 'seljuks'),
    ]);

    state = resolveRound(state, { emperor: emperorAction, foes: foesAction, seljuks: seljuksAction });

    // Small delay to respect rate limits
    await delay(500);
  }

  return { gameId, roles, finalState: state };
}

export const handler: Handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const startIndex: number = Number.isInteger(body.startIndex) && body.startIndex >= 0 ? body.startIndex : 0;
    const chunkSize: number = Number.isInteger(body.chunkSize) && body.chunkSize > 0 ? body.chunkSize : DEFAULT_CHUNK;
    const total: number = Number.isInteger(body.total) && body.total > 0 ? body.total : TOTAL_GAMES;

    const gamesStore = getStore('mantzikert-games');
    const end = Math.min(startIndex + chunkSize, total);

    for (let gameIndex = startIndex; gameIndex < end; gameIndex++) {
      const gameId = `game-${gameIndex}`;

      // Resume-safe: skip any game already stored so a restarted or re-fired
      // chain fast-forwards through completed work instead of redoing it.
      const existing = await gamesStore.get(gameId);
      if (existing) continue;

      const result = await playFullGame(gameIndex);
      await gamesStore.setJSON(gameId, result);
    }

    // Chain the next consecutive batch once this chunk's games are stored —
    // unless the user has asked to pause, in which case the run stops cleanly
    // at this batch boundary and can be resumed later from where it left off.
    if (end < total) {
      if (await isPaused()) {
        return { statusCode: 200, body: `Paused after games ${startIndex}..${end - 1} of ${total}` };
      }
      const url = selfInvokeUrl(event);
      if (url) {
        // The self-invoke goes back through the public URL, so it passes through
        // the site-wide Basic Auth edge gate. When SITE_PASSWORD is set, attach
        // the same credential so the chain isn't rejected and the run can
        // continue across batches.
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const sitePassword = process.env.SITE_PASSWORD;
        if (sitePassword) {
          headers['Authorization'] = `Basic ${Buffer.from(`:${sitePassword}`).toString('base64')}`;
        }
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ startIndex: end, chunkSize, total }),
        }).catch((e) => console.error('Failed to chain next batch:', e));
      } else {
        console.error('Could not resolve self-invoke URL; chain stopped at index', end);
      }
    }

    return { statusCode: 200, body: `Completed games ${startIndex}..${end - 1} of ${total}` };
  } catch (error: any) {
    console.error('Background batch error:', error);
    return { statusCode: 500, body: error.message };
  }
};
