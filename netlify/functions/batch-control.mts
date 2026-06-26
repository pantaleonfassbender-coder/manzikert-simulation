import type { Context } from '@netlify/functions';
import {
  BatchControl,
  defaultControl,
  getControl,
  setControl,
} from '../../src/engine/batchStore';

// Generates a fresh, monotonically increasing run id so any browser driver loop
// started by a previous run can detect it has been superseded and stop.
function newRunId(previous: number): number {
  return Math.max(previous + 1, Date.now());
}

// Manages the 300-game run's control record only. The run itself is advanced by
// the batch-run-background function (a 15-minute background worker) that the
// authenticated browser triggers, so there is no server-to-server invocation
// here (which the site's password protection would block).
//
// This is a Netlify Functions v2 handler (default export, `.mts`). v2 is what
// gives the function the ambient Netlify Blobs context with no configuration —
// the previous v1 ("lambda compatibility") handler never received that context,
// so every Blobs read/write threw and the run could never start.
export default async (req: Request, _context: Context): Promise<Response> => {
  try {
    const url = new URL(req.url);
    let body: any = {};
    if (req.method === 'POST') {
      body = await req.json().catch(() => ({}));
    }
    const action: string = body.action || url.searchParams.get('action') || 'status';

    const control = await getControl();
    let next: BatchControl = control;

    switch (action) {
      case 'status':
        break;

      case 'start': {
        // Restart the full sample from the beginning.
        next = await setControl({
          ...defaultControl(),
          status: 'running',
          runId: newRunId(control.runId),
        });
        break;
      }

      case 'resume': {
        if (control.nextIndex >= control.total && !control.currentGame) {
          next = await setControl({ ...control, status: 'done' });
          break;
        }
        // New run id retires any lingering driver before a fresh one takes over.
        // currentGame is preserved so the run continues mid-game.
        next = await setControl({
          ...control,
          status: 'running',
          lastError: null,
          runId: newRunId(control.runId),
        });
        break;
      }

      case 'pause': {
        next = await setControl({ ...control, status: 'paused' });
        break;
      }

      case 'reset': {
        // Bumping the run id stops any active driver; counters and the
        // in-progress game return to zero so a later Start re-runs the sample.
        next = await setControl({
          ...defaultControl(),
          status: 'idle',
          runId: newRunId(control.runId),
        });
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
    }

    return Response.json({ control: next });
  } catch (error: any) {
    console.error('batch-control error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
