import { Handler } from '@netlify/functions';
import { DEFAULT_BATCH_ID, TOTAL_BACKGROUND_GAMES } from './simulation-store';

const MAX_PARALLEL_LAUNCHES = 10;

function getFunctionBaseUrl(event: Parameters<Handler>[0]) {
  const url = new URL(event.rawUrl);
  return `${url.origin}/.netlify/functions`;
}

async function launchGame(baseUrl: string, startIndex: number) {
  const response = await fetch(`${baseUrl}/batch-games-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batchId: DEFAULT_BATCH_ID,
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

  try {
    const baseUrl = getFunctionBaseUrl(event);
    const resetResponse = await fetch(`${baseUrl}/batch-status`, { method: 'POST' });

    if (!resetResponse.ok) {
      const message = await resetResponse.text();
      throw new Error(`Batch reset failed with status ${resetResponse.status}: ${message}`);
    }

    const launchErrors: string[] = [];
    const gameIndexes = Array.from({ length: TOTAL_BACKGROUND_GAMES }, (_, index) => index + 1);

    for (let i = 0; i < gameIndexes.length; i += MAX_PARALLEL_LAUNCHES) {
      const chunk = gameIndexes.slice(i, i + MAX_PARALLEL_LAUNCHES);
      const results = await Promise.allSettled(chunk.map((startIndex) => launchGame(baseUrl, startIndex)));

      results.forEach((result) => {
        if (result.status === 'rejected') {
          launchErrors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      });
    }

    const status = await resetResponse.json();

    if (launchErrors.length > 0) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...status,
          message: `Started with ${launchErrors.length} launch errors. Try again if progress stalls.`,
        }),
      };
    }

    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...status,
        message: `Started ${TOTAL_BACKGROUND_GAMES} background games.`,
      }),
    };
  } catch (error: any) {
    console.error('Start batch error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Failed to start background simulation' }),
    };
  }
};
