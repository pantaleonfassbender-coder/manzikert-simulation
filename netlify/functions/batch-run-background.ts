import { Handler } from '@netlify/functions';
import { runWorkerLoop } from '../../src/engine/batchWorker';

// Background function (the `-background` suffix is what tells Netlify to run it
// with the 15-minute limit instead of the ~10-second synchronous one). It is
// kicked off by the already-authenticated browser when the run starts/resumes,
// and re-kicked whenever the dashboard notices the heartbeat has gone stale.
//
// Because the browser triggers it directly, there is no server-to-server
// self-invocation for the site's password protection to intercept — the reason
// earlier background attempts silently did nothing.
export const handler: Handler = async () => {
  const startedAt = Date.now();
  try {
    await runWorkerLoop(startedAt);
  } catch (error) {
    console.error('batch-run-background error:', error);
  }
  // Background functions return 202 to the caller regardless; this body is only
  // for logs/local invocation.
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
