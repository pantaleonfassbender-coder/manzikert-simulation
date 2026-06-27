import { Handler } from '@netlify/functions';
import { isPasswordConfigured, makeSessionCookie, verifyPassword } from '../../src/server/auth';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!isPasswordConfigured()) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'The password gate is not configured. Set the APP_PASSWORD environment variable for this site.',
      }),
    };
  }

  let password = '';
  try {
    ({ password } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: 'Invalid request body' };
  }

  if (typeof password !== 'string' || !verifyPassword(password)) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Incorrect password.' }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': makeSessionCookie(),
    },
    body: JSON.stringify({ ok: true }),
  };
};
