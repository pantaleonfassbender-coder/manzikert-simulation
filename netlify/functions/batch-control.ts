import { Handler } from '@netlify/functions';
import {
  BatchControl,
  defaultControl,
  getControl,
  resolveBaseUrl,
  setControl,
  triggerOrchestrator,
} from '../../src/engine/batchStore';

// Generates a fresh, monotonically increasing run id so any background chain
// started by a previous run can detect it has been superseded.
function newRunId(previous: number): number {
  return Math.max(previous + 1, Date.now());
}

export const handler: Handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};
    const action: string = body.action || params.action || 'status';

    const control = await getControl();
    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);

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
        await triggerOrchestrator(baseUrl, next.runId);
        break;
      }

      case 'resume': {
        if (control.nextIndex >= control.total) {
          next = await setControl({ ...control, status: 'done' });
          break;
        }
        // New run id retires any lingering chain before starting a fresh one.
        next = await setControl({
          ...control,
          status: 'running',
          lastError: null,
          runId: newRunId(control.runId),
        });
        await triggerOrchestrator(baseUrl, next.runId);
        break;
      }

      case 'pause': {
        next = await setControl({ ...control, status: 'paused' });
        break;
      }

      case 'reset': {
        // Bumping the run id stops any active chain; counters return to zero so
        // a later Start re-runs the whole sample.
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
