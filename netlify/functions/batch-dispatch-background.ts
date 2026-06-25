import { Handler } from '@netlify/functions';
import { DEFAULT_BATCH_ID, TOTAL_BACKGROUND_GAMES, isBatchCancelled, readStatus, writeStatus } from './simulation-store';

const GAMES_PER_WORKER = 3;
const MAX_PARALLEL_LAUNCHES = 3;
const LAUNCH_PAUSE_MS = 750;

type HandlerEvent = Parameters<Handler>[0];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type LaunchJob = {
  startIndex: number;
  count: number;
};

function getHeader(event: HandlerEvent, name: string) {
  const lowerName = name.toLowerCase();
  return Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === lowerName)?.[1];
}

function normalizeOrigin(value: string | undefined) {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getFunctionBaseUrl(event: HandlerEvent) {
  const requestOrigin = normalizeOrigin(event.rawUrl);
  if (requestOrigin) {
    return `${requestOrigin}/.netlify/functions`;
  }

  const deployOrigin = normalizeOrigin(process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || process.env.URL);
  if (deployOrigin) {
    return `${deployOrigin}/.netlify/functions`;
  }

  const host = getHeader(event, 'x-forwarded-host') || getHeader(event, 'host');
  if (host) {
    const protocol = getHeader(event, 'x-forwarded-proto') || 'https';
    return `${protocol}://${host}/.netlify/functions`;
  }

  throw new Error('Could not determine the Netlify Functions URL for background dispatch.');
}

async function launchGame(baseUrl: string, batchId: string, job: LaunchJob) {
  const response = await fetch(`${baseUrl}/batch-games-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batchId,
      startIndex: job.startIndex,
      count: job.count,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to launch game-${job.startIndex}: ${response.status} ${message}`);
  }
}

function getLaunchJobs(totalGames: number) {
  const jobs: LaunchJob[] = [];

  for (let startIndex = 1; startIndex <= totalGames; startIndex += GAMES_PER_WORKER) {
    jobs.push({
      startIndex,
      count: Math.min(GAMES_PER_WORKER, totalGames - startIndex + 1),
    });
  }

  return jobs;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const batchId = DEFAULT_BATCH_ID;

  try {
    const body = JSON.parse(event.body || '{}') as { batchId?: string; totalGames?: number };
    const requestedBatchId = body.batchId || batchId;
    const totalGames = Number.isInteger(body.totalGames) && body.totalGames > 0 ? body.totalGames : TOTAL_BACKGROUND_GAMES;
    const baseUrl = getFunctionBaseUrl(event);
    const launchErrors: string[] = [];
    const launchJobs = getLaunchJobs(totalGames);

    await writeStatus({
      ...await readStatus(requestedBatchId),
      status: 'running',
      message: `Launching ${totalGames} background games in ${launchJobs.length} worker batches.`,
    });

    for (let i = 0; i < launchJobs.length; i += MAX_PARALLEL_LAUNCHES) {
      if (await isBatchCancelled(requestedBatchId)) {
        await writeStatus({
          ...await readStatus(requestedBatchId),
          status: 'cancelled',
          message: 'Simulation series cancelled before all games were launched.',
        });
        return { statusCode: 200, body: 'Batch dispatch cancelled' };
      }

      const chunk = launchJobs.slice(i, i + MAX_PARALLEL_LAUNCHES);
      const results = await Promise.allSettled(chunk.map((job) => launchGame(baseUrl, requestedBatchId, job)));

      results.forEach((result) => {
        if (result.status === 'rejected') {
          launchErrors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      });

      await writeStatus({
        ...await readStatus(requestedBatchId),
        status: 'running',
        message: `Launched ${Math.min(i + chunk.length, launchJobs.length)} of ${launchJobs.length} worker batches.`,
      });

      await delay(LAUNCH_PAUSE_MS);
    }

    if (launchErrors.length > 0) {
      await writeStatus({
        ...await readStatus(requestedBatchId),
        status: 'running',
        message: `Launched with ${launchErrors.length} dispatch errors. Progress may continue for queued games.`,
      });
    }

    return { statusCode: 200, body: 'Batch dispatch completed' };
  } catch (error: any) {
    console.error('Batch dispatch error:', error);
    await writeStatus({
      ...await readStatus(batchId),
      status: 'failed',
      message: 'Simulation series stopped while dispatching background games.',
    }).catch((statusError) => console.error('Failed to record dispatch error:', statusError));

    return { statusCode: 500, body: error.message || 'Batch dispatch failed' };
  }
};
