import type { Context } from '@netlify/functions';
import { runWorkerLoop } from '../../src/engine/batchWorker';

// Background function (the `-background` suffix is what tells Netlify to run it
// with the 15-minute limit instead of the ~10-second synchronous one). It is
// kicked off by the already-authenticated browser when the run starts/resumes,
// and re-kicked whenever the dashboard notices the heartbeat has gone stale.
//
// Because the browser triggers it directly, there is no server-to-server
// self-invocation for the site's password protection to intercept.
//
// Netlify Functions v2 (default export, `.mts`): running as a v2 function is
// what provides the ambient Netlify Blobs context the worker needs to read the
// control record and persist finished games. As a v1 handler it received no
// Blobs context, so the loop threw on its very first read and never ran.
export default async (_req: Request, _context: Context): Promise<void> => {
  const startedAt = Date.now();
  try {
    await runWorkerLoop(startedAt);
  } catch (error) {
    console.error('batch-run-background error:', error);
  }
  // Background functions return 202 to the caller immediately; the return value
  // is ignored.
};
