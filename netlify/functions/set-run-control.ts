import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

// The run-control flag lets the user pause the self-chaining background run at
// the next batch boundary, and resume it later. It is read by the background
// function before it queues the next batch. Strong consistency makes a pause
// click take effect on the very next chain check.
const CONTROL_KEY = 'run-control';

export const handler: Handler = async (event) => {
  try {
    const store = getStore({ name: 'mantzikert-games', consistency: 'strong' });

    if (event.httpMethod === 'GET') {
      const control = (await store.get(CONTROL_KEY, { type: 'json' })) as { paused?: boolean } | null;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !!control?.paused }),
      };
    }

    const body = JSON.parse(event.body || '{}');
    const paused = body.paused === true;
    await store.setJSON(CONTROL_KEY, { paused });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused }),
    };
  } catch (error: any) {
    console.error('Run control error:', error);
    return { statusCode: 500, body: error.message };
  }
};
