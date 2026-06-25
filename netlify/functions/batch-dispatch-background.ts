import { Handler } from '@netlify/functions';
import { DEFAULT_BATCH_ID, TOTAL_BACKGROUND_GAMES, isBatchCancelled, readStatus, writeStatus } from './simulation-store';

const MAX_PARALLEL_LAUNCHES = 10;

function getFunctionBaseUrl(event: Parameters<Handler>[0]) {
  const url = new URL(event.rawUrl);
  return `${url.origin}/.netlify/functions`;
}

async function launchGame(baseUrl: string, batchId: string, startIndex: number) {
  const response = await fetch(`${baseUrl}/batch-games-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batchId,
      startIndex,
      count: 1,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to launch game-${startIndex}: ${response.status} ${message}`);
  }
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
    const gameIndexes = Array.from({ length: totalGames }, (_, index) => index + 1);

    await writeStatus({
      ...await readStatus(requestedBatchId),
      status: 'running',
      message: `Launching ${totalGames} background games.`,
    });

    for (let i = 0; i < gameIndexes.length; i += MAX_PARALLEL_LAUNCHES) {
      if (await isBatchCancelled(requestedBatchId)) {
        await writeStatus({
          ...await readStatus(requestedBatchId),
          status: 'cancelled',
          message: 'Simulation series cancelled before all games were launched.',
        });
        return { statusCode: 200, body: 'Batch dispatch cancelled' };
      }

      const chunk = gameIndexes.slice(i, i + MAX_PARALLEL_LAUNCHES);
      const results = await Promise.allSettled(chunk.map((startIndex) => launchGame(baseUrl, requestedBatchId, startIndex)));

      results.forEach((result) => {
        if (result.status === 'rejected') {
          launchErrors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      });

      await writeStatus({
        ...await readStatus(requestedBatchId),
        status: 'running',
        message: `Launched ${Math.min(i + chunk.length, totalGames)} of ${totalGames} background games.`,
      });
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
