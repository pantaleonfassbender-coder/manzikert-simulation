import { createHash } from 'node:crypto';
import type { HandlerEvent, HandlerResponse } from '@netlify/functions';

// Single shared site password. The plaintext lives only in the APP_PASSWORD
// environment variable; the browser session holds a SHA-256 derivative, never
// the password itself.
const SESSION_COOKIE = 'mz_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

function sessionToken(): string | null {
  const password = process.env.APP_PASSWORD;
  if (!password) return null;
  return createHash('sha256').update(password).digest('hex');
}

// Length-safe constant-time string comparison.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isPasswordConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

export function verifyPassword(password: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  return timingSafeEqual(password, expected);
}

export function makeSessionCookie(): string {
  const token = sessionToken() ?? '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function isAuthed(event: HandlerEvent): boolean {
  const token = sessionToken();
  if (!token) return false;

  const cookieHeader = event.headers.cookie || event.headers.Cookie || '';
  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));

  if (!cookie) return false;
  const value = cookie.slice(SESSION_COOKIE.length + 1);
  return timingSafeEqual(value, token);
}

export function unauthorized(): HandlerResponse {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Unauthorized. Please sign in.' }),
  };
}
