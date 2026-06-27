import { Handler, HandlerEvent } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { isAuthed, unauthorized } from '../../src/server/auth';

const TOTAL_GAMES = 300;
const CONTROL_KEY = 'run';
const GAME_KEY = /^game-\d+$/;

type RunStatus = 'idle' | 'running' | 'paused' | 'completed';

interface RunControl {
  status: RunStatus;
  total: number;
  stopRequested: boolean;
  startedAt: string | null;
  updatedAt: string;
}

const json = (data: unknown, statusCode = 200) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

async function countCompleted(): Promise<number> {
  const games = getStore('mantzikert-games');
  const { blobs } = await games.list();
  return blobs.filter((b) => GAME_KEY.test(b.key)).length;
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (!isAuthed(event)) return unauthorized();

  const control = getStore('mantzikert-control');
  const now = new Date().toISOString();
  const current = (await control.get(CONTROL_KEY, { type: 'json' })) as RunControl | null;

  const action =
    event.httpMethod === 'GET' ? 'status' : (JSON.parse(event.body || '{}').action as string) || 'status';

  if (action === 'status') {
    const completed = await countCompleted();
    let status: RunStatus = current?.status ?? 'idle';
    if (completed >= TOTAL_GAMES) status = 'completed';
    return json({
      status,
      total: TOTAL_GAMES,
      completed,
      stopRequested: current?.stopRequested ?? false,
    });
  }

  if (action === 'stop') {
    const updated: RunControl = {
      status: 'paused',
      total: TOTAL_GAMES,
      stopRequested: true,
      startedAt: current?.startedAt ?? now,
      updatedAt: now,
    };
    await control.setJSON(CONTROL_KEY, updated);
    return json({ ok: true, status: 'paused' });
  }

  if (action === 'start' || action === 'resume') {
    // A fresh start wipes prior results so the run is a clean, self-contained 300.
    // Resume keeps completed games and only re-opens the run for the remaining ones.
    if (action === 'start') {
      const games = getStore('mantzikert-games');
      const { blobs } = await games.list();
      await Promise.all(blobs.map((b) => games.delete(b.key)));
    }

    const updated: RunControl = {
      status: 'running',
      total: TOTAL_GAMES,
      stopRequested: false,
      startedAt: action === 'start' ? now : current?.startedAt ?? now,
      updatedAt: now,
    };
    await control.setJSON(CONTROL_KEY, updated);
    return json({ ok: true, status: 'running', total: TOTAL_GAMES });
  }

  return { statusCode: 400, body: 'Unknown action' };
};
