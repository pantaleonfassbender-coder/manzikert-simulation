import { Handler } from '@netlify/functions';
import { DEFAULT_BATCH_ID, TOTAL_BACKGROUND_GAMES, resetSeries, writeStatus } from './simulation-store';

type HandlerEvent = Parameters<Handler>[0];

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

async function launchDispatcher(baseUrl: string) {
  const response = await fetch(`${baseUrl}/batch-dispatch-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batchId: DEFAULT_BATCH_ID,
      totalGames: TOTAL_BACKGROUND_GAMES,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to queue batch dispatcher: ${response.status} ${message}`);
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const baseUrl = getFunctionBaseUrl(event);
    const status = await resetSeries(DEFAULT_BATCH_ID);
    await launchDispatcher(baseUrl);

    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...status,
        message: `Queued ${TOTAL_BACKGROUND_GAMES} background games.`,
      }),
    };
  } catch (error: any) {
    console.error('Start batch error:', error);
    await writeStatus({
      batchId: DEFAULT_BATCH_ID,
      totalGames: TOTAL_BACKGROUND_GAMES,
      completedGames: 0,
      status: 'failed',
      startedAt: null,
      updatedAt: new Date().toISOString(),
      message: 'Simulation series could not be queued. Try starting it again.',
    }).catch((statusError) => console.error('Failed to record start error:', statusError));

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Failed to start background simulation' }),
    };
  }
};
