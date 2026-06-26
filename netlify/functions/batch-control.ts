import { Handler } from '@netlify/functions';
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
// the authenticated browser calling batch-advance round by round, so there is no
// server-to-server invocation here (which the site's password protection would
// block).
export const handler: Handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};
    const action: string = body.action || params.action || 'status';

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
        return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ control: next }),
    };
  } catch (error: any) {
    console.error('batch-control error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
